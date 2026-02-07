import { create } from 'zustand';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface ChatStore {
  messages: ChatMessage[];
  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  setMessages: (msgs: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>) => void;
  updateLastAssistant: (text: string) => void;
  clear: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  addMessage: (msg) => set(state => ({
    messages: [...state.messages, {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    }]
  })),
  setMessages: (msgs) => set({
    messages: msgs.map((m) => ({
      id: crypto.randomUUID(),
      role: m.role,
      text: m.text,
      timestamp: m.timestamp ?? Date.now(),
    })),
  }),
  updateLastAssistant: (text) => set(state => {
    const lastIdx = state.messages.findLastIndex(m => m.role === 'assistant');
    if (lastIdx === -1) return state;
    const msgs = state.messages.map((m, i) =>
      i === lastIdx ? { ...m, text } : m,
    );
    return { messages: msgs };
  }),
  clear: () => set({ messages: [] }),
}));
