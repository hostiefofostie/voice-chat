import { useRef, useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
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
// VAD abstraction – hides platform differences from the hook
// ---------------------------------------------------------------------------

interface VadInstance {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Creates a VAD instance for the current platform.
 *
 * - **Web**: Uses @ricky0123/vad-web (MicVAD) with Silero ONNX model.
 * - **Native (iOS/Android)**: Uses a lightweight amplitude-based voice
 *   activity detector built on the Web Audio API shim / expo-av.
 *   (A full Silero-based native VAD can be swapped in later when
 *   @ricky0123/vad-react-native or an equivalent becomes available.)
 */
async function createVad(opts: {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  preSpeechPadMs: number;
  redemptionMs: number;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  stream: MediaStream;
}): Promise<VadInstance> {
  if (Platform.OS === 'web') {
    return createWebVad(opts);
  }
  return createNativeVad(opts);
}

// ---------------------------------------------------------------------------
// Web VAD – @ricky0123/vad-web
// ---------------------------------------------------------------------------

/**
 * Load onnxruntime-web from CDN. Metro can't parse onnxruntime-web's
 * dynamic import(variable) syntax, so we redirect it to a shim that
 * re-exports globalThis.ort. This function populates globalThis.ort
 * by injecting a <script> tag and must be called before importing vad-web.
 */
const ONNX_CDN_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.min.js';
let onnxLoadPromise: Promise<void> | null = null;

function loadOnnxRuntime(): Promise<void> {
  if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).ort) {
    return Promise.resolve();
  }
  if (!onnxLoadPromise) {
    onnxLoadPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ONNX_CDN_URL;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Failed to load onnxruntime-web from CDN'));
      document.head.appendChild(script);
    });
  }
  return onnxLoadPromise;
}

async function createWebVad(opts: {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  preSpeechPadMs: number;
  redemptionMs: number;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  stream: MediaStream;
}): Promise<VadInstance> {
  // Load onnxruntime-web from CDN before importing vad-web, so that
  // globalThis.ort is populated when our Metro shim is evaluated.
  await loadOnnxRuntime();
  const { MicVAD } = await import('@ricky0123/vad-web');

  const vad = await MicVAD.new({
    positiveSpeechThreshold: opts.positiveSpeechThreshold,
    negativeSpeechThreshold: opts.negativeSpeechThreshold,
    minSpeechMs: opts.minSpeechMs,
    preSpeechPadMs: opts.preSpeechPadMs,
    redemptionMs: opts.redemptionMs,
    startOnLoad: true,
    getStream: async () => opts.stream,
    onSpeechStart: opts.onSpeechStart,
    onSpeechEnd: opts.onSpeechEnd,
    // Load WASM binaries and model from CDN to avoid Metro serving them
    // with incorrect MIME types (which causes WebAssembly compile errors).
    onnxWASMBasePath:
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/',
    baseAssetPath:
      'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/',
  });

  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Native VAD – amplitude-based fallback
// ---------------------------------------------------------------------------

async function createNativeVad(opts: {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  stream: MediaStream;
}): Promise<VadInstance> {
  // Use the Web Audio API (available via react-native-web-audio-api or
  // the JavaScriptCore polyfill that Expo provides for AudioContext).
  const audioContext = new AudioContext({ sampleRate: 16_000 });
  const source = audioContext.createMediaStreamSource(opts.stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  // For capturing raw audio we use a ScriptProcessor (deprecated but
  // universally available) — worklet support on RN is spotty.
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

  let speaking = false;
  let speechStart = 0;
  let paused = false;
  let destroyed = false;
  const chunks: Float32Array[] = [];

  // Amplitude threshold — map the 0..1 VAD thresholds to RMS values.
  // Silero thresholds are probability-based; we approximate with RMS.
  const startThreshold = opts.positiveSpeechThreshold * 0.05; // ~0.0425
  const stopThreshold = opts.negativeSpeechThreshold * 0.03; // ~0.021
  const minSpeechMs = opts.minSpeechMs;
  let silenceStart = 0;
  const silenceGraceMs = 600;

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (paused || destroyed) return;

    const input = e.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    const rms = Math.sqrt(sum / input.length);

    if (!speaking) {
      if (rms > startThreshold) {
        speaking = true;
        speechStart = Date.now();
        chunks.length = 0;
        chunks.push(copy);
        opts.onSpeechStart();
      }
    } else {
      chunks.push(copy);
      if (rms < stopThreshold) {
        if (silenceStart === 0) silenceStart = Date.now();
        if (Date.now() - silenceStart > silenceGraceMs) {
          // Only emit if speech was long enough
          if (Date.now() - speechStart >= minSpeechMs) {
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const merged = new Float32Array(totalLen);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.length;
            }
            opts.onSpeechEnd(merged);
          }
          speaking = false;
          silenceStart = 0;
          chunks.length = 0;
        }
      } else {
        silenceStart = 0;
      }
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    start: async () => {
      paused = false;
    },
    pause: async () => {
      paused = true;
    },
    destroy: async () => {
      destroyed = true;
      processor.disconnect();
      source.disconnect();
      await audioContext.close();
    },
  };
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

  const vadRef = useRef<VadInstance | null>(null);
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
      // Re-throw so callers (e.g. handleMicToggle) can report the denial
      // to the error recovery system.
      throw err;
    }

    // Guard against unmount while awaiting mic permission
    if (unmountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    try {
      const vad = await createVad({
        positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
        negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
        minSpeechMs: MIN_SPEECH_MS,
        preSpeechPadMs: 300,
        redemptionMs: 600,
        stream,

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
