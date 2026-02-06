import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  text: string;
  isStreaming?: boolean;
  timestamp?: number;
}

export default function ChatMessage({ role, text, isStreaming }: ChatMessageProps) {
  const isUser = role === 'user';
  const cursorOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isStreaming) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
        Animated.timing(cursorOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [isStreaming, cursorOpacity]);

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={styles.label}>{isUser ? 'You' : 'Clawd'}</Text>
        <Text style={styles.text}>
          {text}
          {isStreaming && (
            <Animated.Text style={[styles.cursor, { opacity: cursorOpacity }]}>
              {'\u2588'}
            </Animated.Text>
          )}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  rowUser: {
    alignItems: 'flex-end',
  },
  rowAssistant: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: '#3b82f6',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#1e293b',
    borderBottomLeftRadius: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(229,231,235,0.6)',
    marginBottom: 2,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
    color: '#e5e7eb',
  },
  cursor: {
    color: '#e5e7eb',
    fontSize: 15,
  },
});
