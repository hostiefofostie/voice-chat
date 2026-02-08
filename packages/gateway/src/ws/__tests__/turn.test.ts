import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Turn, TurnDeps } from '../turn.js';

function makeMockDeps(): TurnDeps {
  return {
    connId: 'test-conn',
    sttRouter: { transcribe: vi.fn() } as any,
    llmPipeline: {
      on: vi.fn(),
      off: vi.fn(),
      cancel: vi.fn(),
      sendTranscript: vi.fn().mockResolvedValue(undefined),
    } as any,
    ttsPipeline: {
      reset: vi.fn(),
      cancel: vi.fn(),
      processChunk: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    } as any,
    sendJson: vi.fn(),
    sendBinary: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('Turn', () => {
  let turn: Turn;
  let deps: TurnDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = makeMockDeps();
    turn = new Turn('turn-1', deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  describe('transition()', () => {
    it('AUDIO_START from idle -> listening', () => {
      expect(turn.transition('AUDIO_START')).toBe(true);
      expect(turn.currentState).toBe('listening');
      expect(deps.sendJson).toHaveBeenCalledWith({
        type: 'turn_state', state: 'listening', turnId: 'turn-1',
      });
    });

    it('emits state_changed event', () => {
      const handler = vi.fn();
      turn.on('state_changed', handler);
      turn.transition('AUDIO_START');
      expect(handler).toHaveBeenCalledWith({
        from: 'idle', to: 'listening', turnId: 'turn-1',
      });
    });

    it('returns false for invalid events', () => {
      expect(turn.transition('SEND')).toBe(false);
      expect(turn.currentState).toBe('idle');
    });

    it('ignores events after cancel', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      expect(turn.transition('SILENCE_DETECTED')).toBe(false);
    });

    it('ignores events after completion', () => {
      // CANCEL from listening -> idle -> completes the turn
      turn.transition('AUDIO_START');
      turn.transition('CANCEL');
      expect(turn.isActive).toBe(false);
      expect(turn.transition('AUDIO_START')).toBe(false);
    });

    it('TEXT_SEND from idle -> thinking', () => {
      expect(turn.transition('TEXT_SEND')).toBe(true);
      expect(turn.currentState).toBe('thinking');
    });
  });

  // -----------------------------------------------------------------------
  // Audio handling
  // -----------------------------------------------------------------------

  describe('appendAudio()', () => {
    it('accumulates audio bytes', () => {
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      turn.appendAudio(Buffer.alloc(200));
      expect(turn.audioBytes).toBe(300);
    });

    it('ignores audio after cancel', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      turn.appendAudio(Buffer.alloc(100));
      expect(turn.audioBytes).toBe(0);
    });

    it('resets silence timer on each append', () => {
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      // Advance less than timeout
      vi.advanceTimersByTime(1000);
      turn.appendAudio(Buffer.alloc(100));
      // Advance another 1000ms (total 2000 from first append but only 1000 from last)
      vi.advanceTimersByTime(1000);
      // Should not have triggered transcribe yet (1500ms from last append)
      expect(deps.sttRouter.transcribe).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Silence timer -> transcribe
  // -----------------------------------------------------------------------

  describe('silence timer', () => {
    it('triggers transcribe after 1500ms of silence', async () => {
      (deps.sttRouter.transcribe as any).mockResolvedValue({
        text: 'hello world', confidence: 0.95, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));

      await vi.advanceTimersByTimeAsync(1500);

      expect(deps.sttRouter.transcribe).toHaveBeenCalledTimes(1);
    });

    it('does not trigger if turn is cancelled before timeout', () => {
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      turn.cancel();
      vi.advanceTimersByTime(2000);
      expect(deps.sttRouter.transcribe).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Transcription
  // -----------------------------------------------------------------------

  describe('transcribe()', () => {
    it('transitions to pending_send on successful STT', async () => {
      (deps.sttRouter.transcribe as any).mockResolvedValue({
        text: 'hello world', confidence: 0.95, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.currentState).toBe('pending_send');
      expect(deps.sendJson).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'transcript_final', text: 'hello world' }),
      );
    });

    it('transitions to idle on empty transcript', async () => {
      (deps.sttRouter.transcribe as any).mockResolvedValue({
        text: '', confidence: 0, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.isActive).toBe(false);
    });

    it('discards noise segments', async () => {
      (deps.sttRouter.transcribe as any).mockResolvedValue({
        text: 'um uh mm', confidence: 0.3, segments: [],
      });
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.isActive).toBe(false); // noise -> idle
    });

    it('transitions to idle via CANCEL when no audio buffered from listening', async () => {
      turn.transition('AUDIO_START');
      // No audio appended
      await turn.transcribe();
      expect(turn.isActive).toBe(false);
      expect(deps.sttRouter.transcribe).not.toHaveBeenCalled();
    });

    it('handles STT error gracefully', async () => {
      (deps.sttRouter.transcribe as any).mockRejectedValue(new Error('Parakeet down'));
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.isActive).toBe(false);
      expect(deps.sendJson).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', code: 'stt_error' }),
      );
    });

    it('accumulates transcript across segments', async () => {
      (deps.sttRouter.transcribe as any)
        .mockResolvedValueOnce({ text: 'first part', confidence: 0.9, segments: [] })
        .mockResolvedValueOnce({ text: 'second part', confidence: 0.9, segments: [] });

      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      // Now in pending_send with "first part"
      expect(turn.currentState).toBe('pending_send');

      // Simulate user resuming speech (audio during pending_send)
      turn.transition('AUDIO_RESUME');
      expect(turn.currentState).toBe('listening');

      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      // Should combine: "first part second part"
      expect(turn.currentState).toBe('pending_send');
      const finalCalls = (deps.sendJson as any).mock.calls
        .filter((c: any) => c[0].type === 'transcript_final');
      expect(finalCalls[finalCalls.length - 1][0].text).toBe('first part second part');
    });

    it('keeps existing transcript on noisy segment when prior text exists', async () => {
      (deps.sttRouter.transcribe as any)
        .mockResolvedValueOnce({ text: 'real words', confidence: 0.9, segments: [] })
        .mockResolvedValueOnce({ text: 'um mm uh', confidence: 0.3, segments: [] });

      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();
      expect(turn.currentState).toBe('pending_send');

      // Resume and get noise
      turn.transition('AUDIO_RESUME');
      turn.appendAudio(Buffer.alloc(100));
      await turn.transcribe();

      // Should keep "real words" and return to pending_send
      expect(turn.currentState).toBe('pending_send');
      const finalCalls = (deps.sendJson as any).mock.calls
        .filter((c: any) => c[0].type === 'transcript_final');
      expect(finalCalls[finalCalls.length - 1][0].text).toBe('real words');
    });

    it('returns to listening if new audio arrives during STT', async () => {
      let resolveTranscribe: ((v: any) => void) | null = null;
      (deps.sttRouter.transcribe as any).mockImplementation(() => {
        return new Promise((resolve) => { resolveTranscribe = resolve; });
      });

      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));

      const transcribePromise = turn.transcribe();

      // Simulate audio arriving while STT is in-flight
      turn.appendAudio(Buffer.alloc(50));

      // Resolve STT
      resolveTranscribe!({ text: 'partial', confidence: 0.9, segments: [] });
      await transcribePromise;

      expect(turn.currentState).toBe('listening');
    });

    it('does nothing if cancelled during STT', async () => {
      let resolveTranscribe: ((v: any) => void) | null = null;
      (deps.sttRouter.transcribe as any).mockImplementation(() => {
        return new Promise((resolve) => { resolveTranscribe = resolve; });
      });

      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      const transcribePromise = turn.transcribe();

      turn.cancel();

      resolveTranscribe!({ text: 'result', confidence: 0.9, segments: [] });
      await transcribePromise;

      // Should be cancelled, no further transitions
      expect(turn.isActive).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // LLM + TTS pipeline (think)
  // -----------------------------------------------------------------------

  describe('think()', () => {
    it('attaches listeners to LLM pipeline and cleans them up', async () => {
      turn.transition('TEXT_SEND');
      await turn.think('hello', 'main');

      expect(deps.llmPipeline.on).toHaveBeenCalled();
      expect(deps.llmPipeline.off).toHaveBeenCalled();
      expect(deps.llmPipeline.sendTranscript).toHaveBeenCalledWith('hello', 'main', 'turn-1');
    });

    it('resets TTS pipeline before starting', async () => {
      turn.transition('TEXT_SEND');
      await turn.think('hello', 'main');
      expect(deps.ttsPipeline.reset).toHaveBeenCalled();
    });

    it('does nothing if cancelled', async () => {
      turn.cancel();
      await turn.think('hello', 'main');
      expect(deps.llmPipeline.sendTranscript).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Cancel
  // -----------------------------------------------------------------------

  describe('cancel()', () => {
    it('cancels LLM and TTS pipelines', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      expect(deps.llmPipeline.cancel).toHaveBeenCalled();
      expect(deps.ttsPipeline.cancel).toHaveBeenCalled();
      expect(turn.isActive).toBe(false);
    });

    it('sends idle state message', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      const idleCall = (deps.sendJson as any).mock.calls.find(
        (c: any) => c[0].type === 'turn_state' && c[0].state === 'idle',
      );
      expect(idleCall).toBeTruthy();
    });

    it('emits cancelled event', () => {
      const handler = vi.fn();
      turn.on('cancelled', handler);
      turn.transition('AUDIO_START');
      turn.cancel();
      expect(handler).toHaveBeenCalledWith({ turnId: 'turn-1' });
    });

    it('is idempotent', () => {
      turn.transition('AUDIO_START');
      turn.cancel();
      turn.cancel();
      expect(deps.llmPipeline.cancel).toHaveBeenCalledTimes(1);
    });

    it('clears silence timer', () => {
      turn.transition('AUDIO_START');
      turn.appendAudio(Buffer.alloc(100));
      turn.cancel();
      vi.advanceTimersByTime(2000);
      expect(deps.sttRouter.transcribe).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  describe('completion', () => {
    it('emits completed event when transitioning to idle', () => {
      const handler = vi.fn();
      turn.on('completed', handler);
      turn.transition('AUDIO_START');
      turn.transition('CANCEL');
      expect(handler).toHaveBeenCalledWith({ turnId: 'turn-1' });
    });

    it('sets phase to completed', () => {
      turn.transition('AUDIO_START');
      turn.transition('CANCEL');
      expect(turn.isActive).toBe(false);
    });
  });
});
