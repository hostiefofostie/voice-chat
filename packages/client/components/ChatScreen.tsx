import React, { useCallback, useEffect } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';

import { useWebSocket, WebSocketHandlers } from '../hooks/useWebSocket';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useErrorRecovery, useLlmTimeoutTracker } from '../hooks/useErrorRecovery';
import { useTurnStore } from '../stores/turnStore';
import { useTurnController } from '../lib/TurnControllerContext';

import HeaderBar from './HeaderBar';
import ErrorBanner from './ErrorBanner';
import StatusIndicator from './StatusIndicator';
import ChatHistory from './ChatHistory';
import TranscriptBox from './TranscriptBox';
import MessageInput from './MessageInput';
import VoiceControls from './VoiceControls';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATEWAY_URL = (() => {
  const env = process.env.EXPO_PUBLIC_GATEWAY_URL;
  if (env) return env;
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname;
    const secure = window.location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${host}:8788/ws`;
  }
  return 'ws://localhost:8788/ws';
})();

// ---------------------------------------------------------------------------
// ChatScreen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const controller = useTurnController();
  const turnState = useTurnStore((s) => s.state);
  const errors = useErrorRecovery();

  // Track LLM timeout
  useLlmTimeoutTracker(turnState === 'thinking');

  // ---- Playback ----
  const playback = useAudioPlayback({
    onPlaybackStart: () => {},
    onPlaybackEnd: () => controller.onPlaybackEnd(),
    onChunkPlayed: () => controller.onChunkPlayed(),
  });

  // ---- WebSocket handlers -> delegate to controller ----
  const wsHandlers: WebSocketHandlers = {
    onMessage: useCallback(
      (msg) => controller.handleServerMessage(msg),
      [controller],
    ),
    onBinary: useCallback(
      (data) => controller.handleBinaryMessage(data),
      [controller],
    ),
    onConnect: useCallback(
      () => controller.handleConnect(),
      [controller],
    ),
    onDisconnect: useCallback(
      () => controller.handleDisconnect(),
      [controller],
    ),
  };

  const ws = useWebSocket(GATEWAY_URL, wsHandlers);

  // ---- Audio capture ----
  const capture = useAudioCapture({
    sendBinary: ws.sendBinary,
    onSpeechStart: useCallback(
      () => controller.onSpeechStart(),
      [controller],
    ),
    onSpeechEnd: useCallback(
      () => controller.onSpeechEnd(),
      [controller],
    ),
  });

  // ---- Keep controller refs current ----
  controller.updateRefs(ws, playback, capture);

  // ---- Attach/detach controller lifecycle ----
  useEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);

  // ---- Determine visibility ----
  const voiceDisabled = errors.wsDisconnected || errors.textOnlyMode;
  const showTranscriptBox = turnState === 'transcribing';
  const isThinking = turnState === 'thinking';

  const handleRetryLlm = useCallback(
    () => controller.retryLlm(),
    [controller],
  );
  const handleCancelLlm = useCallback(
    () => controller.cancelLlm(),
    [controller],
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <HeaderBar ws={ws} />

      <ErrorBanner
        onRetryLlm={isThinking ? handleRetryLlm : undefined}
        onCancelLlm={isThinking ? handleCancelLlm : undefined}
      />

      <StatusIndicator />

      <ChatHistory />

      {showTranscriptBox && <TranscriptBox />}

      <MessageInput
        isConnected={ws.isConnected}
        textOnlyMode={errors.textOnlyMode}
      />

      {!voiceDisabled && <VoiceControls capture={capture} />}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f1115',
  },
});
