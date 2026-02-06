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
import { ParakeetClient } from '../stt/parakeet-client.js';
import { SttRouter } from '../stt/router.js';
import { GatewayClient } from '../llm/gateway-client.js';
import { LlmPipeline } from '../llm/pipeline.js';
import { KokoroClient } from '../tts/kokoro-client.js';
import { OpenAiTtsClient } from '../tts/openai-client.js';
import { TtsRouter } from '../tts/router.js';
import { TtsPipeline } from '../tts/pipeline.js';

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
  sttRouter: SttRouter;
  llmPipeline: LlmPipeline;
  ttsPipeline: TtsPipeline;
  gatewayClient: GatewayClient;
}

const MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT_MSG_PER_SEC = 100;
const RATE_LIMIT_LLM_PER_MIN = 30;
const KEEPALIVE_INTERVAL_MS = 30_000;

// Audio-silence timeout: if no new audio arrives for this long during
// LISTENING, auto-transition to transcribing.
const AUDIO_SILENCE_TIMEOUT_MS = 1500;

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
// Audio Processing: transcribe buffered audio and send results
// ---------------------------------------------------------------------------

async function processAudioBuffer(
  conn: ConnectionState,
  app: FastifyInstance,
) {
  if (conn.audioBufferBytes === 0) {
    app.log.warn({ connId: conn.id }, 'No audio to transcribe');
    transitionState(conn, 'idle', app);
    return;
  }

  if (!transitionState(conn, 'transcribing', app)) return;

  const turnId = conn.turnId ?? crypto.randomUUID();
  conn.turnId = turnId;

  try {
    const audioData = Buffer.concat(conn.audioBuffer);
    cleanup(conn);

    const result = await conn.sttRouter.transcribe(audioData);
    app.log.info(
      { connId: conn.id, turnId, text: result.text, confidence: result.confidence },
      'Transcription complete',
    );

    if (!result.text || result.text.trim().length === 0) {
      // Empty transcript — go back to idle
      app.log.info({ connId: conn.id }, 'Empty transcript, returning to idle');
      conn.turnId = null;
      transitionState(conn, 'idle', app);
      return;
    }

    sendMessage(conn, {
      type: 'transcript_final',
      text: result.text,
      turnId,
    });
    transitionState(conn, 'pending_send', app);
  } catch (err) {
    app.log.error({ connId: conn.id, err }, 'STT failed');
    sendMessage(conn, {
      type: 'error',
      code: 'stt_error',
      message: err instanceof Error ? err.message : 'STT failed',
      recoverable: true,
    });
    // Return to idle on STT failure
    conn.turnId = null;
    transitionState(conn, 'idle', app);
  }
}

// ---------------------------------------------------------------------------
// LLM + TTS Pipeline: send transcript, stream tokens, synthesize audio
// ---------------------------------------------------------------------------

async function runLlmTtsPipeline(
  conn: ConnectionState,
  text: string,
  turnId: string,
  app: FastifyInstance,
) {
  // For text-input sends, we may be in idle (which can't transition to thinking).
  // Force the state for this case.
  if (conn.turnState === 'idle' || conn.turnState === 'listening' || conn.turnState === 'transcribing') {
    app.log.info({ connId: conn.id, from: conn.turnState, to: 'thinking' }, 'State transition (text-input)');
    conn.turnState = 'thinking';
    sendMessage(conn, { type: 'turn_state', state: 'thinking', turnId: conn.turnId ?? undefined });
  } else if (!transitionState(conn, 'thinking', app)) {
    return;
  }

  conn.ttsPipeline.reset();

  // Wire up LLM events for this turn
  const onToken = ({ token, fullText }: { token: string; fullText: string }) => {
    sendMessage(conn, { type: 'llm_token', token, fullText });
  };
  const onPhraseReady = ({ text: phraseText, index }: { text: string; index: number; turnId?: string }) => {
    conn.ttsPipeline.processChunk(phraseText, index, turnId).catch((err) => {
      app.log.error({ connId: conn.id, err }, 'TTS chunk processing failed');
    });
  };
  const onLlmDone = async ({ fullText, cancelled }: { fullText: string; cancelled?: boolean }) => {
    if (cancelled) return; // cancel/barge-in handler manages state directly

    sendMessage(conn, { type: 'llm_done', fullText });

    // Finish TTS pipeline (wait for all queued chunks to complete)
    try {
      await conn.ttsPipeline.finish();
    } catch (err) {
      app.log.error({ connId: conn.id, err }, 'TTS finish failed');
    }

    // Transition to idle after TTS completes
    if (conn.turnState === 'speaking' || conn.turnState === 'thinking') {
      conn.turnState = 'idle';
      conn.turnId = null;
      sendMessage(conn, { type: 'turn_state', state: 'idle' });
    }
  };
  const onLlmError = ({ error }: { error: unknown; turnId: string }) => {
    app.log.error({ connId: conn.id, error }, 'LLM pipeline error');
    sendMessage(conn, {
      type: 'error',
      code: 'llm_error',
      message: error instanceof Error ? error.message : 'LLM error',
      recoverable: true,
    });
    conn.turnState = 'idle';
    conn.turnId = null;
    sendMessage(conn, { type: 'turn_state', state: 'idle' });
  };

  conn.llmPipeline.on('llm_token', onToken);
  conn.llmPipeline.on('phrase_ready', onPhraseReady);
  conn.llmPipeline.on('llm_done', onLlmDone);
  conn.llmPipeline.on('error', onLlmError);

  // Transition to speaking state when first phrase goes to TTS
  const oncePhrase = () => {
    if (conn.turnState === 'thinking') {
      transitionState(conn, 'speaking', app);
    }
    conn.llmPipeline.off('phrase_ready', oncePhrase);
  };
  conn.llmPipeline.on('phrase_ready', oncePhrase);

  try {
    await conn.llmPipeline.sendTranscript(
      text,
      conn.config.sessionKey || 'default',
      turnId,
    );
  } finally {
    conn.llmPipeline.off('llm_token', onToken);
    conn.llmPipeline.off('phrase_ready', onPhraseReady);
    conn.llmPipeline.off('phrase_ready', oncePhrase); // Clean up one-shot listener
    conn.llmPipeline.off('llm_done', onLlmDone);
    conn.llmPipeline.off('error', onLlmError);
  }
}

// ---------------------------------------------------------------------------
// Binary Frame Handling
// ---------------------------------------------------------------------------

// Per-connection silence timers
const silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function handleAudioFrame(
  conn: ConnectionState,
  data: Buffer,
  app: FastifyInstance,
) {
  if (conn.turnState === 'idle') {
    // Implicit start of listening when audio arrives in idle state
    cleanup(conn); // Clear any leftover audio from a previous turn
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

  // Reset silence timer — when no audio arrives for AUDIO_SILENCE_TIMEOUT_MS,
  // auto-transition to transcribing. This handles the case where the client
  // sends a complete WAV blob from VAD onSpeechEnd.
  const existing = silenceTimers.get(conn.id);
  if (existing) clearTimeout(existing);
  silenceTimers.set(
    conn.id,
    setTimeout(() => {
      silenceTimers.delete(conn.id);
      if (conn.turnState === 'listening' && conn.audioBufferBytes > 0) {
        processAudioBuffer(conn, app).catch((err) => {
          app.log.error({ connId: conn.id, err }, 'Audio processing failed');
        });
      }
    }, AUDIO_SILENCE_TIMEOUT_MS),
  );
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
      // Clear any pending silence timer to prevent double-processing
      const pendingSilence = silenceTimers.get(conn.id);
      if (pendingSilence) {
        clearTimeout(pendingSilence);
        silenceTimers.delete(conn.id);
      }
      conn.turnId = msg.turnId;
      cleanup(conn); // Clear audio buffer since we have the final text
      runLlmTtsPipeline(conn, msg.text, msg.turnId, app).catch((err) => {
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
      // Stop TTS/LLM, transition to idle
      app.log.info({ connId: conn.id }, 'Barge-in received');
      if (conn.turnState === 'speaking' || conn.turnState === 'thinking') {
        conn.llmPipeline.cancel();
        conn.ttsPipeline.cancel();
        conn.turnId = null;
        // Force state to idle (bypass normal transition validation for barge-in)
        conn.turnState = 'idle';
        sendMessage(conn, { type: 'turn_state', state: 'idle' });
      }
      break;

    case 'cancel': {
      // Abort current pipeline, transition to idle
      app.log.info({ connId: conn.id, state: conn.turnState }, 'Cancel received');
      // Clear any pending silence timer
      const cancelSilence = silenceTimers.get(conn.id);
      if (cancelSilence) {
        clearTimeout(cancelSilence);
        silenceTimers.delete(conn.id);
      }
      if (conn.turnState !== 'idle') {
        conn.llmPipeline.cancel();
        conn.ttsPipeline.cancel();
        cleanup(conn);
        conn.turnId = null;
        // Force state to idle (bypass normal transition validation for cancel)
        conn.turnState = 'idle';
        sendMessage(conn, { type: 'turn_state', state: 'idle' });
      }
      break;
    }

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
      turnState: 'idle',
      turnId: null,
      audioBuffer: [],
      audioBufferBytes: 0,
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
      // Cancel in-progress pipelines to prevent work on a dead connection
      conn.llmPipeline.cancel();
      conn.ttsPipeline.cancel();
      cleanup(conn);
      conn.messageLimiter.reset();
      conn.llmLimiter.reset();
      sttRouter.destroy();
      const silenceTimer = silenceTimers.get(conn.id);
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimers.delete(conn.id);
      }
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
