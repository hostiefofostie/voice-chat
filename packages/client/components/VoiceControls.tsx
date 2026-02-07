import React, { useCallback } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import VoiceButton from './VoiceButton';
import { useTurnController } from '../lib/TurnControllerContext';
import { useConfigStore } from '../stores/configStore';
import type { UseAudioCaptureReturn } from '../hooks/useAudioCapture';

interface VoiceControlsProps {
  capture: UseAudioCaptureReturn;
}

export default function VoiceControls({ capture }: VoiceControlsProps) {
  const controller = useTurnController();
  const autoSendDisabled = useConfigStore((s) => s.autoSendDisabled);
  const toggleAutoSend = useConfigStore((s) => s.toggleAutoSend);

  const handleMicToggle = useCallback(() => {
    controller.toggleMic();
  }, [controller]);

  const handleMuteToggle = useCallback(() => {
    controller.toggleMute();
  }, [controller]);

  return (
    <View style={styles.controlsRow}>
      <Pressable
        onPress={toggleAutoSend}
        style={[styles.autoSendBtn, autoSendDisabled && styles.autoSendBtnOff]}
        hitSlop={6}
      >
        <Text
          style={[
            styles.autoSendLabel,
            autoSendDisabled && styles.autoSendLabelOff,
          ]}
        >
          Auto
        </Text>
      </Pressable>
      <VoiceButton
        isCapturing={capture.isCapturing}
        isMuted={capture.isMuted}
        onToggle={handleMicToggle}
        onMute={handleMuteToggle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#0f1115',
  },
  autoSendBtn: {
    backgroundColor: '#22c55e20',
    borderWidth: 1,
    borderColor: '#22c55e',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  autoSendBtnOff: {
    backgroundColor: 'transparent',
    borderColor: '#374151',
  },
  autoSendLabel: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '600',
  },
  autoSendLabelOff: {
    color: '#6b7280',
  },
});
