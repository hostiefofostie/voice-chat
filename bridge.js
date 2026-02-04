#!/usr/bin/env node
/* Voice Chat Bridge Server
   - POST /api/transcribe { audioBase64, mimeType }
   - POST /api/chat { text, sessionKey? }
   - POST /api/tts { text, voice? }
   - GET  /api/health
*/

const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.VOICE_BRIDGE_PORT || 8787);
const PARKEET_URL = process.env.PARAKEET_URL || 'http://100.86.69.14:8765';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.VOICECHAT_OPENAI_API_KEY || '';

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

const DEFAULT_AGENT_ID = process.env.VOICECHAT_AGENT_ID || 'main';
const DEFAULT_SESSION_KEY = process.env.VOICECHAT_SESSION_KEY || 'main';

const TTS_MODEL = process.env.VOICECHAT_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.VOICECHAT_TTS_VOICE || 'nova';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req, limit = 15 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      reject(new Error('Payload too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const readJson = async (req) => {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf-8'));
};

const normalizeSessionKey = (rawKey) => {
  const key = (rawKey || '').trim();
  const base = key || DEFAULT_SESSION_KEY;
  if (!base) return `agent:${DEFAULT_AGENT_ID}:main`;
  if (base.includes(':')) return base;
  return `agent:${DEFAULT_AGENT_ID}:${base}`;
};

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const base64UrlEncode = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const derivePublicKeyRaw = (publicKeyObj) => {
  const spki = publicKeyObj.export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
};

const buildDeviceAuthPayload = ({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce
}) => {
  const version = nonce ? 'v2' : 'v1';
  const scopeList = Array.isArray(scopes) ? scopes.join(',') : '';
  const base = [
    version,
    deviceId,
    clientId,
    clientMode,
    role,
    scopeList,
    String(signedAtMs),
    token || ''
  ];
  if (version === 'v2') base.push(nonce || '');
  return base.join('|');
};

const readJsonFile = (filePath) => {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const resolveGatewayToken = () => {
  if (GATEWAY_TOKEN) return GATEWAY_TOKEN;
  const config = readJsonFile(OPENCLAW_CONFIG_FILE);
  const token = config?.gateway?.auth?.token;
  if (token) return token;
  const deviceAuth = readJsonFile(OPENCLAW_DEVICE_AUTH_FILE);
  return deviceAuth?.tokens?.operator?.token || '';
};

const computeDeviceId = (publicKeyObj) => {
  const raw = derivePublicKeyRaw(publicKeyObj);
  return crypto.createHash('sha256').update(raw).digest('hex');
};

const rawPublicKeyBase64Url = (publicKeyObj) => base64UrlEncode(derivePublicKeyRaw(publicKeyObj));

const platformLabel = () => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform || 'node';
};

const extractText = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return extractText(value.content);
    if (value.delta !== undefined) return extractText(value.delta);
  }
  return '';
};

const extractTextFromMessage = (message) => {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return extractText(message);
  const role = message.role || message.authorRole || message.author?.role;
  if (role && role !== 'assistant') return '';
  return extractText(message.content ?? message.text ?? message.delta ?? message);
};

class GatewayClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.connecting = null;
    this.pendingReqs = new Map();
    this.pendingRuns = new Map();
    this.pendingSessions = new Map();
    this.deviceKeys = null;
    this.deviceId = null;
    this.deviceToken = null;
    this.lastClientMode = null;
  }

  loadDeviceIdentity() {
    if (this.deviceKeys || !GATEWAY_DEVICE_FILE) return;
    try {
      if (!fs.existsSync(GATEWAY_DEVICE_FILE)) return;
      const raw = fs.readFileSync(GATEWAY_DEVICE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      if (saved?.publicKeyPem && saved?.privateKeyPem && saved?.deviceId) {
        const publicKey = crypto.createPublicKey(saved.publicKeyPem);
        const privateKey = crypto.createPrivateKey(saved.privateKeyPem);
        this.deviceKeys = { publicKey, privateKey };
        this.deviceId = saved.deviceId;
        return;
      }
      if (saved?.publicKey && saved?.privateKey && (saved?.id || saved?.deviceId)) {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(saved.publicKey, 'base64'),
          format: 'der',
          type: 'spki'
        });
        const privateKey = crypto.createPrivateKey({
          key: Buffer.from(saved.privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8'
        });
        this.deviceKeys = { publicKey, privateKey };
        this.deviceId = saved.id || saved.deviceId;
      }
    } catch {}
  }

  saveDeviceIdentity() {
    if (!SHOULD_PERSIST_DEVICE || !GATEWAY_DEVICE_FILE || !this.deviceKeys || !this.deviceId) return;
    try {
      const publicKeyPem = this.deviceKeys.publicKey.export({ format: 'pem', type: 'spki' });
      const privateKeyPem = this.deviceKeys.privateKey.export({ format: 'pem', type: 'pkcs8' });
      const payload = {
        version: 1,
        deviceId: this.deviceId,
        publicKeyPem,
        privateKeyPem,
        createdAtMs: Date.now()
      };
      fs.writeFileSync(GATEWAY_DEVICE_FILE, JSON.stringify(payload, null, 2));
    } catch {}
  }

  buildDevice({ clientId, clientMode, role, scopes, token, nonce, signedAtMs }) {
    if (GATEWAY_ALLOW_INSECURE) return null;
    this.loadDeviceIdentity();
    if (!this.deviceKeys) {
      this.deviceKeys = crypto.generateKeyPairSync('ed25519');
    }
    if (!this.deviceId) {
      this.deviceId = GATEWAY_DEVICE_ID || computeDeviceId(this.deviceKeys.publicKey);
    }
    const signedAt = signedAtMs ?? Date.now();
    const deviceNonce = nonce || '';
    const payload = buildDeviceAuthPayload({
      deviceId: this.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs: signedAt,
      token,
      nonce: deviceNonce || undefined
    });
    let signature = '';
    try {
      const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), this.deviceKeys.privateKey);
      signature = base64UrlEncode(sig);
    } catch {
      signature = '';
    }
    this.saveDeviceIdentity();
    return {
      id: this.deviceId,
      publicKey: rawPublicKeyBase64Url(this.deviceKeys.publicKey),
      signature,
      signedAt,
      nonce: deviceNonce
    };
  }

  buildConnectParams(challenge) {
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
    this.lastClientMode = clientMode;
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write'];
    const signedAtMs = Date.now();
    const params = {
      minProtocol: GATEWAY_PROTOCOL,
      maxProtocol: GATEWAY_PROTOCOL,
      client: {
        id: GATEWAY_CLIENT_ID,
        displayName: GATEWAY_CLIENT_NAME,
        version: '0.1.0',
        platform: platformLabel(),
        mode: clientMode
      },
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      locale: 'en-US',
      userAgent: `voice-chat-bridge/0.1.0 (${os.platform()} ${os.release()})`
    };
    const auth = {};
    const resolvedToken = resolveGatewayToken();
    if (resolvedToken) auth.token = resolvedToken;
    if (GATEWAY_PASSWORD) auth.password = GATEWAY_PASSWORD;
    if (Object.keys(auth).length) params.auth = auth;
    const device = this.buildDevice({
      clientId: params.client.id,
      clientMode: params.client.mode,
      role,
      scopes,
      token: resolvedToken || '',
      nonce: challenge?.nonce || '',
      signedAtMs
    });
    if (device) params.device = device;
    return params;
  }

  async ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      let connectReqId = null;
      let connectSent = false;
      let settled = false;
      const ws = new WebSocket(GATEWAY_URL);
      this.ws = ws;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        if (err) {
          this.connected = false;
          reject(err);
        } else {
          this.connected = true;
          resolve();
        }
      };

      const sendConnect = (challenge) => {
        if (connectSent) return;
        connectSent = true;
        connectReqId = crypto.randomUUID();
        const params = this.buildConnectParams(challenge);
        try {
          ws.send(JSON.stringify({ type: 'req', id: connectReqId, method: 'connect', params }));
        } catch (err) {
          finish(err);
        }
      };

      const fallbackTimer = setTimeout(() => {
        if (!connectSent) sendConnect(null);
      }, 750);

      ws.onopen = () => {
        // Wait for connect.challenge if it arrives; fallback timer will send connect.
      };

      ws.onmessage = (event) => {
        let frame;
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data?.toString?.() || '';
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          clearTimeout(fallbackTimer);
          sendConnect(frame.payload);
          return;
        }
        if (frame.type === 'res' && frame.id === connectReqId) {
          clearTimeout(fallbackTimer);
          if (frame.ok) {
            finish();
          } else {
            finish(new Error(frame.error?.message || 'Gateway connect failed'));
          }
          return;
        }
        this.handleFrame(frame);
      };

      ws.onclose = () => {
        clearTimeout(fallbackTimer);
        this.handleDisconnect(new Error('Gateway connection closed'));
        if (!settled) finish(new Error('Gateway connection closed'));
      };

      ws.onerror = (err) => {
        clearTimeout(fallbackTimer);
        const error = err instanceof Error ? err : new Error('Gateway socket error');
        this.handleDisconnect(error);
        if (!settled) finish(error);
      };
    });

    return this.connecting;
  }

  handleDisconnect(err) {
    this.connected = false;
    for (const pending of this.pendingReqs.values()) pending.reject(err);
    for (const pending of this.pendingRuns.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingReqs.clear();
    this.pendingRuns.clear();
    this.pendingSessions.clear();
  }

  handleFrame(frame) {
    if (frame.type === 'res') {
      const pending = this.pendingReqs.get(frame.id);
      if (!pending) return;
      this.pendingReqs.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message || 'Gateway request failed'));
      }
      return;
    }
    if (frame.type === 'event' && frame.event === 'chat') {
      this.handleChatEvent(frame.payload);
    }
  }

  handleChatEvent(payload) {
    if (!payload) return;
    const runId = payload.runId || payload.run?.id;
    const sessionKey = payload.sessionKey || payload.session?.key;
    const state = payload.state || payload.phase;
    const isDelta = ['delta', 'stream', 'chunk'].includes(state);
    const isFinal = payload.done === true || payload.final === true || ['final', 'done', 'complete', 'finished', 'ok'].includes(state);
    const isError = state === 'error' || payload.error || payload.errorMessage;

    let pending = null;
    if (runId && this.pendingRuns.has(runId)) pending = this.pendingRuns.get(runId);
    if (!pending && sessionKey && this.pendingSessions.has(sessionKey)) pending = this.pendingSessions.get(sessionKey);
    if (!pending && this.pendingRuns.size === 1) pending = [...this.pendingRuns.values()][0];
    if (!pending) return;

    if (isError) {
      const message = payload.errorMessage || payload.error?.message || 'Gateway chat error';
      this.resolvePending(pending, new Error(message));
      return;
    }

    const text = extractTextFromMessage(payload.message || payload.delta || payload.content || payload);
    if (text) {
      if (isDelta) {
        pending.buffer += text;
      } else if (!pending.buffer || text.length > pending.buffer.length) {
        pending.buffer = text;
      }
    }

    if (isFinal) {
      const finalText = pending.buffer.trim();
      this.resolvePending(pending, null, finalText);
    }
  }

  resolvePending(pending, error, text) {
    clearTimeout(pending.timer);
    if (pending.runId) this.pendingRuns.delete(pending.runId);
    if (pending.sessionKey && this.pendingSessions.get(pending.sessionKey) === pending) {
      this.pendingSessions.delete(pending.sessionKey);
    }
    if (error) pending.reject(error);
    else pending.resolve(text || '');
  }

  async sendRequest(method, params) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pendingReqs.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (err) {
        this.pendingReqs.delete(id);
        reject(err);
      }
    });
  }

  async sendChat(sessionKey, message) {
    const payload = await this.sendRequest('chat.send', {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID()
    });
    const runId = payload?.runId || payload?.run?.id || payload?.id;
    if (!runId) return payload?.reply || '';
    return new Promise((resolve, reject) => {
      const pending = {
        runId,
        sessionKey,
        resolve,
        reject,
        timer: null,
        buffer: ''
      };
      pending.timer = setTimeout(() => {
        this.resolvePending(pending, new Error('Gateway chat timeout'));
      }, GATEWAY_TIMEOUT_MS);
      this.pendingRuns.set(runId, pending);
      if (sessionKey) this.pendingSessions.set(sessionKey, pending);
    });
  }
}

const gateway = new GatewayClient();

const handleTranscribe = async (req, res) => {
  const t0 = Date.now();
  const { audioBase64, mimeType } = await readJson(req);
  if (!audioBase64) return json(res, 400, { error: 'audioBase64 required' });
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/wav' });
  form.append('audio', blob, 'audio.wav');
  const resp = await fetch(`${PARKEET_URL}/transcribe`, { method: 'POST', body: form });
  const t1 = Date.now();
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.log(`[transcribe] ${t1 - t0}ms error ${resp.status}`);
    return json(res, resp.status, { error: `Parakeet error (${resp.status})`, detail: text });
  }
  const data = await resp.json();
  console.log(`[transcribe] ${t1 - t0}ms ok`);
  return json(res, 200, { ...data, timingMs: { transcribe: t1 - t0 } });
};

const handleChat = async (req, res) => {
  const t0 = Date.now();
  const { text, sessionKey, mode } = await readJson(req);
  if (!text || !text.trim()) return json(res, 400, { error: 'text required' });
  const key = normalizeSessionKey(sessionKey || DEFAULT_SESSION_KEY);
  const payload = mode === 'voice' ? `[[voice]] ${text}` : text;
  try {
    const reply = await gateway.sendChat(key, payload);
    const t1 = Date.now();
    console.log(`[chat] ${t1 - t0}ms ok`);
    return json(res, 200, { text: reply || '', timingMs: { chat: t1 - t0 } });
  } catch (err) {
    const t1 = Date.now();
    console.log(`[chat] ${t1 - t0}ms error`);
    return json(res, 500, { error: 'Gateway chat error', detail: String(err?.message || err) });
  }
};

const handleTts = async (req, res) => {
  const t0 = Date.now();
  const { text, voice, instructions } = await readJson(req);
  if (!text || !text.trim()) return json(res, 400, { error: 'text required' });
  if (!OPENAI_API_KEY) return json(res, 500, { error: 'OPENAI_API_KEY not set on bridge server' });
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: voice || TTS_VOICE,
      input: text,
      instructions,
      response_format: 'mp3'
    })
  });
  const t1 = Date.now();
  if (!resp.ok) {
    const textErr = await resp.text().catch(() => '');
    console.log(`[tts] ${t1 - t0}ms error ${resp.status}`);
    return json(res, resp.status, { error: `TTS error (${resp.status})`, detail: textErr });
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  console.log(`[tts] ${t1 - t0}ms ok`);
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  res.end(buf);
};

const handleHealth = async (_req, res) => {
  json(res, 200, {
    ok: true,
    parakeetUrl: PARKEET_URL,
    gatewayUrl: GATEWAY_URL,
    sessionKey: normalizeSessionKey(DEFAULT_SESSION_KEY),
    ttsConfigured: !!OPENAI_API_KEY
  });
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(req, res);
    if (req.method === 'POST' && url.pathname === '/api/transcribe') return await handleTranscribe(req, res);
    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTts(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Voice bridge listening on http://127.0.0.1:${PORT}`);
});
