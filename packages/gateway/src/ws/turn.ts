import { EventEmitter } from 'events';
import { transition, TurnEvent, TurnState } from '../shared/turn-fsm.js';
import { ServerMessage } from '../types.js';
import { SttRouter } from '../stt/router.js';
import { LlmPipeline } from '../llm/pipeline.js';
import { TtsPipeline } from '../tts/pipeline.js';

// ---------------------------------------------------------------------------
// Dependencies injected by handler.ts
// ---------------------------------------------------------------------------

export interface TurnDeps {
  connId: string;
  sttRouter: SttRouter;
  llmPipeline: LlmPipeline;
  ttsPipeline: TtsPipeline;
  sendJson: (msg: ServerMessage) => void;
  sendBinary: (data: Buffer) => void;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export type TurnPhase = 'active' | 'completed' | 'cancelled';

// ---------------------------------------------------------------------------
// STT Helpers
// ---------------------------------------------------------------------------

const AUDIO_SILENCE_TIMEOUT_MS = 1500;

/** Strip STT artefacts like `<unk>` tokens that Parakeet emits for noise. */
function cleanSttText(raw: string): string {
  return raw.replace(/<unk>/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/** Common filler/noise tokens that Parakeet emits for non-speech audio. */
const NOISE_TOKENS = new Set([
  'm', 'mm', 'mmm', 'mhm', 'hm', 'hmm', 'hn',
  'uh', 'um', 'ah', 'oh', 'eh', 'er',
]);

/**
 * Detect if a cleaned STT segment is likely noise (cough, throat clear, etc.)
 * rather than intentional speech. Returns true if the segment should be discarded.
 */
function isNoisySegment(text: string): boolean {
  if (!text) return true;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.every((w) => NOISE_TOKENS.has(w))) return true;
  const unique = new Set(words);
  if (unique.size === 1 && words.length >= 2 && words[0].length <= 3) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Turn Class
// ---------------------------------------------------------------------------

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
 */
export class Turn extends EventEmitter {
  readonly id: string;
  private state: TurnState = 'idle';
  private phase: TurnPhase = 'active';
  private audioBuffer: Buffer[] = [];
  private audioBufferBytes: number = 0;
  private pendingTranscript: string = '';
  private silenceTimer: NodeJS.Timeout | null = null;
  private pipelineCleanup: (() => void) | null = null;
  private deps: TurnDeps;

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
  get audioBytes(): number { return this.audioBufferBytes; }

  /**
   * Transition via FSM event. Returns false if the event was
   * ignored (invalid in current state) or if the turn is already
   * completed/cancelled.
   */
  transition(event: TurnEvent): boolean {
    if (this.phase !== 'active') return false;

    const next = transition(this.state, event);
    if (next === null) {
      this.deps.logger.warn(
        { connId: this.deps.connId, turnId: this.id, state: this.state, event },
        'Turn: ignored event',
      );
      return false;
    }

    const from = this.state;
    this.state = next;
    this.deps.logger.info(
      { connId: this.deps.connId, turnId: this.id, from, to: next, event },
      'Turn: state transition',
    );

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

  // --- Transcription ---

  /**
   * Transcribe buffered audio. Called when silence is detected (via the
   * internal silence timer) or externally by the handler.
   */
  async transcribe(): Promise<void> {
    if (this.phase !== 'active') return;
    if (this.audioBufferBytes === 0) {
      this.deps.logger.warn({ connId: this.deps.connId, turnId: this.id }, 'No audio to transcribe');
      // If we're in listening (not yet transcribing), use CANCEL to return to idle.
      // STT_EMPTY is only valid from transcribing state.
      if (this.state === 'listening') {
        this.transition('CANCEL');
      } else {
        this.transition('STT_EMPTY');
      }
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

      this.deps.logger.info(
        { connId: this.deps.connId, turnId: this.id, raw: result.text, cleaned, noisy, kept: newSegment },
        'STT cleaned',
      );

      const combined = this.pendingTranscript
        ? newSegment ? `${this.pendingTranscript} ${newSegment}` : this.pendingTranscript
        : newSegment;

      if (!combined) {
        this.pendingTranscript = '';
        this.transition('STT_EMPTY');
        return;
      }

      // Noisy segment but prior text exists — keep existing transcript
      if (!newSegment && this.pendingTranscript) {
        this.deps.sendJson({ type: 'transcript_final', text: this.pendingTranscript, turnId: this.id });
        this.transition('STT_DONE');
        return;
      }

      // New audio arrived during STT — go back to listening
      if (this.audioBufferBytes > 0) {
        this.pendingTranscript = combined;
        this.deps.logger.info(
          { connId: this.deps.connId, turnId: this.id, pendingTranscript: combined },
          'New audio arrived during STT, returning to listening',
        );
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
        type: 'error',
        code: 'stt_error',
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
        type: 'error',
        code: 'llm_error',
        message: error instanceof Error ? error.message : 'LLM error',
        recoverable: true,
      });
      this.transition('ERROR');
    };

    this.deps.llmPipeline.on('llm_token', onToken);
    this.deps.llmPipeline.on('phrase_ready', onPhraseReady);
    this.deps.llmPipeline.on('phrase_ready', onceFirstPhrase);
    this.deps.llmPipeline.on('llm_done', onLlmDone);
    this.deps.llmPipeline.on('error', onLlmError);

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

    this.deps.llmPipeline.cancel();
    this.deps.ttsPipeline.cancel();

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
          this.deps.logger.error(
            { connId: this.deps.connId, turnId: this.id, err },
            'Transcribe failed',
          );
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
