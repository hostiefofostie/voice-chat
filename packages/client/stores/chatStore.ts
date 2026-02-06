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
  updateLastAssistant: (text) => set(state => {
    const msgs = [...state.messages];
    const last = msgs.findLast(m => m.role === 'assistant');
    if (last) last.text = text;
    return { messages: msgs };
  }),
  clear: () => set({ messages: [] }),
}));
