import React, { useRef, useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import ChatMessage from './ChatMessage';
import { useChatStore } from '../stores/chatStore';
import { useTurnStore } from '../stores/turnStore';

export default function ChatHistory() {
  const messages = useChatStore((s) => s.messages);
  const turnState = useTurnStore((s) => s.state);
  const llmText = useTurnStore((s) => s.llmText);
  const scrollRef = useRef<ScrollView>(null);

  const isStreaming = turnState === 'thinking' || turnState === 'speaking';

  useEffect(() => {
    // Small delay so layout can settle before scrolling
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [messages.length, llmText]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          role={msg.role}
          text={msg.text}
          timestamp={msg.timestamp}
        />
      ))}
      {isStreaming && llmText.length > 0 && (
        <ChatMessage
          role="assistant"
          text={llmText}
          isStreaming={turnState === 'thinking'}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1115',
  },
  content: {
    paddingVertical: 12,
  },
});
