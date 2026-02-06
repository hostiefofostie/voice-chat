import React, { useEffect, useRef } from 'react';
import { Pressable, View, Text, StyleSheet, Animated } from 'react-native';

interface VoiceButtonProps {
  isCapturing: boolean;
  isMuted: boolean;
  onToggle: () => void;
  onMute: () => void;
}

export default function VoiceButton({ isCapturing, isMuted, onToggle, onMute }: VoiceButtonProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isCapturing && !isMuted) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isCapturing, isMuted, pulseAnim]);

  const buttonColor = isCapturing && !isMuted
    ? '#ef4444'
    : isMuted
      ? '#4b5563'
      : '#374151';

  return (
    <View style={styles.container}>
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <Pressable
          onPress={onToggle}
          style={[styles.button, { backgroundColor: buttonColor }]}
        >
          <Text style={styles.micIcon}>
            {isMuted ? '\uD83C\uDFA4' : '\uD83C\uDFA4'}
          </Text>
          {isMuted && <View style={styles.strikethrough} />}
        </Pressable>
      </Animated.View>
      {isCapturing && (
        <Pressable onPress={onMute} style={styles.muteBtn}>
          <Text style={styles.muteText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 10,
  },
  button: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  micIcon: {
    fontSize: 28,
  },
  strikethrough: {
    position: 'absolute',
    width: 40,
    height: 3,
    backgroundColor: '#ef4444',
    borderRadius: 2,
    transform: [{ rotate: '-45deg' }],
  },
  muteBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
  },
  muteText: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '500',
  },
});
