/**
 * Handler pipeline integration tests.
 *
 * These test the WebSocket handler's message routing and pipeline wiring
 * (audio → STT → LLM → TTS → client) with mocked external services.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

// -----------------------------------------------------------------------
// Mock external service modules BEFORE importing the handler
// -----------------------------------------------------------------------

const mockTranscribe = vi.fn();
const mockSttHealthCheck = vi.fn().mockResolvedValue(true);
const mockSendChat = vi.fn();
const mockGatewayClose = vi.fn();
const mockEnsureConnected = vi.fn().mockResolvedValue(undefined);
const mockKokoroSynthesize = vi.fn();
const mockKokoroHealthCheck = vi.fn().mockResolvedValue(true);
const mockOpenaiSynthesize = vi.fn();

vi.mock('../../stt/parakeet-client.js', () => ({
  ParakeetClient: vi.fn().mockImplementation(function (this: any) {
    this.transcribe = mockTranscribe;
    this.healthCheck = mockSttHealthCheck;
  }),
}));

vi.mock('../../llm/gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(function (this: any) {
    this.sendChat = mockSendChat;
    this.ensureConnected = mockEnsureConnected;
    this.close = mockGatewayClose;
    this.onConnectionState = vi.fn().mockReturnValue(() => {});
  }),
}));

vi.mock('../../tts/kokoro-client.js', () => ({
  KokoroClient: vi.fn().mockImplementation(function (this: any) {
    this.synthesize = mockKokoroSynthesize;
    this.healthCheck = mockKokoroHealthCheck;
  }),
}));

vi.mock('../../tts/openai-client.js', () => ({
  OpenAiTtsClient: vi.fn().mockImplementation(function (this: any) {
    this.synthesize = mockOpenaiSynthesize;
  }),
}));

// Import handler AFTER mocks are registered
import { registerWebSocket } from '../handler.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeWav(pcmBytes: number = 3200): Buffer {
  const pcm = Buffer.alloc(pcmBytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sendJson(ws: WebSocket, obj: Record<string, unknown>) {
  ws.send(JSON.stringify(obj));
}

function rawToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return String(data);
}

/**
 * Collect all JSON messages that arrive within a timeout window.
 * Returns a promise that resolves with the collected messages.
 */
function collectMessages(
  ws: WebSocket,
  timeoutMs: number = 500,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const msgs: Array<Record<string, unknown>> = [];
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        msgs.push(JSON.parse(rawToString(data)));
      } catch {
        // ignore non-json
      }
    };
    ws.on('message', onMessage);
    setTimeout(() => {
      ws.off('message', onMessage);
      resolve(msgs);
    }, timeoutMs);
  });
}

/**
 * Wait for a specific message type to arrive.
 */
function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs: number = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(rawToString(data));
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {
        // ignore non-json
      }
    };

    ws.on('message', handler);
  });
}

/**
 * Collect messages until a specific type appears.
 */
function collectUntil(
  ws: WebSocket,
  untilType: string,
  timeoutMs: number = 5000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const msgs: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for ${untilType}. Got: ${msgs.map(m => m.type).join(', ')}`));
    }, timeoutMs);

    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(rawToString(data));
        msgs.push(msg);
        if (msg.type === untilType) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msgs);
        }
      } catch {
        // ignore non-json
      }
    };

    ws.on('message', handler);
  });
}

// -----------------------------------------------------------------------
// Server setup
// -----------------------------------------------------------------------

let app: FastifyInstance;
let baseUrl: string;

function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  throw new Error('Server address is not available');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: 5 * 1024 * 1024 } });
  registerWebSocket(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = getPort(app);
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default mock implementations
  mockKokoroSynthesize.mockResolvedValue(makeWav());
});

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  ws.close();
  await new Promise<void>((resolve) => ws.once('close', () => resolve()));
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Handler pipeline — text-input flow', () => {
  it('transcript_send triggers thinking → speaking → idle with LLM tokens and TTS audio', async () => {
    // Set up mock: sendChat calls onDelta/onFinal to simulate LLM streaming
    const llmResponse = 'I would be happy to help you with that question today.';
    mockSendChat.mockImplementation(
      async (_sessionKey: string, _message: string, callbacks: Record<string, unknown>) => {
        const onDelta = callbacks.onDelta as (text: string, payload: Record<string, unknown>) => void;
        const onFinal = callbacks.onFinal as (text: string, payload: Record<string, unknown>) => void;
        // Simulate progressive deltas
        const words = llmResponse.split(' ');
        let buf = '';
        for (const word of words) {
          buf += (buf ? ' ' : '') + word;
          onDelta?.(buf, {});
        }
        onFinal?.(llmResponse, {});
        return llmResponse;
      },
    );

    const ws = await connectWs();
    try {
      // Start collecting messages, then send transcript
      const msgsPromise = collectUntil(ws, 'tts_done', 5000);

      sendJson(ws, {
        type: 'transcript_send',
        text: 'Hello, can you help me?',
        turnId: 'test-turn-1',
      });

      const msgs = await msgsPromise;
      const types = msgs.map((m) => m.type);

      // Should contain state transitions
      expect(types).toContain('turn_state');
      expect(types).toContain('llm_token');
      expect(types).toContain('llm_done');
      expect(types).toContain('tts_meta');
      expect(types).toContain('tts_done');

      // Verify state flow includes thinking
      const stateChanges = msgs
        .filter((m) => m.type === 'turn_state')
        .map((m) => m.state);
      expect(stateChanges[0]).toBe('thinking');

      // Verify LLM done has full text
      const llmDone = msgs.find((m) => m.type === 'llm_done') as Record<string, unknown>;
      expect(llmDone.fullText).toBe(llmResponse);

      // Verify sendChat was called with the voice instruction prefix
      expect(mockSendChat).toHaveBeenCalledTimes(1);
      const chatMessage = mockSendChat.mock.calls[0][1] as string;
      expect(chatMessage).toContain('[[voice]]');
      expect(chatMessage).toContain('Hello, can you help me?');
    } finally {
      await closeWs(ws);
    }
  });

  it('barge_in during speaking cancels pipeline and transitions to idle', async () => {
    // Make sendChat hold open so we can barge in during "speaking"
    let chatResolver: (() => void) | null = null;
    mockSendChat.mockImplementation(
      async (_s: string, _m: string, callbacks: Record<string, unknown>) => {
        const onDelta = callbacks.onDelta as (text: string, payload: Record<string, unknown>) => void;
        // Emit enough text to trigger a phrase and transition to speaking
        onDelta?.('I would be happy to help you with that question today.', {});
        // Hold open — don't call onFinal yet
        return new Promise<string>((resolve) => {
          chatResolver = () => resolve('done');
        });
      },
    );

    const ws = await connectWs();
    try {
      // Send transcript to start pipeline
      sendJson(ws, {
        type: 'transcript_send',
        text: 'test',
        turnId: 'test-turn-barge',
      });

      // Wait for speaking state
      await waitForMessage(ws, 'tts_meta', 3000);

      // Now barge in
      const idlePromise = waitForMessage(ws, 'turn_state', 2000);
      sendJson(ws, { type: 'barge_in' });

      const stateMsg = await idlePromise;
      expect(stateMsg.state).toBe('idle');

      // Clean up the held promise
      (chatResolver as (() => void) | null)?.();
    } finally {
      await closeWs(ws);
    }
  });

  it('cancel during thinking transitions to idle', async () => {
    // Make sendChat hold open
    let chatResolver: (() => void) | null = null;
    mockSendChat.mockImplementation(async () => {
      return new Promise<string>((resolve) => {
        chatResolver = () => resolve('done');
      });
    });

    const ws = await connectWs();
    try {
      sendJson(ws, {
        type: 'transcript_send',
        text: 'test',
        turnId: 'test-turn-cancel',
      });

      // Wait for thinking state
      await waitForMessage(ws, 'turn_state', 2000);

      // Cancel
      const idlePromise = waitForMessage(ws, 'turn_state', 2000);
      sendJson(ws, { type: 'cancel' });

      const stateMsg = await idlePromise;
      expect(stateMsg.state).toBe('idle');

      (chatResolver as (() => void) | null)?.();
    } finally {
      await closeWs(ws);
    }
  });
});

describe('Handler pipeline — audio flow', () => {
  it('binary audio frame transitions to listening state', async () => {
    const ws = await connectWs();
    try {
      const statePromise = waitForMessage(ws, 'turn_state', 2000);
      // Send binary audio data
      ws.send(Buffer.alloc(1000), { binary: true });
      const msg = await statePromise;
      expect(msg.state).toBe('listening');
    } finally {
      await closeWs(ws);
    }
  });

  it('audio buffer overflow sends error and returns to idle', async () => {
    const ws = await connectWs();
    try {
      // Wait for listening state first
      const listeningPromise = waitForMessage(ws, 'turn_state', 2000);
      ws.send(Buffer.alloc(1000), { binary: true });
      await listeningPromise;

      // Send more than 10MB total to trigger overflow.
      // Note: ws maxPayload is 5MB, so we send multiple smaller frames.
      const errorPromise = waitForMessage(ws, 'error', 5000);
      const chunk = Buffer.alloc(4 * 1024 * 1024); // 4MB
      ws.send(chunk, { binary: true });
      ws.send(chunk, { binary: true });
      ws.send(chunk, { binary: true });

      const errMsg = await errorPromise;
      expect(errMsg.code).toBe('AUDIO_BUFFER_OVERFLOW');
      expect(errMsg.recoverable).toBe(true);
    } finally {
      await closeWs(ws);
    }
  });
});

describe('Handler pipeline — rate limiting', () => {
  it('blocks excessive transcript_send messages', async () => {
    // The LLM rate limiter allows 30/min. We need to exceed that.
    // Use a mock sendChat that resolves quickly.
    mockSendChat.mockImplementation(
      async (_s: string, _m: string, callbacks: Record<string, unknown>) => {
        const onFinal = callbacks.onFinal as (text: string, payload: Record<string, unknown>) => void;
        onFinal?.('ok', {});
        return 'ok';
      },
    );

    const ws = await connectWs();
    try {
      // Start collecting before we send to avoid missing fast responses.
      const msgsPromise = collectMessages(ws, 1200);

      // Send 31 transcript_sends rapidly
      for (let i = 0; i < 31; i++) {
        sendJson(ws, {
          type: 'transcript_send',
          text: `msg ${i}`,
          turnId: `turn-${i}`,
        });
      }

      const msgs = await msgsPromise;

      // Should contain at least one rate limit error
      const rateLimitErrors = msgs.filter(
        (m) => m.type === 'error' && m.code === 'LLM_RATE_LIMITED',
      );
      expect(rateLimitErrors.length).toBeGreaterThan(0);
    } finally {
      await closeWs(ws);
    }
  });
});

describe('Handler pipeline — error handling', () => {
  it('LLM error sends error message and returns to idle', async () => {
    mockSendChat.mockRejectedValue(new Error('Gateway timeout'));

    const ws = await connectWs();
    try {
      const msgsPromise = collectMessages(ws, 1500);

      sendJson(ws, {
        type: 'transcript_send',
        text: 'trigger error',
        turnId: 'turn-error',
      });

      const msgs = await msgsPromise;
      const types = msgs.map((m) => m.type);

      // Should have thinking state, then error, then idle
      expect(types).toContain('turn_state');
      expect(types).toContain('error');

      const errorMsg = msgs.find((m) => m.type === 'error');
      expect(errorMsg?.code).toBe('llm_error');
      expect(errorMsg?.recoverable).toBe(true);

      // Should end in idle
      const stateChanges = msgs.filter((m) => m.type === 'turn_state');
      const lastState = stateChanges[stateChanges.length - 1];
      expect(lastState?.state).toBe('idle');
    } finally {
      await closeWs(ws);
    }
  });
});
