import { FastifyInstance } from 'fastify';
import { WebSocket, RawData } from 'ws';
import {
  ChatHistoryMessage,
  ClientMessage,
  ServerMessage,
  SessionConfig,
  DEFAULT_CONFIG,
} from '../types.js';
import { executeCommand } from './commands.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';
import { ParakeetClient } from '../stt/parakeet-client.js';
import { SttRouter } from '../stt/router.js';
import { GatewayClient, extractText } from '../llm/gateway-client.js';
import { LlmPipeline } from '../llm/pipeline.js';
import { KokoroClient } from '../tts/kokoro-client.js';
import { OpenAiTtsClient } from '../tts/openai-client.js';
import { TtsRouter } from '../tts/router.js';
import { TtsPipeline } from '../tts/pipeline.js';
import { Turn } from './turn.js';

// ---------------------------------------------------------------------------
// Connection State
// ---------------------------------------------------------------------------

interface ConnectionState {
  id: string;
  ws: WebSocket;
  config: SessionConfig;
  activeTurn: Turn | null;
  connectedAt: number;
  lastPingAt: number;
  messageLimiter: SlidingWindowRateLimiter;
  llmLimiter: SlidingWindowRateLimiter;
  sttRouter: SttRouter;
  llmPipeline: LlmPipeline;
  ttsPipeline: TtsPipeline;
  gatewayClient: GatewayClient;
  lastHydratedSessionKey: string | null;
}

const MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT_MSG_PER_SEC = 100;
const RATE_LIMIT_LLM_PER_MIN = 30;
const KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_SESSION_KEY = 'main';
const CHAT_HISTORY_LIMIT = 120;

// ---------------------------------------------------------------------------
// Shared Clients (singleton per process)
// ---------------------------------------------------------------------------

let _gatewayClient: GatewayClient | null = null;
function getGatewayClient(): GatewayClient {
  if (!_gatewayClient) {
    _gatewayClient = new GatewayClient();
  }
  return _gatewayClient;
}

// ---------------------------------------------------------------------------
// Message Helpers
// ---------------------------------------------------------------------------

function sendMessage(conn: ConnectionState, msg: ServerMessage) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(JSON.stringify(msg));
}

function sendBinary(conn: ConnectionState, data: Buffer) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(data, { binary: true });
}

function normalizeSessionKey(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SESSION_KEY;
  const trimmed = raw.trim();
  return trimmed || DEFAULT_SESSION_KEY;
}

function parseHistoryMessages(payload: Record<string, unknown> | undefined): ChatHistoryMessage[] {
  if (!payload) return [];

  const fromPayload = payload['messages'];
  if (!Array.isArray(fromPayload)) return [];

  const out: ChatHistoryMessage[] = [];
  for (const item of fromPayload) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const roleRaw = msg['role'];
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;

    const text = extractText(msg['content'] ?? msg['text'] ?? msg);
    const cleaned = text.trim();
    if (!cleaned) continue;

    const timestamp = typeof msg['timestamp'] === 'number' ? msg['timestamp'] : undefined;
    out.push({ role: roleRaw, text: cleaned, timestamp });
  }

  // OpenClaw chat.history returns newest-first; UI wants chronological.
  return out.reverse();
}

async function hydrateChatHistory(conn: ConnectionState, app: FastifyInstance): Promise<void> {
  const sessionKey = normalizeSessionKey(conn.config.sessionKey);

  // Avoid redundant fetches for the same active session key.
  if (conn.lastHydratedSessionKey === sessionKey) return;

  try {
    const payload = await conn.gatewayClient.sendRequest('chat.history', {
      sessionKey,
      limit: CHAT_HISTORY_LIMIT,
    });

    const messages = parseHistoryMessages(payload);
    conn.lastHydratedSessionKey = sessionKey;

    sendMessage(conn, {
      type: 'chat_history',
      sessionKey,
      messages,
    });

    app.log.info(
      { connId: conn.id, sessionKey, count: messages.length },
      'Hydrated chat history',
    );
  } catch (err) {
    app.log.warn(
      { connId: conn.id, sessionKey, err },
      'Failed to hydrate chat history',
    );
  }
}

// ---------------------------------------------------------------------------
// Turn Factory
// ---------------------------------------------------------------------------

function createTurn(conn: ConnectionState, app: FastifyInstance): Turn {
  const turn = new Turn(crypto.randomUUID(), {
    connId: conn.id,
    sttRouter: conn.sttRouter,
    llmPipeline: conn.llmPipeline,
    ttsPipeline: conn.ttsPipeline,
    sendJson: (msg) => sendMessage(conn, msg),
    sendBinary: (data) => sendBinary(conn, data),
    logger: app.log,
  });

  turn.on('completed', () => {
    if (conn.activeTurn === turn) {
      conn.activeTurn = null;
    }
  });

  turn.on('cancelled', () => {
    if (conn.activeTurn === turn) {
      conn.activeTurn = null;
    }
  });

  return turn;
}

function cancelActiveTurn(conn: ConnectionState) {
  if (conn.activeTurn) {
    conn.activeTurn.cancel();
    conn.activeTurn = null;
  }
}

// ---------------------------------------------------------------------------
// Binary Frame Handling
// ---------------------------------------------------------------------------

function handleAudioFrame(
  conn: ConnectionState,
  data: Buffer,
  app: FastifyInstance,
) {
  if (!conn.activeTurn) {
    // Start a new turn
    conn.activeTurn = createTurn(conn, app);
    conn.activeTurn.transition('AUDIO_START');
  }

  const turn = conn.activeTurn;

  if (turn.currentState === 'pending_send') {
    // User resumed speaking during the auto-send countdown.
    app.log.info({ connId: conn.id }, 'Audio during pending_send, resuming listening');
    turn.transition('AUDIO_RESUME');
  } else if (turn.currentState === 'transcribing') {
    // Audio arrived while STT is running — buffer it silently.
    // Turn.transcribe() will detect the new audio and loop back to listening.
    turn.appendAudio(data);
    return;
  } else if (turn.currentState !== 'listening') {
    app.log.warn(
      { connId: conn.id, state: turn.currentState },
      'Audio frame received in non-listening state, discarding',
    );
    return;
  }

  // Guard against excessive buffering
  if (turn.audioBytes + data.length > MAX_AUDIO_BUFFER_BYTES) {
    sendMessage(conn, {
      type: 'error',
      code: 'AUDIO_BUFFER_OVERFLOW',
      message: 'Audio buffer exceeded 10 MB limit',
      recoverable: true,
    });
    cancelActiveTurn(conn);
    return;
  }

  turn.appendAudio(data);
}

// ---------------------------------------------------------------------------
// JSON Message Routing
// ---------------------------------------------------------------------------

function handleJsonMessage(
  conn: ConnectionState,
  msg: ClientMessage,
  app: FastifyInstance,
) {
  switch (msg.type) {
    case 'ping':
      sendMessage(conn, { type: 'pong', ts: msg.ts, serverTs: Date.now() });
      break;

    case 'transcript_send': {
      if (!conn.llmLimiter.check()) {
        sendMessage(conn, {
          type: 'error',
          code: 'LLM_RATE_LIMITED',
          message: `LLM rate limit exceeded (${RATE_LIMIT_LLM_PER_MIN}/min). Please wait before sending again.`,
          recoverable: true,
        });
        return;
      }
      app.log.info(
        { connId: conn.id, turnId: msg.turnId, text: msg.text },
        'Received transcript_send',
      );

      // Get or create a turn
      let turn = conn.activeTurn;
      if (!turn) {
        turn = createTurn(conn, app);
        conn.activeTurn = turn;
      }

      // Transition based on current state
      if (turn.currentState === 'idle') {
        if (!turn.transition('TEXT_SEND')) return;
      } else if (turn.currentState === 'pending_send') {
        if (!turn.transition('SEND')) return;
      } else {
        // Already thinking/speaking — ignore duplicate sends (fixes concurrency bug)
        app.log.warn({ connId: conn.id, state: turn.currentState }, 'Ignoring transcript_send in active pipeline');
        return;
      }

      turn.think(msg.text, normalizeSessionKey(conn.config.sessionKey)).catch((err) => {
        app.log.error({ connId: conn.id, err }, 'LLM/TTS pipeline failed');
      });
      break;
    }

    case 'command':
      app.log.info(
        { connId: conn.id, command: msg.name },
        'Received command',
      );
      executeCommand(msg.name, msg.args, {
        config: conn.config,
        updateConfig: (partial) => {
          Object.assign(conn.config, partial);
          app.log.info(
            { connId: conn.id, config: conn.config },
            'Config updated via command',
          );
        },
        sendMessage: (m) => sendMessage(conn, m),
      });
      break;

    case 'barge_in':
      app.log.info({ connId: conn.id }, 'Barge-in received');
      cancelActiveTurn(conn);
      break;

    case 'cancel':
      app.log.info({ connId: conn.id }, 'Cancel received');
      cancelActiveTurn(conn);
      break;

    case 'config': {
      // Merge partial config
      Object.assign(conn.config, msg.settings);
      if (typeof conn.config.sessionKey === 'string') {
        conn.config.sessionKey = conn.config.sessionKey.trim();
      }
      app.log.info(
        { connId: conn.id, config: conn.config },
        'Config updated',
      );
      void hydrateChatHistory(conn, app);
      break;
    }

    default: {
      const _exhaustive: never = msg;
      sendMessage(conn, {
        type: 'error',
        code: 'UNKNOWN_MESSAGE',
        message: `Unknown message type`,
        recoverable: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket Route Registration
// ---------------------------------------------------------------------------

export function registerWebSocket(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    // Create per-connection pipeline instances
    const gatewayClient = getGatewayClient();
    const parakeetClient = new ParakeetClient();
    const sttRouter = new SttRouter(parakeetClient);
    const llmPipeline = new LlmPipeline(gatewayClient);
    const kokoroClient = new KokoroClient();
    const openaiTtsClient = new OpenAiTtsClient();
    const ttsRouter = new TtsRouter(kokoroClient, openaiTtsClient);

    const conn: ConnectionState = {
      id: crypto.randomUUID(),
      ws: socket,
      config: { ...DEFAULT_CONFIG },
      activeTurn: null,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      messageLimiter: new SlidingWindowRateLimiter(RATE_LIMIT_MSG_PER_SEC, 1_000),
      llmLimiter: new SlidingWindowRateLimiter(RATE_LIMIT_LLM_PER_MIN, 60_000),
      sttRouter,
      llmPipeline,
      ttsPipeline: new TtsPipeline({
        ttsRouter,
        sendJson: (msg) => sendMessage(conn, msg),
        sendBinary: (data) => sendBinary(conn, data),
      }),
      gatewayClient,
      lastHydratedSessionKey: null,
    };

    app.log.info({ connId: conn.id }, 'WebSocket connected');

    // Prevent unhandled 'error' events on TtsPipeline from crashing the process.
    conn.ttsPipeline.on('error', (err) => {
      app.log.error({ connId: conn.id, err }, 'TTS pipeline error');
      sendMessage(conn, {
        type: 'error',
        code: 'tts_error',
        message: err instanceof Error ? err.message : 'TTS synthesis failed',
        recoverable: true,
      });
    });

    conn.ttsPipeline.on('all_failed', () => {
      sendMessage(conn, {
        type: 'error',
        code: 'tts_all_failed',
        message: 'All TTS chunks failed — no audio for this response',
        recoverable: true,
      });
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!conn.messageLimiter.check()) {
        sendMessage(conn, {
          type: 'error',
          code: 'RATE_LIMITED',
          message: 'Too many messages, slow down',
          recoverable: true,
        });
        return;
      }

      if (isBinary) {
        handleAudioFrame(conn, data as Buffer, app);
      } else {
        try {
          const msg: ClientMessage = JSON.parse(data.toString());
          handleJsonMessage(conn, msg, app);
        } catch {
          sendMessage(conn, {
            type: 'error',
            code: 'PARSE_ERROR',
            message: 'Invalid JSON',
            recoverable: true,
          });
        }
      }
    });

    socket.on('close', () => {
      app.log.info({ connId: conn.id }, 'WebSocket disconnected');
      cancelActiveTurn(conn);
      conn.messageLimiter.reset();
      conn.llmLimiter.reset();
      sttRouter.destroy();
      ttsRouter.destroy();
      clearInterval(keepalive);
    });

    socket.on('error', (err) => {
      app.log.error({ connId: conn.id, err }, 'WebSocket error');
    });

    // Keepalive: ping every 30s
    const keepalive = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        clearInterval(keepalive);
        return;
      }
      socket.ping();
    }, KEEPALIVE_INTERVAL_MS);

    socket.on('pong', () => {
      conn.lastPingAt = Date.now();
    });
  });
}
