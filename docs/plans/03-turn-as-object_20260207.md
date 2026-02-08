# Plan 03: Turn-as-Object Refactor

**Author:** state-arch agent
**Date:** 2026-02-07
**Audit item:** #3 — handler.ts is a 742-line monolith
**Depends on:** Plan 02 (Shared State Machine)

---

## Problem

`handler.ts` is 742 lines with deeply nested logic, multiple concerns mixed together, and concurrency bugs:

1. **`processAudioBuffer()` (lines 213-327)** handles audio concatenation, STT invocation, noise filtering, transcript accumulation, re-entry when new audio arrives during STT, silence timer management, and state transitions — all in one function with 5 different return paths.

2. **`runLlmTtsPipeline()` (lines 333-429)** creates 5 event listeners for a single turn, detaches them in a `finally` block, and uses a captured `currentTurnId` as a stale-turn guard. The stale-turn guard is a symptom: the real problem is that there's no lifecycle object that gets discarded when a turn ends.

3. **Concurrency bug:** Two `transcript_send` messages arriving in quick succession can both call `runLlmTtsPipeline()`, running two LLM pipelines in parallel on the same connection. The `currentTurnId` guard partially mitigates this, but both pipelines still execute and consume resources — only the stale one's `onLlmDone` will silently skip the idle transition.

4. **Barge-in is ad-hoc:** Lines 566-577 manually cancel LLM + TTS pipelines, clear transcript, null turnId, force state to idle, and send a turn_state message. This is the same cleanup pattern repeated for `cancel` (lines 579-597) and for error recovery. There's no single place that defines "end a turn."

5. **State leaks between turns:** `conn.pendingTranscript` persists across turns. If a turn ends with an error and the next turn starts before `pendingTranscript` is cleared, the old transcript contaminates the new one. The `cleanup()` function (lines 108-112) exists but is called inconsistently.

## Solution

Model each turn as a self-contained `Turn` object that owns its entire lifecycle. Handler.ts becomes a thin dispatcher that creates turns and cancels the previous one.

## Detailed Design

### The Turn Class

**File: `packages/gateway/src/ws/turn.ts`**

```typescript
import { EventEmitter } from 'events';
import { transition, TurnEvent, TurnState } from '../shared/turn-fsm.js';
import { ServerMessage } from '../types.js';
import { SttRouter } from '../stt/router.js';
import { LlmPipeline } from '../llm/pipeline.js';
import { TtsPipeline } from '../tts/pipeline.js';

export interface TurnDeps {
  connId: string;
  sttRouter: SttRouter;
  llmPipeline: LlmPipeline;
  ttsPipeline: TtsPipeline;
  sendJson: (msg: ServerMessage) => void;
  sendBinary: (data: Buffer) => void;
  logger: { info: Function; warn: Function; error: Function };
}

export type TurnPhase = 'active' | 'completed' | 'cancelled';

/**
 * Encapsulates a single conversational turn.
 *
 * A Turn owns:
 * - its turnId
 * - its audio buffer
 * - its accumulated transcript
 * - its state (via the shared FSM)
 * - its LLM/TTS pipeline wiring
 *
 * Events emitted:
 * - 'state_changed' { from, to, turnId }
 * - 'completed'     { turnId }
 * - 'cancelled'     { turnId }
 * - 'error'         { turnId, error }
 */
export class Turn extends EventEmitter {
  readonly id: string;
  private state: TurnState = 'idle';
  private phase: TurnPhase = 'active';
  private audioBuffer: Buffer[] = [];
  private audioBufferBytes: number = 0;
  private pendingTranscript: string = '';
  private silenceTimer: NodeJS.Timeout | null = null;
  private deps: TurnDeps;

  // Pipeline listener cleanup functions, set during think()
  private pipelineCleanup: (() => void) | null = null;

  constructor(id: string, deps: TurnDeps) {
    super();
    this.id = id;
    this.deps = deps;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  get currentState(): TurnState { return this.state; }
  get isActive(): boolean { return this.phase === 'active'; }

  /**
   * Transition via FSM event. Returns false if the event was
   * ignored (invalid in current state) or if the turn is already
   * completed/cancelled.
   */
  transition(event: TurnEvent): boolean {
    if (this.phase !== 'active') return false;

    const next = transition(this.state, event);
    if (next === null) {
      this.deps.logger.warn({
        connId: this.deps.connId, turnId: this.id,
        state: this.state, event,
      }, 'Turn: ignored event');
      return false;
    }

    const from = this.state;
    this.state = next;
    this.deps.logger.info({
      connId: this.deps.connId, turnId: this.id,
      from, to: next, event,
    }, 'Turn: state transition');

    this.deps.sendJson({
      type: 'turn_state', state: next, turnId: this.id,
    });
    this.emit('state_changed', { from, to: next, turnId: this.id });

    if (next === 'idle') {
      this.complete();
    }
    return true;
  }

  // --- Audio / Listening ---

  /** Append audio data during listening phase. */
  appendAudio(data: Buffer): void {
    if (this.phase !== 'active') return;
    this.audioBuffer.push(data);
    this.audioBufferBytes += data.length;
    this.resetSilenceTimer();
  }

  /** Returns current audio buffer size in bytes. */
  get audioBytes(): number { return this.audioBufferBytes; }

  // --- Transcription ---

  /**
   * Transcribe buffered audio. Called when silence is detected.
   * Handles noise filtering, transcript accumulation, and re-entry
   * if new audio arrived during STT.
   */
  async transcribe(): Promise<void> {
    if (this.phase !== 'active') return;
    if (this.audioBufferBytes === 0) {
      this.deps.logger.warn({ connId: this.deps.connId, turnId: this.id }, 'No audio to transcribe');
      this.transition('STT_EMPTY');
      return;
    }

    if (!this.transition('SILENCE_DETECTED')) return;

    try {
      const audioData = Buffer.concat(this.audioBuffer);
      this.audioBuffer = [];
      this.audioBufferBytes = 0;

      const result = await this.deps.sttRouter.transcribe(audioData);

      if (this.phase !== 'active') return; // cancelled during STT

      const cleaned = cleanSttText(result.text ?? '');
      const noisy = isNoisySegment(cleaned);
      const newSegment = noisy ? '' : cleaned;

      const combined = this.pendingTranscript
        ? newSegment ? `${this.pendingTranscript} ${newSegment}` : this.pendingTranscript
        : newSegment;

      if (!combined) {
        this.pendingTranscript = '';
        this.transition('STT_EMPTY');
        return;
      }

      // If noisy segment but we have prior text, keep existing transcript
      if (!newSegment && this.pendingTranscript) {
        this.deps.sendJson({ type: 'transcript_final', text: this.pendingTranscript, turnId: this.id });
        this.transition('STT_DONE');
        return;
      }

      // New audio arrived during STT — go back to listening
      if (this.audioBufferBytes > 0) {
        this.pendingTranscript = combined;
        this.transition('AUDIO_RESUME');
        this.resetSilenceTimer();
        return;
      }

      // Normal case: send transcript, enter pending_send
      this.pendingTranscript = combined;
      this.deps.sendJson({ type: 'transcript_final', text: combined, turnId: this.id });
      this.transition('STT_DONE');
    } catch (err) {
      this.deps.logger.error({ connId: this.deps.connId, turnId: this.id, err }, 'STT failed');
      this.deps.sendJson({
        type: 'error', code: 'stt_error',
        message: err instanceof Error ? err.message : 'STT failed',
        recoverable: true,
      });
      this.transition('ERROR');
    }
  }

  // --- LLM + TTS ---

  /**
   * Run the LLM + TTS pipeline with the given text.
   * Called on SEND (auto-send or manual) or TEXT_SEND.
   */
  async think(text: string, sessionKey: string): Promise<void> {
    if (this.phase !== 'active') return;

    this.deps.ttsPipeline.reset();

    // Wire up LLM events scoped to this turn
    const onToken = ({ token, fullText }: { token: string; fullText: string }) => {
      if (this.phase !== 'active') return;
      this.deps.sendJson({ type: 'llm_token', token, fullText });
    };

    const onPhraseReady = ({ text: phraseText, index }: { text: string; index: number }) => {
      if (this.phase !== 'active') return;
      this.deps.ttsPipeline.processChunk(phraseText, index, this.id).catch((err) => {
        this.deps.logger.error({ connId: this.deps.connId, turnId: this.id, err }, 'TTS chunk failed');
      });
    };

    const onceFirstPhrase = () => {
      if (this.phase !== 'active') return;
      this.transition('LLM_FIRST_CHUNK');
      this.deps.llmPipeline.off('phrase_ready', onceFirstPhrase);
    };

    const onLlmDone = async ({ fullText, cancelled }: { fullText: string; cancelled?: boolean }) => {
      if (cancelled || this.phase !== 'active') return;

      this.deps.sendJson({ type: 'llm_done', fullText });

      try {
        await this.deps.ttsPipeline.finish();
      } catch (err) {
        this.deps.logger.error({ connId: this.deps.connId, turnId: this.id, err }, 'TTS finish failed');
      }

      if (this.phase !== 'active') return;
      this.transition('LLM_DONE');
    };

    const onLlmError = ({ error }: { error: unknown }) => {
      if (this.phase !== 'active') return;
      this.deps.logger.error({ connId: this.deps.connId, turnId: this.id, error }, 'LLM error');
      this.deps.sendJson({
        type: 'error', code: 'llm_error',
        message: error instanceof Error ? error.message : 'LLM error',
        recoverable: true,
      });
      this.transition('ERROR');
    };

    // Attach listeners
    this.deps.llmPipeline.on('llm_token', onToken);
    this.deps.llmPipeline.on('phrase_ready', onPhraseReady);
    this.deps.llmPipeline.on('phrase_ready', onceFirstPhrase);
    this.deps.llmPipeline.on('llm_done', onLlmDone);
    this.deps.llmPipeline.on('error', onLlmError);

    // Store cleanup function so cancel() can detach them
    this.pipelineCleanup = () => {
      this.deps.llmPipeline.off('llm_token', onToken);
      this.deps.llmPipeline.off('phrase_ready', onPhraseReady);
      this.deps.llmPipeline.off('phrase_ready', onceFirstPhrase);
      this.deps.llmPipeline.off('llm_done', onLlmDone);
      this.deps.llmPipeline.off('error', onLlmError);
    };

    try {
      await this.deps.llmPipeline.sendTranscript(text, sessionKey, this.id);
    } finally {
      if (this.pipelineCleanup) {
        this.pipelineCleanup();
        this.pipelineCleanup = null;
      }
    }
  }

  // --- Cancellation / Completion ---

  /**
   * Cancel this turn. Stops all in-progress work.
   * Safe to call multiple times (idempotent).
   */
  cancel(): void {
    if (this.phase !== 'active') return;
    this.phase = 'cancelled';
    this.clearSilenceTimer();

    // Cancel pipelines
    this.deps.llmPipeline.cancel();
    this.deps.ttsPipeline.cancel();

    // Clean up listeners
    if (this.pipelineCleanup) {
      this.pipelineCleanup();
      this.pipelineCleanup = null;
    }

    this.deps.sendJson({ type: 'turn_state', state: 'idle' });
    this.emit('cancelled', { turnId: this.id });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private complete(): void {
    if (this.phase !== 'active') return;
    this.phase = 'completed';
    this.clearSilenceTimer();
    this.emit('completed', { turnId: this.id });
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.state === 'listening' && this.audioBufferBytes > 0) {
        this.transcribe().catch((err) => {
          this.deps.logger.error({ connId: this.deps.connId, turnId: this.id, err }, 'Transcribe failed');
        });
      }
    }, AUDIO_SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

// -----------------------------------------------------------------------
// STT Helpers (moved from handler.ts)
// -----------------------------------------------------------------------

const AUDIO_SILENCE_TIMEOUT_MS = 1500;

function cleanSttText(raw: string): string {
  return raw.replace(/<unk>/gi, '').replace(/\s{2,}/g, ' ').trim();
}

const NOISE_TOKENS = new Set([
  'm', 'mm', 'mmm', 'mhm', 'hm', 'hmm', 'hn',
  'uh', 'um', 'ah', 'oh', 'eh', 'er',
]);

function isNoisySegment(text: string): boolean {
  if (!text) return true;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.every((w) => NOISE_TOKENS.has(w))) return true;
  const unique = new Set(words);
  if (unique.size === 1 && words.length >= 2 && words[0].length <= 3) return true;
  return false;
}
```

### How handler.ts becomes a thin dispatcher

**File: `packages/gateway/src/ws/handler.ts` (after refactor)**

The handler shrinks from ~742 lines to ~250 lines. It manages:
1. Connection lifecycle (open, close, error, keepalive)
2. Per-connection services (STT router, LLM pipeline, TTS pipeline, rate limiters)
3. Creating/cancelling Turn objects
4. Routing JSON messages to the active turn or handling connection-level concerns (ping, config, command)

```typescript
// Simplified handler structure (pseudocode showing the key pattern)

interface ConnectionState {
  id: string;
  ws: WebSocket;
  config: SessionConfig;
  activeTurn: Turn | null;   // <-- replaces turnState, turnId, audioBuffer, pendingTranscript
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

function handleAudioFrame(conn: ConnectionState, data: Buffer, app: FastifyInstance) {
  // Start new turn if idle
  if (!conn.activeTurn) {
    conn.activeTurn = createTurn(conn, app);
    conn.activeTurn.transition('AUDIO_START');
  }

  const turn = conn.activeTurn;

  // Handle audio during pending_send (resume listening)
  if (turn.currentState === 'pending_send') {
    turn.transition('AUDIO_RESUME');
  } else if (turn.currentState === 'transcribing') {
    // Buffer silently, transcribe() will detect it
    turn.appendAudio(data);
    return;
  } else if (turn.currentState !== 'listening') {
    app.log.warn({ connId: conn.id, state: turn.currentState }, 'Audio in non-listening state');
    return;
  }

  // Buffer overflow check
  if (turn.audioBytes + data.length > MAX_AUDIO_BUFFER_BYTES) {
    sendMessage(conn, { type: 'error', code: 'AUDIO_BUFFER_OVERFLOW', message: '...', recoverable: true });
    cancelActiveTurn(conn);
    return;
  }

  turn.appendAudio(data);
}

function handleTranscriptSend(conn: ConnectionState, msg: ClientMessage, app: FastifyInstance) {
  const turn = conn.activeTurn ?? createTurn(conn, app);
  conn.activeTurn = turn;

  // Text-input: transition directly to thinking
  if (turn.currentState === 'idle') {
    turn.transition('TEXT_SEND');
  } else if (turn.currentState === 'pending_send') {
    turn.transition('SEND');
  } else {
    // Already thinking/speaking — ignore duplicate sends (fixes the concurrency bug!)
    app.log.warn({ connId: conn.id, state: turn.currentState }, 'Ignoring transcript_send in active pipeline');
    return;
  }

  turn.think(msg.text, normalizeSessionKey(conn.config.sessionKey)).catch((err) => {
    app.log.error({ connId: conn.id, err }, 'Pipeline failed');
  });
}

function handleBargeIn(conn: ConnectionState) {
  if (conn.activeTurn) {
    conn.activeTurn.cancel();
    conn.activeTurn = null;
  }
}

function handleCancel(conn: ConnectionState) {
  if (conn.activeTurn) {
    conn.activeTurn.cancel();
    conn.activeTurn = null;
  }
}

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
```

### Key architectural properties

1. **One active turn per connection.** `conn.activeTurn` is either a `Turn` or `null`. Starting a new turn cancels the old one. This makes concurrent pipeline runs impossible by design.

2. **Turn owns its state.** No more `conn.turnState`, `conn.turnId`, `conn.audioBuffer`, `conn.audioBufferBytes`, `conn.pendingTranscript`. All of that lives inside the Turn. ConnectionState only holds connection-level concerns.

3. **Turn owns its cleanup.** Calling `turn.cancel()` stops everything: clears the silence timer, cancels LLM and TTS pipelines, detaches event listeners. No more manual cleanup in 3 different message handlers.

4. **No stale-turn guards.** The `currentTurnId` guard in the current `onLlmDone` callback exists because a new pipeline run could start while the old one's `onLlmDone` fires. With the Turn object, `cancel()` sets `phase = 'cancelled'` and every callback checks `this.phase !== 'active'` before doing anything. The old Turn's callbacks become no-ops immediately.

5. **Silence timer is per-turn.** No more global `silenceTimers` Map. Each Turn manages its own timer. When the Turn is cancelled, the timer is cleared automatically.

### How barge-in works

```
User speaks during TTS playback
  -> Client sends { type: 'barge_in' }
  -> handler.handleBargeIn(conn)
    -> conn.activeTurn.cancel()
      -> Sets phase = 'cancelled'
      -> Calls llmPipeline.cancel() and ttsPipeline.cancel()
      -> Clears silence timer
      -> Detaches pipeline listeners
      -> Sends { type: 'turn_state', state: 'idle' }
      -> Emits 'cancelled' event
    -> conn.activeTurn = null

If audio frames arrive immediately after barge-in (because user is speaking):
  -> handleAudioFrame sees conn.activeTurn === null
  -> Creates new Turn
  -> new Turn transitions AUDIO_START (idle -> listening)
  -> User's speech is captured in the new Turn
```

### How the concurrency bug is fixed

Current bug: Two `transcript_send` messages arrive quickly. Both call `runLlmTtsPipeline()`, creating two parallel LLM streams.

With Turn objects:
```
First transcript_send arrives:
  -> turn.transition('SEND') succeeds (pending_send -> thinking)
  -> turn.think() starts LLM pipeline

Second transcript_send arrives 50ms later:
  -> turn.currentState is 'thinking'
  -> Handler logs warning: "Ignoring transcript_send in active pipeline"
  -> Second send is dropped. No concurrent pipelines.
```

### Integration with Plan 02 (Shared State Machine)

The Turn class calls `transition()` from `shared/turn-fsm.ts`:
```typescript
import { transition, TurnEvent, TurnState } from '../shared/turn-fsm.js';
```

The Turn's `transition()` method wraps the pure function with side effects (logging, sending turn_state messages, checking phase). The FSM is the single source of truth for what transitions are valid.

## File Changes Summary

| Action | File | Description |
|--------|------|-------------|
| **Create** | `packages/gateway/src/ws/turn.ts` | Turn class (~200 lines) |
| **Create** | `packages/gateway/src/ws/__tests__/turn.test.ts` | Unit tests for Turn |
| **Modify** | `packages/gateway/src/ws/handler.ts` | Thin dispatcher (~250 lines, down from 742) |
| **Modify** | `packages/gateway/src/ws/__tests__/handler-pipeline.test.ts` | May need minor adjustments if internal behavior timing changes |

### What moves where

| From `handler.ts` | To |
|---|---|
| `processAudioBuffer()` (lines 213-327) | `Turn.transcribe()` |
| `runLlmTtsPipeline()` (lines 333-429) | `Turn.think()` |
| `handleAudioFrame()` (lines 438-502) | Stays in handler.ts but delegates to `turn.appendAudio()` |
| `cleanSttText()`, `isNoisySegment()`, `NOISE_TOKENS` | `turn.ts` (module-level helpers) |
| `silenceTimers` Map (line 436) | `Turn.silenceTimer` (per-instance) |
| `AUDIO_SILENCE_TIMEOUT_MS` (line 57) | `turn.ts` constant |
| `ConnectionState.turnState/turnId/audioBuffer/pendingTranscript` | `Turn` instance fields |
| `cleanup()` function (lines 108-112) | `Turn.cancel()` / Turn constructor reset |

### What stays in handler.ts

- Connection lifecycle (open, close, error, keepalive)
- Rate limiting (connection-level concern)
- Ping/pong
- Config handling
- Command routing
- Chat history hydration
- `sendMessage()` / `sendBinary()` helpers
- `createTurn()` factory
- WebSocket route registration

## Testing Strategy

### New test: `packages/gateway/src/ws/__tests__/turn.test.ts`

The Turn class can be tested in isolation with mocked dependencies:

```typescript
describe('Turn', () => {
  let turn: Turn;
  let mockDeps: TurnDeps;

  beforeEach(() => {
    mockDeps = {
      connId: 'test-conn',
      sttRouter: { transcribe: vi.fn() } as any,
      llmPipeline: {
        on: vi.fn(), off: vi.fn(), cancel: vi.fn(),
        sendTranscript: vi.fn(),
      } as any,
      ttsPipeline: {
        reset: vi.fn(), cancel: vi.fn(),
        processChunk: vi.fn(), finish: vi.fn(),
        on: vi.fn(),
      } as any,
      sendJson: vi.fn(),
      sendBinary: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    turn = new Turn('turn-1', mockDeps);
  });

  describe('transition()', () => {
    it('AUDIO_START from idle transitions to listening', () => {
      expect(turn.transition('AUDIO_START')).toBe(true);
      expect(turn.currentState).toBe('listening');
      expect(mockDeps.sendJson).toHaveBeenCalledWith({
        type: 'turn_state', state: 'listening', turnId: 'turn-1',
      });
    });

    it('ignores events after cancel', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      expect(turn.transition('SILENCE_DETECTED')).toBe(false);
    });
  });

  describe('transcribe()', () => {
    it('transitions to pending_send on successful STT', async () => {
      (mockDeps.sttRouter.transcribe as any).mockResolvedValue({
        text: 'hello world', confidence: 0.95, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.currentState).toBe('pending_send');
    });

    it('transitions to idle on empty transcript', async () => {
      (mockDeps.sttRouter.transcribe as any).mockResolvedValue({
        text: '', confidence: 0, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.isActive).toBe(false); // completed -> idle
    });

    it('discards noise segments', async () => {
      (mockDeps.sttRouter.transcribe as any).mockResolvedValue({
        text: 'um uh mm', confidence: 0.3, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.isActive).toBe(false); // noise -> idle
    });
  });

  describe('cancel()', () => {
    it('cancels LLM and TTS pipelines', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      expect(mockDeps.llmPipeline.cancel).toHaveBeenCalled();
      expect(mockDeps.ttsPipeline.cancel).toHaveBeenCalled();
      expect(turn.isActive).toBe(false);
    });

    it('is idempotent', () => {
      turn.cancel();
      turn.cancel();
      // No double-cancel errors
      expect(mockDeps.llmPipeline.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('think()', () => {
    it('wires up LLM events and cleans up after completion', async () => {
      // Test that listeners are attached and detached
    });
  });
});
```

Key advantage: these tests don't need a WebSocket server, fake timers for silence detection can be used directly, and each test is fast and isolated.

### Existing handler-pipeline tests

The integration tests in `handler-pipeline.test.ts` test the observable WebSocket behavior and should continue to pass. The same sequence of messages arrives at the client regardless of whether the logic lives in handler.ts functions or in Turn methods.

If timing changes slightly (e.g., because cancellation is more immediate), some test timeouts may need adjustment, but the assertions themselves should hold.

## Migration Steps

**Prerequisite:** Plan 02 (shared state machine) is implemented first, so `turn-fsm.ts` exists.

1. **Create `turn.ts`** with the Turn class, STT helpers, and constants.
2. **Create `__tests__/turn.test.ts`** with unit tests. Run and verify.
3. **Modify `handler.ts` — Phase 1: Audio handling.**
   - Add `activeTurn: Turn | null` to `ConnectionState`.
   - Modify `handleAudioFrame()` to create/delegate to Turn.
   - Keep the old `processAudioBuffer()` and `runLlmTtsPipeline()` temporarily.
   - Run tests.
4. **Modify `handler.ts` — Phase 2: Transcription.**
   - Remove `processAudioBuffer()`. The Turn's silence timer calls `turn.transcribe()`.
   - Remove `silenceTimers` Map and the `AUDIO_SILENCE_TIMEOUT_MS` constant.
   - Run tests.
5. **Modify `handler.ts` — Phase 3: LLM/TTS pipeline.**
   - Remove `runLlmTtsPipeline()`. `handleTranscriptSend()` calls `turn.think()`.
   - Run tests.
6. **Modify `handler.ts` — Phase 4: Barge-in and cancel.**
   - Simplify barge-in and cancel to `cancelActiveTurn(conn)`.
   - Remove all direct `conn.turnState = '...'` assignments.
   - Run tests.
7. **Clean up `ConnectionState`.**
   - Remove `turnState`, `turnId`, `audioBuffer`, `audioBufferBytes`, `pendingTranscript`.
   - Remove `cleanup()` function.
   - Run full test suite.
8. **Final verification.**
   ```bash
   cd packages/gateway && npm test
   npm run typecheck
   ```

Each phase is a separate commit. If any phase breaks tests, it can be reverted independently.

## Risks

1. **EventEmitter listener management.** The Turn attaches listeners to `llmPipeline` (which is shared per-connection, not per-turn). If `cancel()` doesn't properly detach listeners before a new Turn attaches its own, events could leak. Mitigated by: `pipelineCleanup` is always called in the `finally` block of `think()` and also in `cancel()`.

2. **TtsPipeline is also shared per-connection.** The Turn calls `ttsPipeline.reset()` at the start of `think()` and `ttsPipeline.cancel()` on cancel. The generation counter in TtsPipeline already handles stale synthesis results. No structural change needed.

3. **Handler-pipeline test timing.** The tests use `collectMessages()` with timeouts. If the Turn object processes messages at a slightly different pace (e.g., one fewer tick for state transitions), some timeout-sensitive tests might need adjustment. Mitigated by: running tests after each migration phase.

4. **Interaction with Plan 04 (Streaming STT).** Plan 04 originally wires RollingWindowSTT into handler.ts (`conn.rollingWindow`), but handler.ts is gutted by this refactor. **Resolution (agreed via cross-review):** RollingWindowSTT should be wired into the Turn object, not ConnectionState. Specifically:
   - Turn constructor receives `ParakeetClient` (or a `RollingWindowSTT` instance) via `TurnDeps`
   - `Turn.transition('AUDIO_START')` calls `rollingWindow.start()`
   - `Turn.appendAudio()` feeds data to both `this.audioBuffer` and `rollingWindow.appendAudio()`
   - Turn wires `rollingWindow.on('transcript_partial', ...)` to emit partials via `deps.sendJson()`
   - `Turn.transcribe()` calls `rollingWindow.stop()` to get full audio, then `sttRouter.transcribe()` for finalize
   - `Turn.cancel()` calls `rollingWindow.reset()`
   This is additive to the Turn class and does not change the Turn's public API or the handler's structure.

5. **Interaction with Plan 05 (TTS pipeline refactor).** The TTS pipeline refactor changes the internal implementation of TtsPipeline but not its public API (`processChunk`, `finish`, `cancel`, `reset`). The Turn class interacts with TtsPipeline only through this public API. No conflict. Plan 05's `all_failed` event wiring moves from handler.ts to the Turn's `think()` method or the connection-level TtsPipeline setup.

6. **Error handling completeness.** The Turn must handle every error path that handler.ts currently handles (STT failure, LLM failure, TTS failure, buffer overflow). The `phase` check (`if this.phase !== 'active'`) in every callback ensures stale callbacks are safe. The explicit `try/catch` in `transcribe()` and the `finally` in `think()` ensure cleanup.
