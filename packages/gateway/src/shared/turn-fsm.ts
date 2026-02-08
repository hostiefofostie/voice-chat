// Pure state machine — no side effects, no I/O, no EventEmitter.
// Shared between gateway and client.

export type TurnState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'pending_send'
  | 'thinking'
  | 'speaking';

export type TurnEvent =
  | 'AUDIO_START'       // VAD detected speech / first audio frame
  | 'SILENCE_DETECTED'  // VAD silence timeout triggered
  | 'STT_DONE'          // Transcription complete with text
  | 'STT_EMPTY'         // Transcription complete but empty/noise
  | 'AUDIO_RESUME'      // Audio arrived during transcribing or pending_send
  | 'SEND'              // User confirmed transcript (auto-send or manual)
  | 'TEXT_SEND'          // Text-input send (skip voice pipeline, go straight to thinking)
  | 'LLM_FIRST_CHUNK'   // First TTS phrase ready (thinking -> speaking)
  | 'LLM_DONE'          // LLM + TTS pipeline finished
  | 'BARGE_IN'          // User interrupted during speaking/thinking
  | 'CANCEL'            // User cancelled from any active state
  | 'ERROR';            // Recoverable error, return to idle

/**
 * Transition table: [currentState][event] -> nextState.
 * Missing entries mean the event is ignored in that state.
 */
const TRANSITIONS: Partial<Record<TurnState, Partial<Record<TurnEvent, TurnState>>>> = {
  idle: {
    AUDIO_START: 'listening',
    TEXT_SEND:   'thinking',
  },
  listening: {
    SILENCE_DETECTED: 'transcribing',
    CANCEL:           'idle',
    ERROR:            'idle',
  },
  transcribing: {
    STT_DONE:     'pending_send',
    STT_EMPTY:    'idle',
    AUDIO_RESUME: 'listening',
    CANCEL:       'idle',
    ERROR:        'idle',
  },
  pending_send: {
    SEND:         'thinking',
    AUDIO_RESUME: 'listening',
    CANCEL:       'idle',
    TEXT_SEND:    'thinking',
  },
  thinking: {
    LLM_FIRST_CHUNK: 'speaking',
    LLM_DONE:        'idle',
    CANCEL:          'idle',
    BARGE_IN:        'idle',
    ERROR:           'idle',
  },
  speaking: {
    LLM_DONE: 'idle',
    BARGE_IN: 'idle',
    CANCEL:   'idle',
    ERROR:    'idle',
  },
};

/**
 * Pure transition function. Returns the next state, or null if the event
 * is not valid in the current state (caller decides whether to ignore or log).
 */
export function transition(current: TurnState, event: TurnEvent): TurnState | null {
  return TRANSITIONS[current]?.[event] ?? null;
}

/**
 * Legacy compatibility: the old VALID_TRANSITIONS map for code that still
 * uses state-targeted transitions. Will be removed after full migration.
 */
export const VALID_TRANSITIONS: Record<TurnState, TurnState[]> = {
  idle:         ['listening', 'thinking'],
  listening:    ['transcribing', 'idle'],
  transcribing: ['pending_send', 'listening', 'idle'],
  pending_send: ['thinking', 'listening', 'idle'],
  thinking:     ['speaking', 'idle'],
  speaking:     ['idle'],
};
