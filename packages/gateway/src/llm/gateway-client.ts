import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pino from 'pino';
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: 'gateway-client' });

// ---------------------------------------------------------------------------
// Gateway Frame Protocol Types
// ---------------------------------------------------------------------------

interface GatewayFrame {
  type: 'req' | 'res' | 'event';
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  event?: string;
  payload?: Record<string, unknown>;
  ok?: boolean;
  error?: { message: string; code?: string };
}

interface ChatCallbacks {
  onDelta?: (text: string, payload: Record<string, unknown>) => void;
  onFinal?: (text: string, payload: Record<string, unknown>) => void;
  /** Optional AbortSignal to cancel local waiting for stream completion. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: Record<string, unknown> | undefined) => void;
  reject: (reason: Error) => void;
}

interface PendingRun {
  runId: string;
  sessionKey: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  buffer: string;
  lastDelta: string;
  onDelta?: (text: string, payload: Record<string, unknown>) => void;
  onFinal?: (text: string, payload: Record<string, unknown>) => void;
  finalSent: boolean;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

interface DeviceKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

interface DeviceAuthPayloadArgs {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce?: string;
}

interface BuildDeviceArgs {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  nonce: string;
  signedAtMs: number;
}

interface DeviceInfo {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

interface ClientInfo {
  id: string;
  displayName: string;
  version: string;
  platform: string;
  mode: string;
}

interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: ClientInfo;
  role: string;
  scopes: string[];
  caps: string[];
  commands: string[];
  permissions: Record<string, unknown>;
  locale: string;
  userAgent: string;
  auth?: { token?: string; password?: string };
  device?: DeviceInfo;
}

interface ChallengePayload {
  nonce?: string;
}

/** Events emitted for connection state monitoring. */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type ConnectionStateListener = (state: ConnectionState) => void;

// ---------------------------------------------------------------------------
// Saved device file formats
// ---------------------------------------------------------------------------

interface SavedDeviceV1 {
  version: 1;
  deviceId: string;
  publicKey: string;   // base64 raw 32-byte public key
  secretKey: string;   // base64 raw 64-byte secret key (tweetnacl format)
  createdAtMs: number;
}

// Legacy format from bridge.js (PEM-based, Node crypto)
interface SavedDeviceLegacyPem {
  publicKeyPem: string;
  privateKeyPem: string;
  deviceId: string;
}

interface SavedDeviceLegacyDer {
  publicKey: string;  // base64 DER
  privateKey: string; // base64 DER
  id?: string;
  deviceId?: string;
}

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env.VOICECHAT_GATEWAY_URL || 'ws://127.0.0.1:18789/gateway';
const GATEWAY_TOKEN = process.env.VOICECHAT_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '';
const GATEWAY_PASSWORD = process.env.VOICECHAT_GATEWAY_PASSWORD || process.env.OPENCLAW_GATEWAY_PASSWORD || '';
const GATEWAY_PROTOCOL = Number(process.env.VOICECHAT_GATEWAY_PROTOCOL || 3);
const GATEWAY_TIMEOUT_MS = Number(process.env.VOICECHAT_GATEWAY_TIMEOUT_MS || 120000);
const GATEWAY_ALLOW_INSECURE = /^(1|true|yes)$/i.test(process.env.VOICECHAT_GATEWAY_ALLOW_INSECURE || '');
const GATEWAY_CLIENT_ID = process.env.VOICECHAT_GATEWAY_CLIENT_ID || 'webchat';
const GATEWAY_CLIENT_NAME = process.env.VOICECHAT_GATEWAY_CLIENT_NAME || 'voice-chat-bridge';
const GATEWAY_CLIENT_MODE = process.env.VOICECHAT_GATEWAY_CLIENT_MODE || '';
const GATEWAY_DEVICE_ID = process.env.VOICECHAT_GATEWAY_DEVICE_ID || '';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG_FILE = process.env.VOICECHAT_OPENCLAW_CONFIG || path.join(OPENCLAW_HOME, 'openclaw.json');
const OPENCLAW_DEVICE_FILE = process.env.VOICECHAT_OPENCLAW_DEVICE_FILE || path.join(OPENCLAW_HOME, 'identity', 'device.json');
const OPENCLAW_DEVICE_AUTH_FILE = process.env.VOICECHAT_OPENCLAW_DEVICE_AUTH_FILE || path.join(OPENCLAW_HOME, 'identity', 'device-auth.json');

const DEFAULT_DEVICE_FILE = fs.existsSync(OPENCLAW_DEVICE_FILE)
  ? OPENCLAW_DEVICE_FILE
  : path.join(process.cwd(), '.voicechat-device.json');
const GATEWAY_DEVICE_FILE = process.env.VOICECHAT_GATEWAY_DEVICE_FILE || DEFAULT_DEVICE_FILE;
const SHOULD_PERSIST_DEVICE = /^(1|true|yes)$/i.test(process.env.VOICECHAT_GATEWAY_DEVICE_WRITE || '') ||
  path.basename(GATEWAY_DEVICE_FILE) === '.voicechat-device.json';

// ---------------------------------------------------------------------------
// Reconnect constants
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function computeDeviceId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

function platformLabel(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform || 'node';
}

function buildDeviceAuthPayload(args: DeviceAuthPayloadArgs): string {
  const version = args.nonce ? 'v2' : 'v1';
  const scopeList = args.scopes.join(',');
  const base = [
    version,
    args.deviceId,
    args.clientId,
    args.clientMode,
    args.role,
    scopeList,
    String(args.signedAtMs),
    args.token || '',
  ];
  if (version === 'v2') base.push(args.nonce || '');
  return base.join('|');
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveGatewayToken(): string {
  if (GATEWAY_TOKEN) return GATEWAY_TOKEN;
  const config = readJsonFile(OPENCLAW_CONFIG_FILE);
  const gateway = config?.['gateway'] as Record<string, unknown> | undefined;
  const auth = gateway?.['auth'] as Record<string, unknown> | undefined;
  const token = auth?.['token'];
  if (typeof token === 'string') return token;
  const deviceAuth = readJsonFile(OPENCLAW_DEVICE_AUTH_FILE);
  const tokens = deviceAuth?.['tokens'] as Record<string, unknown> | undefined;
  const operator = tokens?.['operator'] as Record<string, unknown> | undefined;
  const opToken = operator?.['token'];
  return typeof opToken === 'string' ? opToken : '';
}

// ---------------------------------------------------------------------------
// Text Extraction Helpers (handle OpenClaw's various response formats)
// ---------------------------------------------------------------------------

export function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('');
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'text' && typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['text'] === 'string') return obj['text'];
    if (obj['content'] !== undefined) return extractText(obj['content']);
    if (obj['delta'] !== undefined) return extractText(obj['delta']);
  }
  return '';
}

export function extractTextFromMessage(message: unknown): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return extractText(message);
  if (typeof message === 'object' && message !== null) {
    const obj = message as Record<string, unknown>;
    const role = (obj['role'] ?? obj['authorRole'] ?? (obj['author'] as Record<string, unknown> | undefined)?.['role']) as string | undefined;
    if (role && role !== 'assistant') return '';
    return extractText(obj['content'] ?? obj['text'] ?? obj['delta'] ?? message);
  }
  return '';
}

export function mergeDeltaText(buffer: string, next: string): string {
  if (!next) return buffer || '';
  if (!buffer) return next;
  if (next === buffer) return buffer;
  if (next.startsWith(buffer)) return next;
  if (buffer.startsWith(next)) return buffer;
  if (buffer.includes(next)) return buffer;
  if (next.includes(buffer)) return next;
  const maxOverlap = Math.min(buffer.length, next.length);
  for (let i = maxOverlap; i > 0; i -= 1) {
    if (buffer.slice(-i) === next.slice(0, i)) {
      return buffer + next.slice(i);
    }
  }
  return buffer + next;
}

// ---------------------------------------------------------------------------
// Ed25519 SPKI DER prefix — used to extract raw 32-byte public key from
// Node crypto SPKI-format DER exports (for legacy device file compat)
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function extractRawPublicKeyFromSpkiDer(spkiDer: Buffer): Uint8Array {
  if (
    spkiDer.length === ED25519_SPKI_PREFIX.length + 32 &&
    spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return new Uint8Array(spkiDer.subarray(ED25519_SPKI_PREFIX.length));
  }
  return new Uint8Array(spkiDer);
}

// ---------------------------------------------------------------------------
// GatewayClient
// ---------------------------------------------------------------------------

export class GatewayClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private pendingReqs = new Map<string, PendingRequest>();
  private pendingRuns = new Map<string, PendingRun>();
  private pendingSessions = new Map<string, PendingRun>();
  private deviceKeys: DeviceKeys | null = null;
  private deviceId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private stateListeners: ConnectionStateListener[] = [];

  // -----------------------------------------------------------------------
  // Connection State Events
  // -----------------------------------------------------------------------

  onConnectionState(listener: ConnectionStateListener): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== listener);
    };
  }

  private emitState(state: ConnectionState): void {
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        log.warn({ err }, 'Connection state listener threw');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Device Identity (Ed25519 via tweetnacl)
  // -----------------------------------------------------------------------

  private loadDeviceIdentity(): void {
    if (this.deviceKeys || !GATEWAY_DEVICE_FILE) return;
    try {
      if (!fs.existsSync(GATEWAY_DEVICE_FILE)) return;
      const raw = fs.readFileSync(GATEWAY_DEVICE_FILE, 'utf-8');
      const saved: unknown = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      const obj = saved as Record<string, unknown>;

      // New tweetnacl format (written by this client)
      if (
        typeof obj['publicKey'] === 'string' &&
        typeof obj['secretKey'] === 'string' &&
        typeof obj['deviceId'] === 'string' &&
        obj['version'] === 1
      ) {
        const s = obj as unknown as SavedDeviceV1;
        this.deviceKeys = {
          publicKey: naclUtil.decodeBase64(s.publicKey),
          secretKey: naclUtil.decodeBase64(s.secretKey),
        };
        this.deviceId = s.deviceId;
        return;
      }

      // Legacy PEM format from bridge.js
      if (
        typeof obj['publicKeyPem'] === 'string' &&
        typeof obj['privateKeyPem'] === 'string' &&
        typeof obj['deviceId'] === 'string'
      ) {
        // Cannot import PEM into tweetnacl — generate new keys instead.
        // The old device ID won't match the new keys, so we start fresh.
        log.info('Legacy PEM device file detected; generating new tweetnacl keypair');
        return;
      }

      // Legacy DER format
      if (
        typeof obj['publicKey'] === 'string' &&
        typeof obj['privateKey'] === 'string' &&
        (typeof obj['id'] === 'string' || typeof obj['deviceId'] === 'string')
      ) {
        // Attempt to extract raw public key from DER SPKI encoding
        const legacy = obj as unknown as SavedDeviceLegacyDer;
        try {
          const spkiDer = Buffer.from(legacy.publicKey, 'base64');
          const rawPub = extractRawPublicKeyFromSpkiDer(spkiDer);
          if (rawPub.length === 32) {
            // We have the raw public key but the private key is in PKCS8 DER format.
            // tweetnacl needs the 64-byte secret key (seed || public). We can't
            // reliably extract the seed from PKCS8 in all cases, so regenerate.
            log.info('Legacy DER device file detected; generating new tweetnacl keypair');
          }
        } catch {
          // Ignore parse errors
        }
        return;
      }
    } catch {
      // Ignore file read/parse errors
    }
  }

  private saveDeviceIdentity(): void {
    if (!SHOULD_PERSIST_DEVICE || !GATEWAY_DEVICE_FILE || !this.deviceKeys || !this.deviceId) return;
    try {
      const dir = path.dirname(GATEWAY_DEVICE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload: SavedDeviceV1 = {
        version: 1,
        deviceId: this.deviceId,
        publicKey: naclUtil.encodeBase64(this.deviceKeys.publicKey),
        secretKey: naclUtil.encodeBase64(this.deviceKeys.secretKey),
        createdAtMs: Date.now(),
      };
      fs.writeFileSync(GATEWAY_DEVICE_FILE, JSON.stringify(payload, null, 2));
    } catch (err) {
      log.warn({ err }, 'Failed to save device identity');
    }
  }

  private buildDevice(args: BuildDeviceArgs): DeviceInfo | null {
    if (GATEWAY_ALLOW_INSECURE) return null;
    this.loadDeviceIdentity();

    if (!this.deviceKeys) {
      const keypair = nacl.sign.keyPair();
      this.deviceKeys = {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      };
    }

    if (!this.deviceId) {
      this.deviceId = GATEWAY_DEVICE_ID || computeDeviceId(this.deviceKeys.publicKey);
    }

    const signedAt = args.signedAtMs;
    const deviceNonce = args.nonce || '';
    const payload = buildDeviceAuthPayload({
      deviceId: this.deviceId,
      clientId: args.clientId,
      clientMode: args.clientMode,
      role: args.role,
      scopes: args.scopes,
      signedAtMs: signedAt,
      token: args.token,
      nonce: deviceNonce || undefined,
    });

    let signature = '';
    try {
      const msgBytes = naclUtil.decodeUTF8(payload);
      const sigBytes = nacl.sign.detached(msgBytes, this.deviceKeys.secretKey);
      signature = base64UrlEncode(sigBytes);
    } catch {
      signature = '';
    }

    this.saveDeviceIdentity();

    return {
      id: this.deviceId,
      publicKey: base64UrlEncode(this.deviceKeys.publicKey),
      signature,
      signedAt,
      nonce: deviceNonce,
    };
  }

  // -----------------------------------------------------------------------
  // Connect Handshake
  // -----------------------------------------------------------------------

  private buildConnectParams(challenge: ChallengePayload | null): ConnectParams {
    let clientMode = GATEWAY_CLIENT_MODE;
    if (!clientMode) {
      const id = GATEWAY_CLIENT_ID;
      if (id === 'cli') clientMode = 'cli';
      else if (id === 'gateway-client') clientMode = 'backend';
      else if (id === 'node-host') clientMode = 'node';
      else if (id === 'clawdbot-probe' || id === 'fingerprint') clientMode = 'probe';
      else if (id === 'test') clientMode = 'test';
      else clientMode = 'webchat';
    }

    const role = 'operator';
    const scopes = ['operator.read', 'operator.write'];
    const signedAtMs = Date.now();

    const params: ConnectParams = {
      minProtocol: GATEWAY_PROTOCOL,
      maxProtocol: GATEWAY_PROTOCOL,
      client: {
        id: GATEWAY_CLIENT_ID,
        displayName: GATEWAY_CLIENT_NAME,
        version: '0.1.0',
        platform: platformLabel(),
        mode: clientMode,
      },
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      locale: 'en-US',
      userAgent: `voice-chat-bridge/0.1.0 (${os.platform()} ${os.release()})`,
    };

    const auth: { token?: string; password?: string } = {};
    const resolvedToken = resolveGatewayToken();
    if (resolvedToken) auth.token = resolvedToken;
    if (GATEWAY_PASSWORD) auth.password = GATEWAY_PASSWORD;
    if (auth.token || auth.password) params.auth = auth;

    const device = this.buildDevice({
      clientId: params.client.id,
      clientMode: params.client.mode,
      role,
      scopes,
      token: resolvedToken || '',
      nonce: challenge?.nonce || '',
      signedAtMs,
    });
    if (device) params.device = device;

    return params;
  }

  // -----------------------------------------------------------------------
  // Connection Management
  // -----------------------------------------------------------------------

  async ensureConnected(): Promise<void> {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    if (!this.shouldReconnect) throw new Error('Client is closed');

    this.connecting = new Promise<void>((resolve, reject) => {
      let connectReqId: string | null = null;
      let connectSent = false;
      let settled = false;

      this.emitState('connecting');
      const ws = new WebSocket(GATEWAY_URL);
      this.ws = ws;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        if (err) {
          this.connected = false;
          this.emitState('disconnected');
          reject(err);
        } else {
          this.connected = true;
          this.reconnectAttempt = 0;
          this.emitState('connected');
          resolve();
        }
      };

      const sendConnect = (challenge: ChallengePayload | null): void => {
        if (connectSent) return;
        connectSent = true;
        connectReqId = randomUUID();
        const params = this.buildConnectParams(challenge);
        try {
          ws.send(JSON.stringify({ type: 'req', id: connectReqId, method: 'connect', params }));
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const fallbackTimer = setTimeout(() => {
        if (!connectSent) sendConnect(null);
      }, 750);

      ws.on('open', () => {
        // Wait for connect.challenge if it arrives; fallback timer will send connect.
        log.debug('WebSocket open, waiting for challenge');
      });

      ws.on('message', (data: WebSocket.Data) => {
        let frame: GatewayFrame;
        try {
          const raw = typeof data === 'string' ? data : data.toString();
          frame = JSON.parse(raw) as GatewayFrame;
        } catch {
          return;
        }

        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          clearTimeout(fallbackTimer);
          sendConnect((frame.payload ?? null) as ChallengePayload | null);
          return;
        }

        if (frame.type === 'res' && frame.id === connectReqId) {
          clearTimeout(fallbackTimer);
          if (frame.ok) {
            log.info('Connected to OpenClaw Gateway');
            finish();
          } else {
            finish(new Error(frame.error?.message || 'Gateway connect failed'));
          }
          return;
        }

        // Pass through any other frames that arrive during handshake
        this.handleFrame(frame);
      });

      ws.on('close', () => {
        clearTimeout(fallbackTimer);
        const err = new Error('Gateway connection closed');
        // Only handle disconnect if this socket is still the active one.
        // After close(), this.ws is null — ignore stale close events.
        if (this.ws === ws) this.handleDisconnect(err);
        if (!settled) finish(err);
      });

      ws.on('error', (wsErr: Error) => {
        clearTimeout(fallbackTimer);
        if (this.ws === ws) this.handleDisconnect(wsErr);
        if (!settled) finish(wsErr);
      });
    });

    return this.connecting;
  }

  // -----------------------------------------------------------------------
  // Reconnection with Exponential Backoff
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    const delayMs = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;

    log.info({ delayMs, attempt: this.reconnectAttempt }, 'Scheduling reconnect');
    this.emitState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch((err) => {
        log.warn({ err }, 'Reconnect attempt failed');
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  /** Stop reconnection attempts and close the WebSocket. */
  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.connected = false;
    this.connecting = null;
    this.emitState('disconnected');
  }

  // -----------------------------------------------------------------------
  // Disconnect Handling
  // -----------------------------------------------------------------------

  private handleDisconnect(err: Error): void {
    this.connected = false;
    log.warn({ err: err.message }, 'Gateway disconnected');

    for (const pending of this.pendingReqs.values()) pending.reject(err);
    for (const pending of this.pendingRuns.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingReqs.clear();
    this.pendingRuns.clear();
    this.pendingSessions.clear();

    this.scheduleReconnect();
  }

  // -----------------------------------------------------------------------
  // Frame Routing
  // -----------------------------------------------------------------------

  private handleFrame(frame: GatewayFrame): void {
    if (frame.type === 'res') {
      const pending = this.pendingReqs.get(frame.id ?? '');
      if (!pending) return;
      this.pendingReqs.delete(frame.id ?? '');
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message || 'Gateway request failed'));
      }
      return;
    }

    if (frame.type === 'event' && frame.event === 'chat') {
      this.handleChatEvent((frame.payload ?? {}) as Record<string, unknown>);
    }
  }

  // -----------------------------------------------------------------------
  // Chat Event Processing
  // -----------------------------------------------------------------------

  private handleChatEvent(payload: Record<string, unknown>): void {
    const runId = (payload['runId'] as string | undefined)
      ?? (payload['run'] as Record<string, unknown> | undefined)?.['id'] as string | undefined;
    const sessionKey = (payload['sessionKey'] as string | undefined)
      ?? (payload['session'] as Record<string, unknown> | undefined)?.['key'] as string | undefined;
    const state = (payload['state'] as string | undefined) ?? (payload['phase'] as string | undefined);

    const isDelta = ['delta', 'stream', 'chunk'].includes(state ?? '');
    const isFinal = payload['done'] === true
      || payload['final'] === true
      || ['final', 'done', 'complete', 'finished', 'ok'].includes(state ?? '');
    const isError = state === 'error' || payload['error'] !== undefined || payload['errorMessage'] !== undefined;

    let pending: PendingRun | undefined;
    if (runId) pending = this.pendingRuns.get(runId);
    if (!pending && sessionKey) pending = this.pendingSessions.get(sessionKey);
    if (!pending) return;

    // If we only had sessionKey at registration time, bind the runId once we see it.
    if (runId && pending.runId === '') {
      pending.runId = runId;
      this.pendingRuns.set(runId, pending);
    }

    if (isError) {
      const message = (payload['errorMessage'] as string | undefined)
        ?? (payload['error'] as Record<string, unknown> | undefined)?.['message'] as string | undefined
        ?? 'Gateway chat error';
      this.resolvePending(pending, new Error(message));
      return;
    }

    const text = extractTextFromMessage(
      payload['message'] ?? payload['delta'] ?? payload['content'] ?? payload,
    );

    if (text) {
      if (isDelta) {
        if (text !== pending.lastDelta) {
          const merged = mergeDeltaText(pending.buffer, text);
          if (merged !== pending.buffer) {
            pending.buffer = merged;
            if (pending.onDelta) pending.onDelta(pending.buffer, payload);
          }
          pending.lastDelta = text;
        }
      } else {
        const merged = mergeDeltaText(pending.buffer, text);
        if (merged !== pending.buffer) {
          pending.buffer = merged;
          if (!isFinal && pending.onDelta) pending.onDelta(pending.buffer, payload);
        }
      }
    }

    if (isFinal) {
      const finalText = pending.buffer.trim();
      if (pending.onFinal && !pending.finalSent) {
        pending.finalSent = true;
        pending.onFinal(finalText, payload);
      }
      this.resolvePending(pending, undefined, finalText);
    }
  }

  private resolvePending(pending: PendingRun, error?: Error, text?: string): void {
    if (pending.timer) clearTimeout(pending.timer);

    if (pending.abortSignal && pending.abortHandler) {
      try {
        pending.abortSignal.removeEventListener('abort', pending.abortHandler);
      } catch {
        // ignore
      }
      pending.abortSignal = undefined;
      pending.abortHandler = undefined;
    }

    if (pending.runId) this.pendingRuns.delete(pending.runId);
    if (pending.sessionKey && this.pendingSessions.get(pending.sessionKey) === pending) {
      this.pendingSessions.delete(pending.sessionKey);
    }
    if (error) pending.reject(error);
    else pending.resolve(text ?? '');
  }

  // -----------------------------------------------------------------------
  // RPC
  // -----------------------------------------------------------------------

  async sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    await this.ensureConnected();
    return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const id = randomUUID();
      this.pendingReqs.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (err) {
        this.pendingReqs.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -----------------------------------------------------------------------
  // Chat with streaming
  // -----------------------------------------------------------------------

  async sendChat(
    sessionKey: string,
    message: string,
    callbacks: ChatCallbacks = {},
  ): Promise<string> {
    // Ensure connection before we allocate pending state.
    await this.ensureConnected();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const pending: PendingRun = {
        // runId may arrive slightly after chat events start streaming.
        // We associate early events using sessionKey until runId is known.
        runId: '',
        sessionKey,
        resolve: safeResolve,
        reject: safeReject,
        timer: null,
        buffer: '',
        lastDelta: '',
        onDelta: callbacks.onDelta,
        onFinal: callbacks.onFinal,
        finalSent: false,
        abortSignal: callbacks.signal,
      };

      // Timeout
      pending.timer = setTimeout(() => {
        this.resolvePending(pending, new Error('Gateway chat timeout'));
      }, GATEWAY_TIMEOUT_MS);

      // Make this run discoverable by sessionKey immediately to avoid races where
      // the gateway emits chat events right after the chat.send response.
      if (sessionKey) this.pendingSessions.set(sessionKey, pending);

      // Optional local abort: stop waiting for the run to complete.
      if (pending.abortSignal) {
        if (pending.abortSignal.aborted) {
          this.resolvePending(pending, new Error('Gateway chat aborted'));
          return;
        }
        const onAbort = () => {
          this.resolvePending(pending, new Error('Gateway chat aborted'));
        };
        pending.abortHandler = onAbort;
        try {
          pending.abortSignal.addEventListener('abort', onAbort, { once: true });
        } catch {
          // ignore
        }
      }

      // Fire the request after pending is registered to avoid missing early events.
      this.sendRequest('chat.send', {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
      }).then((payload) => {
        if (settled) return;

        const runId = (payload?.['runId'] as string | undefined)
          ?? (payload?.['run'] as Record<string, unknown> | undefined)?.['id'] as string | undefined
          ?? (payload?.['id'] as string | undefined);

        if (!runId) {
          const reply = (payload?.['reply'] as string | undefined) ?? '';
          this.resolvePending(pending, undefined, reply);
          return;
        }

        pending.runId = runId;
        this.pendingRuns.set(runId, pending);
      }).catch((err) => {
        if (settled) return;
        this.resolvePending(pending, err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}
