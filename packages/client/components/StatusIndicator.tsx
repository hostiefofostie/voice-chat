import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTurnStore } from '../stores/turnStore';
import type { TurnState } from '../lib/types';

const STATE_DISPLAY: Record<TurnState, { emoji: string; label: string }> = {
  idle: { emoji: '', label: 'Ready' },
  listening: { emoji: '\uD83C\uDFA4', label: 'Listening...' },
  transcribing: { emoji: '\u270D\uFE0F', label: 'Transcribing...' },
  pending_send: { emoji: '\uD83D\uDCDD', label: 'Review & Send' },
  thinking: { emoji: '\uD83E\uDDE0', label: 'Thinking...' },
  speaking: { emoji: '\uD83D\uDD0A', label: 'Speaking...' },
};

export default function StatusIndicator() {
  const state = useTurnStore((s) => s.state);
  const { emoji, label } = STATE_DISPLAY[state];

  if (state === 'idle') {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {emoji} {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: 'center',
  },
  text: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '500',
  },
});
