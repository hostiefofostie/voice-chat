import React, { useRef, useEffect, useCallback } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import ChatMessage from './ChatMessage';
import StreamingBubble from './StreamingBubble';
import { useChatStore } from '../stores/chatStore';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

const renderItem = ({ item }: { item: ChatMsg }) => (
  <ChatMessage role={item.role} text={item.text} timestamp={item.timestamp} />
);

const keyExtractor = (item: ChatMsg) => item.id;

export default function ChatHistory() {
  const messages = useChatStore((s) => s.messages);
  const flatListRef = useRef<FlatList>(null);

  // Scroll to bottom when new messages are added
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      flatListRef.current?.scrollToEnd({ animated: true });
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Throttled scroll for streaming content changes
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleStreamingChange = useCallback(() => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      flatListRef.current?.scrollToEnd({ animated: false });
    }, 200);
  }, []);

  // Clean up scroll timer on unmount
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const footer = useCallback(
    () => <StreamingBubble onContentChange={handleStreamingChange} />,
    [handleStreamingChange],
  );

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListFooterComponent={footer}
      contentContainerStyle={styles.content}
      style={styles.container}
      removeClippedSubviews={true}
      maxToRenderPerBatch={15}
      windowSize={11}
      initialNumToRender={20}
    />
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
