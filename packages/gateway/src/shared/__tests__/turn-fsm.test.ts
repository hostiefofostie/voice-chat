import { describe, it, expect } from 'vitest';
import { transition, TurnState, TurnEvent, VALID_TRANSITIONS } from '../turn-fsm.js';

describe('transition()', () => {
  // -----------------------------------------------------------------------
  // Happy path — full turn lifecycle
  // -----------------------------------------------------------------------

  describe('voice turn lifecycle', () => {
    it('idle + AUDIO_START -> listening', () => {
      expect(transition('idle', 'AUDIO_START')).toBe('listening');
    });

    it('listening + SILENCE_DETECTED -> transcribing', () => {
      expect(transition('listening', 'SILENCE_DETECTED')).toBe('transcribing');
    });

    it('transcribing + STT_DONE -> pending_send', () => {
      expect(transition('transcribing', 'STT_DONE')).toBe('pending_send');
    });

    it('pending_send + SEND -> thinking', () => {
      expect(transition('pending_send', 'SEND')).toBe('thinking');
    });

    it('thinking + LLM_FIRST_CHUNK -> speaking', () => {
      expect(transition('thinking', 'LLM_FIRST_CHUNK')).toBe('speaking');
    });

    it('speaking + LLM_DONE -> idle', () => {
      expect(transition('speaking', 'LLM_DONE')).toBe('idle');
    });

    it('full happy path chains correctly', () => {
      let state: TurnState = 'idle';
      const events: TurnEvent[] = [
        'AUDIO_START', 'SILENCE_DETECTED', 'STT_DONE',
        'SEND', 'LLM_FIRST_CHUNK', 'LLM_DONE',
      ];
      for (const event of events) {
        const next = transition(state, event);
        expect(next).not.toBeNull();
        state = next!;
      }
      expect(state).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // Text-input path (skips voice pipeline)
  // -----------------------------------------------------------------------

  describe('text-input path', () => {
    it('idle + TEXT_SEND -> thinking', () => {
      expect(transition('idle', 'TEXT_SEND')).toBe('thinking');
    });

    it('pending_send + TEXT_SEND -> thinking', () => {
      expect(transition('pending_send', 'TEXT_SEND')).toBe('thinking');
    });
  });

  // -----------------------------------------------------------------------
  // Empty/noise transcript
  // -----------------------------------------------------------------------

  describe('empty transcript', () => {
    it('transcribing + STT_EMPTY -> idle', () => {
      expect(transition('transcribing', 'STT_EMPTY')).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // Audio resume (user resumes speaking mid-pipeline)
  // -----------------------------------------------------------------------

  describe('audio resume', () => {
    it('transcribing + AUDIO_RESUME -> listening', () => {
      expect(transition('transcribing', 'AUDIO_RESUME')).toBe('listening');
    });

    it('pending_send + AUDIO_RESUME -> listening', () => {
      expect(transition('pending_send', 'AUDIO_RESUME')).toBe('listening');
    });
  });

  // -----------------------------------------------------------------------
  // LLM_DONE from thinking (no TTS chunks produced)
  // -----------------------------------------------------------------------

  it('thinking + LLM_DONE -> idle (no TTS chunks)', () => {
    expect(transition('thinking', 'LLM_DONE')).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // CANCEL — works from every non-idle state
  // -----------------------------------------------------------------------

  describe('CANCEL', () => {
    it('returns idle from every non-idle state', () => {
      const nonIdleStates: TurnState[] = [
        'listening', 'transcribing', 'pending_send', 'thinking', 'speaking',
      ];
      for (const state of nonIdleStates) {
        expect(transition(state, 'CANCEL')).toBe('idle');
      }
    });

    it('is ignored in idle state', () => {
      expect(transition('idle', 'CANCEL')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // BARGE_IN — only valid from thinking and speaking
  // -----------------------------------------------------------------------

  describe('BARGE_IN', () => {
    it('thinking + BARGE_IN -> idle', () => {
      expect(transition('thinking', 'BARGE_IN')).toBe('idle');
    });

    it('speaking + BARGE_IN -> idle', () => {
      expect(transition('speaking', 'BARGE_IN')).toBe('idle');
    });

    it('is ignored during listening (user is speaking, not assistant)', () => {
      expect(transition('listening', 'BARGE_IN')).toBeNull();
    });

    it('is ignored during idle', () => {
      expect(transition('idle', 'BARGE_IN')).toBeNull();
    });

    it('is ignored during transcribing', () => {
      expect(transition('transcribing', 'BARGE_IN')).toBeNull();
    });

    it('is ignored during pending_send', () => {
      expect(transition('pending_send', 'BARGE_IN')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // ERROR — returns to idle from any non-idle state that defines it
  // -----------------------------------------------------------------------

  describe('ERROR', () => {
    it('listening + ERROR -> idle', () => {
      expect(transition('listening', 'ERROR')).toBe('idle');
    });

    it('transcribing + ERROR -> idle', () => {
      expect(transition('transcribing', 'ERROR')).toBe('idle');
    });

    it('thinking + ERROR -> idle', () => {
      expect(transition('thinking', 'ERROR')).toBe('idle');
    });

    it('speaking + ERROR -> idle', () => {
      expect(transition('speaking', 'ERROR')).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // Invalid transitions return null
  // -----------------------------------------------------------------------

  describe('invalid transitions', () => {
    it('idle + SEND -> null', () => {
      expect(transition('idle', 'SEND')).toBeNull();
    });

    it('idle + SILENCE_DETECTED -> null', () => {
      expect(transition('idle', 'SILENCE_DETECTED')).toBeNull();
    });

    it('idle + LLM_FIRST_CHUNK -> null', () => {
      expect(transition('idle', 'LLM_FIRST_CHUNK')).toBeNull();
    });

    it('listening + SEND -> null', () => {
      expect(transition('listening', 'SEND')).toBeNull();
    });

    it('listening + TEXT_SEND -> null', () => {
      expect(transition('listening', 'TEXT_SEND')).toBeNull();
    });

    it('listening + LLM_FIRST_CHUNK -> null', () => {
      expect(transition('listening', 'LLM_FIRST_CHUNK')).toBeNull();
    });

    it('speaking + AUDIO_START -> null', () => {
      expect(transition('speaking', 'AUDIO_START')).toBeNull();
    });

    it('speaking + SEND -> null', () => {
      expect(transition('speaking', 'SEND')).toBeNull();
    });
  });
});

describe('VALID_TRANSITIONS (legacy compat)', () => {
  it('has entries for all states', () => {
    const allStates: TurnState[] = [
      'idle', 'listening', 'transcribing', 'pending_send', 'thinking', 'speaking',
    ];
    for (const state of allStates) {
      expect(VALID_TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
    }
  });

  it('idle can transition to listening and thinking', () => {
    expect(VALID_TRANSITIONS.idle).toContain('listening');
    expect(VALID_TRANSITIONS.idle).toContain('thinking');
  });

  it('speaking can only transition to idle', () => {
    expect(VALID_TRANSITIONS.speaking).toEqual(['idle']);
  });
});
