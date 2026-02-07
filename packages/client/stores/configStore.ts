import { create } from 'zustand';
import { Platform } from 'react-native';
import { SessionConfig, DEFAULT_CONFIG } from '../lib/types';

const STORAGE_KEY = 'voice-chat-config';
const AUTO_SEND_DISABLED_KEY = 'voice-chat-auto-send-disabled';

function loadPersistedConfig(): SessionConfig {
  if (Platform.OS !== 'web') return { ...DEFAULT_CONFIG };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    }
  } catch {
    // ignore corrupt data
  }
  return { ...DEFAULT_CONFIG };
}

function persistConfig(config: SessionConfig) {
  if (Platform.OS !== 'web') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore storage errors
  }
}

function loadAutoSendDisabled(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    return localStorage.getItem(AUTO_SEND_DISABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistAutoSendDisabled(disabled: boolean) {
  if (Platform.OS !== 'web') return;
  try {
    localStorage.setItem(AUTO_SEND_DISABLED_KEY, String(disabled));
  } catch {
    // ignore storage errors
  }
}

interface ConfigStore {
  config: SessionConfig;
  autoSendDisabled: boolean;
  updateConfig: (partial: Partial<SessionConfig>) => void;
  toggleAutoSend: () => void;
  resetConfig: () => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: loadPersistedConfig(),
  autoSendDisabled: loadAutoSendDisabled(),
  updateConfig: (partial) => set(state => {
    const config = { ...state.config, ...partial };
    persistConfig(config);
    return { config };
  }),
  toggleAutoSend: () => set(state => {
    const next = !state.autoSendDisabled;
    persistAutoSendDisabled(next);
    return { autoSendDisabled: next };
  }),
  resetConfig: () => {
    persistConfig({ ...DEFAULT_CONFIG });
    persistAutoSendDisabled(false);
    return set({ config: { ...DEFAULT_CONFIG }, autoSendDisabled: false });
  },
}));
