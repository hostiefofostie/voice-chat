import { useRef, useEffect, useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtsChunkMeta {
  format: string;
  index: number;
  sampleRate: number;
  durationMs: number;
}

export interface UseAudioPlaybackReturn {
  isPlaying: boolean;
  queueChunk: (meta: TtsChunkMeta, audioData: ArrayBuffer) => void;
  /** Signal that no more chunks will arrive (tts_done received). */
  markDone: () => void;
  stop: () => void;
  setVolume: (vol: number) => void;
}

interface QueuedChunk {
  meta: TtsChunkMeta;
  audioData: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Queue-based TTS audio playback using Web Audio API.
 *
 * Incoming chunks are inserted into a queue ordered by index and played
 * sequentially. `stop()` immediately halts playback and clears the queue
 * (barge-in). AudioContext is created lazily to comply with browser
 * autoplay policy.
 *
 * ### tts_meta + Binary Pairing
 * The WebSocket sends a `tts_meta` JSON message followed by a binary frame.
 * The component using this hook should:
 * 1. On ServerMessage type `tts_meta` -> store the meta temporarily
 * 2. On next binary frame -> call `queueChunk(storedMeta, binaryData)`
 */
export function useAudioPlayback(options: {
  onPlaybackStart: () => void;
  onPlaybackEnd: () => void;
  onChunkPlayed: (index: number) => void;
}): UseAudioPlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false);

  // Refs for mutable state that persists across renders
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<QueuedChunk[]>([]);
  const isPlayingRef = useRef(false);
  const isProcessingRef = useRef(false);
  const nextExpectedIndexRef = useRef(0);
  const unmountedRef = useRef(false);
  // Whether the server has signalled tts_done (no more chunks coming).
  // Without this flag, playNext() can't distinguish "chunks still in flight"
  // from "all chunks played" when the queue is empty.
  const ttsDoneRef = useRef(false);

  // ------ internal helpers ------

  /** Get or create the AudioContext and GainNode (lazy init). */
  const ensureContext = useCallback((): AudioContext => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;
    return ctx;
  }, []);

  /** Resume the AudioContext if suspended (browser autoplay policy). */
  const resumeContext = useCallback(async (ctx: AudioContext) => {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }, []);

  /** Play the next chunk in the queue if it matches the expected index. */
  const playNext = useCallback(async () => {
    if (unmountedRef.current || isProcessingRef.current) return;

    const queue = queueRef.current;

    // Find the chunk with the expected index
    const idx = queue.findIndex(
      (c) => c.meta.index === nextExpectedIndexRef.current,
    );
    if (idx === -1) {
      // Expected chunk hasn't arrived yet, or queue is empty.
      // Only declare playback done if the server has signalled tts_done
      // (no more chunks coming). Otherwise more chunks may still be in flight.
      if (queue.length === 0 && isPlayingRef.current && ttsDoneRef.current) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        nextExpectedIndexRef.current = 0;
        ttsDoneRef.current = false;
        optionsRef.current.onPlaybackEnd();
      }
      return;
    }

    // Remove chunk from queue
    const [chunk] = queue.splice(idx, 1);
    isProcessingRef.current = true;

    try {
      const ctx = ensureContext();
      await resumeContext(ctx);

      // Clone the ArrayBuffer because decodeAudioData detaches it
      const cloned = chunk.audioData.slice(0);
      const audioBuffer = await ctx.decodeAudioData(cloned);

      if (unmountedRef.current) {
        isProcessingRef.current = false;
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainRef.current!);
      sourceRef.current = source;

      source.onended = () => {
        if (unmountedRef.current) return;
        sourceRef.current = null;
        isProcessingRef.current = false;
        optionsRef.current.onChunkPlayed(chunk.meta.index);
        nextExpectedIndexRef.current = chunk.meta.index + 1;
        playNext();
      };

      source.start();
    } catch {
      // Decode or playback failed — skip this chunk and try next
      isProcessingRef.current = false;
      nextExpectedIndexRef.current = chunk.meta.index + 1;
      playNext();
    }
  }, [ensureContext, resumeContext]);

  // ------ public API ------

  const queueChunk = useCallback(
    (meta: TtsChunkMeta, audioData: ArrayBuffer) => {
      if (unmountedRef.current) return;

      const queue = queueRef.current;

      // Insert in sorted order by index
      const entry: QueuedChunk = { meta, audioData };
      let insertAt = queue.length;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].meta.index > meta.index) {
          insertAt = i;
          break;
        }
      }
      queue.splice(insertAt, 0, entry);

      // If not currently playing, start playback
      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        nextExpectedIndexRef.current = 0;
        setIsPlaying(true);
        optionsRef.current.onPlaybackStart();
      }

      // Kick the play loop in case we were waiting for this chunk
      if (!isProcessingRef.current) {
        playNext();
      }
    },
    [playNext],
  );

  /** Signal that no more chunks will arrive from the server (tts_done). */
  const markDone = useCallback(() => {
    ttsDoneRef.current = true;
    // If nothing is processing and the queue is empty, end playback now.
    if (!isProcessingRef.current && queueRef.current.length === 0 && isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      nextExpectedIndexRef.current = 0;
      ttsDoneRef.current = false;
      optionsRef.current.onPlaybackEnd();
    }
  }, []);

  const stop = useCallback(() => {
    // Clear the queue
    queueRef.current = [];

    // Stop current source
    const source = sourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped
      }
      sourceRef.current = null;
    }

    isProcessingRef.current = false;
    ttsDoneRef.current = false;

    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      nextExpectedIndexRef.current = 0;
      setIsPlaying(false);
      optionsRef.current.onPlaybackEnd();
    }
  }, []);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    // Create context if needed so volume is ready when playback starts
    ensureContext();
    if (gainRef.current) {
      gainRef.current.gain.value = clamped;
    }
  }, [ensureContext]);

  // ------ lifecycle ------

  useEffect(() => {
    unmountedRef.current = false;

    return () => {
      unmountedRef.current = true;

      // Stop playback
      queueRef.current = [];
      const source = sourceRef.current;
      if (source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped
        }
        sourceRef.current = null;
      }

      // Close AudioContext
      const ctx = ctxRef.current;
      if (ctx) {
        ctx.close();
        ctxRef.current = null;
        gainRef.current = null;
      }
    };
  }, []);

  return { isPlaying, queueChunk, markDone, stop, setVolume };
}
