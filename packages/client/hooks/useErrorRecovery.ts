import { useRef, useEffect, useCallback } from 'react';
import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Error State Store
// ---------------------------------------------------------------------------

export interface ErrorState {
  wsDisconnected: boolean;
  sttUnavailable: boolean;
  ttsUnavailable: boolean;
  llmTimeout: boolean;
  micPermissionDenied: boolean;
  textOnlyMode: boolean;
}

interface ErrorStore extends ErrorState {
  /** Consecutive STT error count (auto-clear on success) */
  sttErrorCount: number;
  /** Consecutive TTS error count (auto-clear on success) */
  ttsErrorCount: number;
  /** Timestamp of last llm_token received (0 = not tracking) */
  llmLastTokenAt: number;
  /** LLM timeout tier: 0=none, 1=15s "still thinking", 2=30s "taking longer" */
  llmTimeoutTier: number;

  setWsDisconnected: (v: boolean) => void;
  reportSttError: () => void;
  reportSttSuccess: () => void;
  reportTtsError: () => void;
  reportTtsSuccess: () => void;
  reportLlmTimeout: (tier: number) => void;
  reportLlmToken: () => void;
  reportLlmDone: () => void;
  reportMicDenied: () => void;
  clearError: (type: keyof ErrorState) => void;
}

const STT_ERROR_THRESHOLD = 2;
const TTS_ERROR_THRESHOLD = 2;

export const useErrorStore = create<ErrorStore>((set, get) => ({
  wsDisconnected: false,
  sttUnavailable: false,
  ttsUnavailable: false,
  llmTimeout: false,
  micPermissionDenied: false,
  textOnlyMode: false,
  sttErrorCount: 0,
  ttsErrorCount: 0,
  llmLastTokenAt: 0,
  llmTimeoutTier: 0,

  setWsDisconnected: (v) => set({ wsDisconnected: v }),

  reportSttError: () => {
    const count = get().sttErrorCount + 1;
    const sttUnavailable = count >= STT_ERROR_THRESHOLD;
    const micDenied = get().micPermissionDenied;
    set({
      sttErrorCount: count,
      sttUnavailable,
      textOnlyMode: sttUnavailable || micDenied,
    });
  },

  reportSttSuccess: () => {
    const micDenied = get().micPermissionDenied;
    set({
      sttErrorCount: 0,
      sttUnavailable: false,
      textOnlyMode: micDenied,
    });
  },

  reportTtsError: () => {
    const count = get().ttsErrorCount + 1;
    set({
      ttsErrorCount: count,
      ttsUnavailable: count >= TTS_ERROR_THRESHOLD,
    });
  },

  reportTtsSuccess: () => set({
    ttsErrorCount: 0,
    ttsUnavailable: false,
  }),

  reportLlmTimeout: (tier) => set({
    llmTimeout: true,
    llmTimeoutTier: tier,
  }),

  reportLlmToken: () => set({
    llmLastTokenAt: Date.now(),
    llmTimeout: false,
    llmTimeoutTier: 0,
  }),

  reportLlmDone: () => set({
    llmLastTokenAt: 0,
    llmTimeout: false,
    llmTimeoutTier: 0,
  }),

  reportMicDenied: () => set({
    micPermissionDenied: true,
    textOnlyMode: true,
  }),

  clearError: (type) => {
    const update: Partial<ErrorState> = { [type]: false };
    if (type === 'sttUnavailable') {
      const micDenied = get().micPermissionDenied;
      update.textOnlyMode = micDenied;
    }
    if (type === 'micPermissionDenied') {
      const sttDown = get().sttUnavailable;
      update.textOnlyMode = sttDown;
    }
    set(update);
  },
}));

// ---------------------------------------------------------------------------
// LLM Timeout Tracker Hook
// ---------------------------------------------------------------------------

const LLM_TIER1_MS = 15_000;
const LLM_TIER2_MS = 30_000;
const LLM_CHECK_INTERVAL_MS = 2_000;

export function useLlmTimeoutTracker(isThinking: boolean) {
  const thinkingStartRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearInterval_ = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isThinking) {
      const store = useErrorStore.getState();
      // If we already have a token, use that timestamp; otherwise use now
      thinkingStartRef.current = store.llmLastTokenAt || Date.now();

      intervalRef.current = setInterval(() => {
        const { llmLastTokenAt, llmTimeoutTier } = useErrorStore.getState();
        const reference = llmLastTokenAt || thinkingStartRef.current;
        const elapsed = Date.now() - reference;

        if (elapsed >= LLM_TIER2_MS && llmTimeoutTier < 2) {
          useErrorStore.getState().reportLlmTimeout(2);
        } else if (elapsed >= LLM_TIER1_MS && llmTimeoutTier < 1) {
          useErrorStore.getState().reportLlmTimeout(1);
        }
      }, LLM_CHECK_INTERVAL_MS);

      return () => clearInterval_();
    } else {
      clearInterval_();
      useErrorStore.getState().reportLlmDone();
    }
  }, [isThinking, clearInterval_]);
}

// ---------------------------------------------------------------------------
// Convenience Hook
// ---------------------------------------------------------------------------

export interface UseErrorRecoveryReturn extends ErrorState {
  llmTimeoutTier: number;
  reportSttError: () => void;
  reportTtsError: () => void;
  reportLlmTimeout: () => void;
  reportMicDenied: () => void;
  clearError: (type: keyof ErrorState) => void;
}

export function useErrorRecovery(): UseErrorRecoveryReturn {
  const wsDisconnected = useErrorStore((s) => s.wsDisconnected);
  const sttUnavailable = useErrorStore((s) => s.sttUnavailable);
  const ttsUnavailable = useErrorStore((s) => s.ttsUnavailable);
  const llmTimeout = useErrorStore((s) => s.llmTimeout);
  const micPermissionDenied = useErrorStore((s) => s.micPermissionDenied);
  const textOnlyMode = useErrorStore((s) => s.textOnlyMode);
  const llmTimeoutTier = useErrorStore((s) => s.llmTimeoutTier);
  const reportSttError = useErrorStore((s) => s.reportSttError);
  const reportTtsError = useErrorStore((s) => s.reportTtsError);
  const reportLlmTimeout = useErrorStore((s) => s.reportLlmTimeout);
  const reportMicDenied = useErrorStore((s) => s.reportMicDenied);
  const clearError = useErrorStore((s) => s.clearError);

  return {
    wsDisconnected,
    sttUnavailable,
    ttsUnavailable,
    llmTimeout,
    micPermissionDenied,
    textOnlyMode,
    llmTimeoutTier,
    reportSttError,
    reportTtsError: reportTtsError,
    reportLlmTimeout: () => reportLlmTimeout(1),
    reportMicDenied,
    clearError,
  };
}
