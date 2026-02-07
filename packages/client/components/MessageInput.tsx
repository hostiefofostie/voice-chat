import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTurnController } from '../lib/TurnControllerContext';
import { useTurnStore } from '../stores/turnStore';

interface MessageInputProps {
  isConnected: boolean;
  textOnlyMode: boolean;
}

export default function MessageInput({ isConnected, textOnlyMode }: MessageInputProps) {
  const controller = useTurnController();
  const turnState = useTurnStore((s) => s.state);
  const transcript = useTurnStore((s) => s.transcript);
  const isPendingSend = turnState === 'pending_send';

  const [textInput, setTextInput] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);

  // Subscribe to controller countdown changes
  useEffect(() => {
    controller.onCountdownChange = setCountdown;
    return () => {
      controller.onCountdownChange = null;
    };
  }, [controller]);

  // When entering pending_send, populate text input with the transcript
  useEffect(() => {
    if (isPendingSend && transcript) {
      setTextInput(transcript);
    } else if (!isPendingSend) {
      // Don't clear text when leaving pending_send via send (user already cleared it)
    }
  }, [isPendingSend, transcript]);

  const handleTextChange = useCallback(
    (text: string) => {
      setTextInput(text);
      controller.onTextChange(text);
    },
    [controller],
  );

  const handleSend = useCallback(() => {
    const text = textInput.trim();
    if (!text) return;
    controller.send(text);
    setTextInput('');
  }, [textInput, controller]);

  const handleCancel = useCallback(() => {
    controller.cancelTranscript();
    setTextInput('');
  }, [controller]);

  return (
    <View style={styles.textInputRow}>
      <TextInput
        style={[styles.textInput, isPendingSend && styles.textInputPending]}
        value={textInput}
        onChangeText={handleTextChange}
        placeholder={
          textOnlyMode
            ? 'Voice unavailable \u2014 type your message...'
            : 'Type a message...'
        }
        placeholderTextColor="#6b7280"
        returnKeyType="send"
        onSubmitEditing={handleSend}
        editable={isConnected}
        multiline
        blurOnSubmit
      />
      {countdown !== null && countdown > 0 && (
        <Text style={styles.countdown}>{countdown}</Text>
      )}
      <Pressable
        onPress={handleSend}
        style={[
          styles.textSendBtn,
          (!textInput.trim() || !isConnected) && styles.textSendBtnDisabled,
        ]}
        disabled={!textInput.trim() || !isConnected}
      >
        <Text style={styles.textSendText}>Send</Text>
      </Pressable>
      {isPendingSend && (
        <Pressable onPress={handleCancel} style={styles.cancelBtn} hitSlop={4}>
          <Text style={styles.cancelText}>{'\u2715'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  textInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#151922',
    gap: 8,
  },
  textInput: {
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
  textInputPending: {
    borderColor: '#3b82f6',
  },
  countdown: {
    color: '#6b7280',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 16,
    textAlign: 'center',
  },
  textSendBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  textSendBtnDisabled: {
    opacity: 0.4,
  },
  textSendText: {
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
