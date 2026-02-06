import { FastifyInstance } from 'fastify';
import { WebSocket, RawData } from 'ws';
import {
  ClientMessage,
  ServerMessage,
  SessionConfig,
  TurnState,
  VALID_TRANSITIONS,
  DEFAULT_CONFIG,
} from '../types.js';
import { executeCommand } from './commands.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

// ---------------------------------------------------------------------------
// Connection State
// ---------------------------------------------------------------------------

interface ConnectionState {
  id: string;
  ws: WebSocket;
  config: SessionConfig;
  turnState: TurnState;
  turnId: string | null;
  audioBuffer: Buffer[];
  audioBufferBytes: number;
  connectedAt: number;
  lastPingAt: number;
  messageLimiter: SlidingWindowRateLimiter;
  llmLimiter: SlidingWindowRateLimiter;
}

const MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT_MSG_PER_SEC = 100;
const RATE_LIMIT_LLM_PER_MIN = 30;
const KEEPALIVE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

function transitionState(
  conn: ConnectionState,
  to: TurnState,
  app: FastifyInstance,
): boolean {
  const allowed = VALID_TRANSITIONS[conn.turnState];
  if (!allowed.includes(to)) {
    app.log.warn(
      { connId: conn.id, from: conn.turnState, to },
      'Invalid state transition',
    );
    return false;
  }
  app.log.info({ connId: conn.id, from: conn.turnState, to }, 'State transition');
  conn.turnState = to;
  sendMessage(conn, { type: 'turn_state', state: to, turnId: conn.turnId ?? undefined });
  return true;
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

function cleanup(conn: ConnectionState) {
  conn.audioBuffer = [];
  conn.audioBufferBytes = 0;
}

// ---------------------------------------------------------------------------
// Binary Frame Handling
// ---------------------------------------------------------------------------

function handleAudioFrame(
  conn: ConnectionState,
  data: Buffer,
  app: FastifyInstance,
) {
  if (conn.turnState === 'idle') {
    // Implicit start of listening when audio arrives in idle state
    conn.turnId = crypto.randomUUID();
    if (!transitionState(conn, 'listening', app)) return;
  }

  if (conn.turnState !== 'listening') {
    app.log.warn(
      { connId: conn.id, state: conn.turnState },
      'Audio frame received in non-listening state, discarding',
    );
    return;
  }

  // Guard against excessive buffering
  if (conn.audioBufferBytes + data.length > MAX_AUDIO_BUFFER_BYTES) {
    sendMessage(conn, {
      type: 'error',
      code: 'AUDIO_BUFFER_OVERFLOW',
      message: 'Audio buffer exceeded 10 MB limit',
      recoverable: true,
    });
    conn.audioBuffer = [];
    conn.audioBufferBytes = 0;
    transitionState(conn, 'idle', app);
    return;
  }

  conn.audioBuffer.push(data);
  conn.audioBufferBytes += data.length;

  // Future: forward to STT rolling-window processor
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

    case 'transcript_send':
      if (!conn.llmLimiter.check()) {
        sendMessage(conn, {
          type: 'error',
          code: 'LLM_RATE_LIMITED',
          message: `LLM rate limit exceeded (${RATE_LIMIT_LLM_PER_MIN}/min). Please wait before sending again.`,
          recoverable: true,
        });
        return;
      }
      // Future: forward to LLM pipeline
      app.log.info(
        { connId: conn.id, turnId: msg.turnId },
        'Received transcript_send',
      );
      break;

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
      // Stop TTS, transition to idle
      app.log.info({ connId: conn.id }, 'Barge-in received');
      if (conn.turnState === 'speaking') {
        conn.turnId = null;
        transitionState(conn, 'idle', app);
      }
      break;

    case 'cancel':
      // Abort current pipeline, transition to idle
      app.log.info({ connId: conn.id, state: conn.turnState }, 'Cancel received');
      if (conn.turnState !== 'idle') {
        cleanup(conn);
        conn.turnId = null;
        // Force state to idle (bypass normal transition validation for cancel)
        conn.turnState = 'idle';
        sendMessage(conn, { type: 'turn_state', state: 'idle' });
      }
      break;

    case 'config':
      // Merge partial config
      Object.assign(conn.config, msg.settings);
      app.log.info(
        { connId: conn.id, config: conn.config },
        'Config updated',
      );
      break;

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
    const conn: ConnectionState = {
      id: crypto.randomUUID(),
      ws: socket,
      config: { ...DEFAULT_CONFIG },
      turnState: 'idle',
      turnId: null,
      audioBuffer: [],
      audioBufferBytes: 0,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      messageLimiter: new SlidingWindowRateLimiter(RATE_LIMIT_MSG_PER_SEC, 1_000),
      llmLimiter: new SlidingWindowRateLimiter(RATE_LIMIT_LLM_PER_MIN, 60_000),
    };

    app.log.info({ connId: conn.id }, 'WebSocket connected');

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
      cleanup(conn);
      conn.messageLimiter.reset();
      conn.llmLimiter.reset();
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
