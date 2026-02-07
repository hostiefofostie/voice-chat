import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTurnStore } from '../stores/turnStore';

/**
 * Shows live partial transcript (stable + unstable) during the `transcribing`
 * state. The editable pending_send UI has been merged into the persistent
 * text input bar in index.tsx.
 */
export default function TranscriptBox() {
  const turnState = useTurnStore((s) => s.state);
  const stableTranscript = useTurnStore((s) => s.stableTranscript);
  const unstableTranscript = useTurnStore((s) => s.unstableTranscript);

  if (turnState !== 'transcribing') {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.transcribing}>
        <Text style={styles.stableText}>{stableTranscript}</Text>
        {unstableTranscript.length > 0 && (
          <Text style={styles.unstableText}>{unstableTranscript}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#151922',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  transcribing: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  stableText: {
    color: '#e5e7eb',
    fontSize: 15,
  },
  unstableText: {
    color: '#6b7280',
    fontSize: 15,
    fontStyle: 'italic',
  },
});
