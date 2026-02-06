import { create } from 'zustand';
import { Platform } from 'react-native';
import { SessionConfig, DEFAULT_CONFIG } from '../lib/types';

const STORAGE_KEY = 'voice-chat-config';

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

interface ConfigStore {
  config: SessionConfig;
  updateConfig: (partial: Partial<SessionConfig>) => void;
  resetConfig: () => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: loadPersistedConfig(),
  updateConfig: (partial) => set(state => {
    const config = { ...state.config, ...partial };
    persistConfig(config);
    return { config };
  }),
  resetConfig: () => {
    persistConfig({ ...DEFAULT_CONFIG });
    return set({ config: { ...DEFAULT_CONFIG } });
  },
}));
