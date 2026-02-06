// Voice Chat — Shared WebSocket Protocol Types
// These types define the contract between client and server.

// ---------------------------------------------------------------------------
// Turn State Machine
// ---------------------------------------------------------------------------

/** Represents the current phase of a voice conversation turn. */
export type TurnState =
  | 'idle'          // Not listening, not processing
  | 'listening'     // VAD detected speech, audio streaming
  | 'transcribing'  // VAD endpoint, running STT
  | 'pending_send'  // Transcript ready, user can edit before send
  | 'thinking'      // Sent to LLM, tokens streaming
  | 'speaking';     // TTS audio playing

/**
 * Valid state transitions for the turn state machine.
 * Server is authoritative; client may optimistically transition but
 * reconciles on `turn_state` messages.
 */
export const VALID_TRANSITIONS: Record<TurnState, TurnState[]> = {
  idle: ['listening'],
  listening: ['transcribing', 'idle'],    // idle via barge-in cancel
  transcribing: ['pending_send'],
  pending_send: ['thinking', 'idle'],     // idle via cancel
  thinking: ['speaking', 'idle'],         // idle via cancel
  speaking: ['idle', 'listening'],        // listening via barge-in
};

// ---------------------------------------------------------------------------
// Session Config
// ---------------------------------------------------------------------------

/** Per-session configuration negotiated between client and server. */
export interface SessionConfig {
  /** Delay before auto-sending transcript. 0 = instant, 1500 = default (ms). */
  autoSendDelayMs: number;
  /** TTS engine to use. */
  ttsProvider: 'kokoro' | 'openai';
  /** TTS voice identifier (provider-specific). */
  ttsVoice: string;
  /** STT engine to use. */
  sttProvider: 'parakeet' | 'cloud';
  /** VAD trigger sensitivity, 0.0 (least sensitive) to 1.0 (most sensitive). */
  vadSensitivity: number;
  /** LLM model identifier passed to OpenClaw Gateway. */
  llmModel: string;
  /** Agent/persona identifier. */
  agentId: string;
  /** Opaque session key for reconnection. */
  sessionKey: string;
}

/** Sensible defaults for a new session. */
export const DEFAULT_CONFIG: SessionConfig = {
  autoSendDelayMs: 1500,
  ttsProvider: 'kokoro',
  ttsVoice: 'af_heart',
  sttProvider: 'parakeet',
  vadSensitivity: 0.5,
  llmModel: 'sonnet',
  agentId: 'default',
  sessionKey: '',
};

// ---------------------------------------------------------------------------
// Client -> Server Messages
// ---------------------------------------------------------------------------

/** Messages the client sends to the server over the JSON channel. */
export type ClientMessage =
  | {
      /** User confirmed or edited the transcript and is sending it. */
      type: 'transcript_send';
      /** The final transcript text (may have been edited by user). */
      text: string;
      /** Unique identifier for this conversational turn. */
      turnId: string;
    }
  | {
      /** A slash command (e.g. /model, /voice). */
      type: 'command';
      /** Command name without the leading slash. */
      name: string;
      /** Positional arguments after the command name. */
      args: string[];
    }
  | {
      /** User spoke during TTS playback, interrupting the assistant. */
      type: 'barge_in';
    }
  | {
      /** Cancel the current LLM generation or pending operation. */
      type: 'cancel';
    }
  | {
      /** Update session configuration. Only provided fields are changed. */
      type: 'config';
      /** Partial config — only the fields being changed. */
      settings: Partial<SessionConfig>;
    }
  | {
      /** Client heartbeat. Server replies with `pong`. */
      type: 'ping';
      /** Client-side timestamp (ms since epoch) for round-trip measurement. */
      ts: number;
    };

// ---------------------------------------------------------------------------
// Server -> Client Messages
// ---------------------------------------------------------------------------

/** Messages the server sends to the client over the JSON channel. */
export type ServerMessage =
  | {
      /** Partial STT transcript while audio is still streaming. */
      type: 'transcript_partial';
      /** Full accumulated transcript so far. */
      text: string;
      /** Portion of the transcript considered stable (unlikely to change). */
      stable: string;
      /** Portion of the transcript still being refined. */
      unstable: string;
    }
  | {
      /** Final STT transcript after VAD endpoint. */
      type: 'transcript_final';
      /** The complete transcribed text. */
      text: string;
      /** Unique identifier for this conversational turn. */
      turnId: string;
    }
  | {
      /** A single token streamed from the LLM. */
      type: 'llm_token';
      /** The new token. */
      token: string;
      /** Full accumulated response text so far. */
      fullText: string;
    }
  | {
      /** LLM generation is complete. */
      type: 'llm_done';
      /** The complete LLM response. */
      fullText: string;
    }
  | {
      /** Metadata for an upcoming TTS audio chunk (sent before the binary frame). */
      type: 'tts_meta';
      /** Audio format of the following binary frame. */
      format: 'wav';
      /** Zero-based index of this chunk in the current response. */
      index: number;
      /** Sample rate in Hz. */
      sampleRate: number;
      /** Duration of this audio chunk in milliseconds. */
      durationMs: number;
    }
  | {
      /** All TTS audio chunks for the current response have been sent. */
      type: 'tts_done';
    }
  | {
      /** Server-authoritative turn state update. */
      type: 'turn_state';
      /** The new turn state. */
      state: TurnState;
      /** Turn identifier, present when entering a stateful turn phase. */
      turnId?: string;
    }
  | {
      /** An error occurred during processing. */
      type: 'error';
      /** Machine-readable error code (e.g. "stt_timeout", "llm_error"). */
      code: string;
      /** Human-readable error description. */
      message: string;
      /** If true, the client can retry or continue; if false, the session may be broken. */
      recoverable: boolean;
    }
  | {
      /** Result of a slash command execution. */
      type: 'command_result';
      /** The command that was executed. */
      name: string;
      /** Command-specific result payload. */
      result: unknown;
    }
  | {
      /** Server heartbeat reply. */
      type: 'pong';
      /** Echoed client timestamp for round-trip calculation. */
      ts: number;
      /** Server timestamp when pong was generated. */
      serverTs: number;
    };

// ---------------------------------------------------------------------------
// Supporting Types
// ---------------------------------------------------------------------------

/** Result returned by an STT provider after processing audio. */
export interface TranscribeResult {
  /** The transcribed text. */
  text: string;
  /** Confidence score from the STT engine, 0.0 to 1.0. */
  confidence: number;
  /** Word-level or segment-level timing information. */
  segments: Array<{
    /** Segment start time in seconds relative to audio start. */
    start: number;
    /** Segment end time in seconds relative to audio start. */
    end: number;
    /** Transcribed text for this segment. */
    text: string;
  }>;
}

/** A sentence-level chunk ready for TTS processing. */
export interface PhraseChunk {
  /** The sentence or phrase text to synthesize. */
  text: string;
  /** Zero-based index in the sequence of chunks for this response. */
  index: number;
}

/** Catalog of available TTS voices from a provider. */
export interface VoiceCatalog {
  /** List of available voices. */
  voices: Array<{
    /** Provider-specific voice identifier. */
    id: string;
    /** Human-readable voice name. */
    name: string;
    /** BCP-47 language code (e.g. "en-US"). */
    language: string;
  }>;
}
