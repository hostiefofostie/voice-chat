import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Linking, Platform } from 'react-native';
import { useErrorStore, type ErrorState } from '../hooks/useErrorRecovery';

interface ErrorBannerProps {
  onRetryLlm?: () => void;
  onCancelLlm?: () => void;
}

export default function ErrorBanner({ onRetryLlm, onCancelLlm }: ErrorBannerProps) {
  const wsDisconnected = useErrorStore((s) => s.wsDisconnected);
  const sttUnavailable = useErrorStore((s) => s.sttUnavailable);
  const ttsUnavailable = useErrorStore((s) => s.ttsUnavailable);
  const llmTimeout = useErrorStore((s) => s.llmTimeout);
  const llmTimeoutTier = useErrorStore((s) => s.llmTimeoutTier);
  const micPermissionDenied = useErrorStore((s) => s.micPermissionDenied);

  const banners: React.ReactNode[] = [];

  if (wsDisconnected) {
    banners.push(
      <View key="ws" style={[styles.banner, styles.bannerWarning]}>
        <ActivityIndicator size="small" color="#fbbf24" />
        <Text style={styles.bannerTextWarning}>Reconnecting...</Text>
      </View>,
    );
  }

  if (micPermissionDenied) {
    banners.push(
      <View key="mic" style={[styles.banner, styles.bannerError]}>
        <Text style={styles.bannerTextError}>
          Microphone access denied
        </Text>
        <Pressable
          onPress={() => {
            if (Platform.OS === 'web') {
              // On web, user must update browser permissions manually
            } else {
              Linking.openSettings();
            }
          }}
          style={styles.bannerAction}
        >
          <Text style={styles.bannerActionText}>Open Settings</Text>
        </Pressable>
      </View>,
    );
  }

  if (sttUnavailable) {
    banners.push(
      <View key="stt" style={[styles.banner, styles.bannerInfo]}>
        <Text style={styles.bannerTextInfo}>
          Speech recognition unavailable — using text input
        </Text>
      </View>,
    );
  }

  if (ttsUnavailable) {
    banners.push(
      <View key="tts" style={[styles.banner, styles.bannerInfo]}>
        <Text style={styles.bannerTextInfo}>
          Voice output unavailable — text only
        </Text>
      </View>,
    );
  }

  if (llmTimeout) {
    banners.push(
      <View key="llm" style={[styles.banner, styles.bannerWarning]}>
        {llmTimeoutTier < 2 ? (
          <>
            <ActivityIndicator size="small" color="#fbbf24" />
            <Text style={styles.bannerTextWarning}>Still thinking...</Text>
          </>
        ) : (
          <>
            <Text style={styles.bannerTextWarning}>Taking longer than usual</Text>
            {onRetryLlm && (
              <Pressable onPress={onRetryLlm} style={styles.bannerAction}>
                <Text style={styles.bannerActionText}>Retry</Text>
              </Pressable>
            )}
          </>
        )}
        {onCancelLlm && (
          <Pressable onPress={onCancelLlm} style={styles.bannerActionSecondary}>
            <Text style={styles.bannerActionSecondaryText}>Cancel</Text>
          </Pressable>
        )}
      </View>,
    );
  }

  if (banners.length === 0) return null;

  return <View style={styles.container}>{banners}</View>;
}

const styles = StyleSheet.create({
  container: {
    gap: 2,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bannerWarning: {
    backgroundColor: '#422006',
  },
  bannerError: {
    backgroundColor: '#450a0a',
  },
  bannerInfo: {
    backgroundColor: '#172554',
  },
  bannerTextWarning: {
    color: '#fbbf24',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  bannerTextError: {
    color: '#fca5a5',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  bannerTextInfo: {
    color: '#93c5fd',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  bannerAction: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  bannerActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  bannerActionSecondary: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  bannerActionSecondaryText: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '500',
  },
});
