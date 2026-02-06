import { useRef, useEffect, useState, useCallback } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { float32ToWav } from '../lib/audio-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseAudioCaptureOptions {
  sendBinary: (data: ArrayBuffer) => void;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  vadSensitivity?: number;
}

export interface UseAudioCaptureReturn {
  isCapturing: boolean;
  isSpeaking: boolean;
  start: () => Promise<void>;
  stop: () => void;
  mute: () => void;
  unmute: () => void;
  isMuted: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16_000;
const POSITIVE_SPEECH_THRESHOLD = 0.85;
const NEGATIVE_SPEECH_THRESHOLD = 0.70;
const MIN_SPEECH_MS = 384; // ~12 frames at 32ms each

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAudioCapture(
  options: UseAudioCaptureOptions,
): UseAudioCaptureReturn {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const vadRef = useRef<MicVAD | null>(null);
  const optionsRef = useRef(options);
  const mutedRef = useRef(false);
  const unmountedRef = useRef(false);

  // Keep refs current so VAD callbacks never go stale
  optionsRef.current = options;
  mutedRef.current = isMuted;

  const start = useCallback(async () => {
    // Already running
    if (vadRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: SAMPLE_RATE,
        },
      });
    } catch (err) {
      console.error('[useAudioCapture] Microphone permission denied:', err);
      return;
    }

    // Guard against unmount while awaiting mic permission
    if (unmountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    try {
      const vad = await MicVAD.new({
        positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
        negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
        minSpeechMs: MIN_SPEECH_MS,
        preSpeechPadMs: 300,
        redemptionMs: 600,
        startOnLoad: true,

        getStream: async () => stream,

        onSpeechStart: () => {
          if (mutedRef.current) return;
          setIsSpeaking(true);
          optionsRef.current.onSpeechStart();
        },

        onSpeechEnd: (audio: Float32Array) => {
          setIsSpeaking(false);
          if (mutedRef.current) return;

          const wav = float32ToWav(audio, SAMPLE_RATE);
          optionsRef.current.sendBinary(wav);
          optionsRef.current.onSpeechEnd(audio);
        },
      });

      // Guard against unmount while VAD was initializing
      if (unmountedRef.current) {
        await vad.destroy();
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      vadRef.current = vad;
      setIsCapturing(true);
    } catch (err) {
      console.error('[useAudioCapture] VAD initialization failed:', err);
      stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const stop = useCallback(() => {
    const vad = vadRef.current;
    if (vad) {
      vadRef.current = null;
      setIsCapturing(false);
      setIsSpeaking(false);
      // destroy() is async but we fire-and-forget on stop
      vad.destroy().catch((err: unknown) => {
        console.error('[useAudioCapture] Error destroying VAD:', err);
      });
    }
  }, []);

  const mute = useCallback(() => {
    setIsMuted(true);
    // Pause VAD processing so muted audio doesn't trigger speech detection
    if (vadRef.current) {
      vadRef.current.pause().catch((err: unknown) => {
        console.error('[useAudioCapture] Error pausing VAD:', err);
      });
    }
  }, []);

  const unmute = useCallback(() => {
    setIsMuted(false);
    if (vadRef.current) {
      vadRef.current.start().catch((err: unknown) => {
        console.error('[useAudioCapture] Error resuming VAD:', err);
      });
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    unmountedRef.current = false;

    return () => {
      unmountedRef.current = true;
      const vad = vadRef.current;
      if (vad) {
        vadRef.current = null;
        vad.destroy().catch((err: unknown) => {
          console.error('[useAudioCapture] Error destroying VAD on unmount:', err);
        });
      }
    };
  }, []);

  return {
    isCapturing,
    isSpeaking,
    start,
    stop,
    mute,
    unmute,
    isMuted,
  };
}
