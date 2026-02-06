import { create } from 'zustand';
import { TurnState, VALID_TRANSITIONS } from '../lib/types';

interface TurnStore {
  state: TurnState;
  turnId: string | null;
  transcript: string;
  stableTranscript: string;
  unstableTranscript: string;
  llmText: string;
  autoSendDelayMs: number;
  autoSendTimerActive: boolean;

  transition: (to: TurnState, turnId?: string) => boolean;
  reconcile: (serverState: TurnState, turnId?: string) => void;
  setTranscript: (text: string) => void;
  setPartialTranscript: (stable: string, unstable: string) => void;
  appendLlmToken: (token: string, fullText: string) => void;
  reset: () => void;
}

export const useTurnStore = create<TurnStore>((set, get) => ({
  state: 'idle',
  turnId: null,
  transcript: '',
  stableTranscript: '',
  unstableTranscript: '',
  llmText: '',
  autoSendDelayMs: 1500,
  autoSendTimerActive: false,

  transition: (to, turnId) => {
    const { state } = get();
    if (!VALID_TRANSITIONS[state]?.includes(to)) return false;
    set({ state: to, ...(turnId ? { turnId } : {}) });
    return true;
  },

  reconcile: (serverState, turnId) => {
    set({ state: serverState, ...(turnId ? { turnId } : {}) });
  },

  setTranscript: (text) => {
    set({ transcript: text });
  },

  setPartialTranscript: (stable, unstable) => {
    set({ stableTranscript: stable, unstableTranscript: unstable, transcript: stable + unstable });
  },

  appendLlmToken: (_token, fullText) => {
    set({ llmText: fullText });
  },

  reset: () => set({
    state: 'idle', turnId: null, transcript: '', stableTranscript: '',
    unstableTranscript: '', llmText: '', autoSendTimerActive: false,
  }),
}));
