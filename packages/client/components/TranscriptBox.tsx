import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTurnStore } from '../stores/turnStore';

interface TranscriptBoxProps {
  onSend: (text: string) => void;
  onCancel: () => void;
}

export default function TranscriptBox({ onSend, onCancel }: TranscriptBoxProps) {
  const turnState = useTurnStore((s) => s.state);
  const stableTranscript = useTurnStore((s) => s.stableTranscript);
  const unstableTranscript = useTurnStore((s) => s.unstableTranscript);
  const transcript = useTurnStore((s) => s.transcript);
  const autoSendDelayMs = useTurnStore((s) => s.autoSendDelayMs);

  const [editText, setEditText] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);

  // Sync transcript into edit field when entering pending_send
  useEffect(() => {
    if (turnState === 'pending_send') {
      setEditText(transcript);
      if (autoSendDelayMs > 0) {
        setCountdown(Math.ceil(autoSendDelayMs / 1000));
      }
    } else {
      setCountdown(null);
    }
  }, [turnState, transcript, autoSendDelayMs]);

  // Auto-send countdown timer
  useEffect(() => {
    if (turnState !== 'pending_send' || countdown === null || countdown <= 0) return;
    const timer = setTimeout(() => {
      setCountdown((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown, turnState]);

  // Auto-send when countdown reaches 0
  useEffect(() => {
    if (countdown === 0 && turnState === 'pending_send') {
      onSend(editText);
    }
  }, [countdown, turnState, editText, onSend]);

  const handleSend = useCallback(() => {
    if (editText.trim()) {
      onSend(editText.trim());
    }
  }, [editText, onSend]);

  const handleEdit = useCallback((text: string) => {
    setEditText(text);
    // Reset countdown when user edits
    if (autoSendDelayMs > 0) {
      setCountdown(Math.ceil(autoSendDelayMs / 1000));
    }
  }, [autoSendDelayMs]);

  if (turnState !== 'transcribing' && turnState !== 'pending_send') {
    return null;
  }

  if (turnState === 'transcribing') {
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

  // pending_send state
  return (
    <View style={styles.container}>
      <View style={styles.editRow}>
        <TextInput
          style={styles.input}
          value={editText}
          onChangeText={handleEdit}
          multiline
          autoFocus
          placeholderTextColor="#6b7280"
        />
        <View style={styles.actions}>
          {countdown !== null && countdown > 0 && (
            <Text style={styles.countdown}>{countdown}</Text>
          )}
          <Pressable onPress={handleSend} style={styles.sendBtn}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
          <Pressable onPress={onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>{'\u2715'}</Text>
          </Pressable>
        </View>
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
  editRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#0f1115',
    color: '#e5e7eb',
    fontSize: 15,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  countdown: {
    color: '#6b7280',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 16,
    textAlign: 'center',
  },
  sendBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sendText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  cancelBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: '#9ca3af',
    fontSize: 16,
  },
});
