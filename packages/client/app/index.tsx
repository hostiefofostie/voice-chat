import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Link } from 'expo-router';

import { useWebSocket, WebSocketHandlers } from '../hooks/useWebSocket';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { useAudioPlayback, TtsChunkMeta } from '../hooks/useAudioPlayback';
import { useErrorRecovery, useErrorStore, useLlmTimeoutTracker } from '../hooks/useErrorRecovery';
import { useTurnStore } from '../stores/turnStore';
import { useChatStore } from '../stores/chatStore';
import { useConfigStore } from '../stores/configStore';
import ChatHistory from '../components/ChatHistory';
import TranscriptBox from '../components/TranscriptBox';
import StatusIndicator from '../components/StatusIndicator';
import VoiceButton from '../components/VoiceButton';
import ErrorBanner from '../components/ErrorBanner';
import type { ServerMessage } from '../lib/types';

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
// Main Screen
// ---------------------------------------------------------------------------

export default function Index() {
  // ---- Stores ----
  const turnState = useTurnStore((s) => s.state);
  const transition = useTurnStore((s) => s.transition);
  const reconcile = useTurnStore((s) => s.reconcile);
  const setPartialTranscript = useTurnStore((s) => s.setPartialTranscript);
  const setTranscript = useTurnStore((s) => s.setTranscript);
  const appendLlmToken = useTurnStore((s) => s.appendLlmToken);
  const resetTurn = useTurnStore((s) => s.reset);
  const addMessage = useChatStore((s) => s.addMessage);

  // ---- Error recovery ----
  const errors = useErrorRecovery();

  // Track LLM timeout (15s / 30s tiers) while in thinking state
  useLlmTimeoutTracker(turnState === 'thinking');

  // ---- Text input mode ----
  const [textInput, setTextInput] = useState('');

  // ---- tts_meta + binary pairing ----
  const pendingTtsMetaRef = useRef<TtsChunkMeta | null>(null);

  // ---- Playback (declared before ws handlers so we can reference stop) ----
  const playback = useAudioPlayback({
    onPlaybackStart: () => {
      // State is driven by server turn_state messages
    },
    onPlaybackEnd: () => {
      transition('idle');
    },
    onChunkPlayed: () => {
      // Auto-recovery: successful TTS chunk means TTS is working
      useErrorStore.getState().reportTtsSuccess();
    },
  });

  // We need a stable ref for playback.stop so the ws handler can call it
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  // ---- Ref to ws for use in callbacks before ws is declared ----
  const wsRef = useRef<ReturnType<typeof useWebSocket> | null>(null);

  // ---- WebSocket handlers ----
  const wsHandlers: WebSocketHandlers = {
    onMessage: useCallback(
      (msg: ServerMessage) => {
        switch (msg.type) {
          case 'transcript_partial':
            setPartialTranscript(msg.stable, msg.unstable);
            break;

          case 'transcript_final':
            setTranscript(msg.text);
            reconcile('pending_send', msg.turnId);
            // Auto-recovery: successful transcription means STT is working
            useErrorStore.getState().reportSttSuccess();
            break;

          case 'llm_token':
            appendLlmToken(msg.token, msg.fullText);
            // Auto-recovery: receiving tokens clears LLM timeout
            useErrorStore.getState().reportLlmToken();
            break;

          case 'llm_done':
            addMessage({ role: 'assistant', text: msg.fullText });
            // Don't resetTurn() here — the server will transition to 'speaking'
            // for TTS playback. Let the server-authoritative turn_state drive it.
            // Clear the streaming LLM text so ChatHistory doesn't show it as a
            // duplicate of the just-added persistent message.
            useTurnStore.getState().appendLlmToken('', '');
            useErrorStore.getState().reportLlmDone();
            break;

          case 'tts_meta':
            pendingTtsMetaRef.current = {
              format: msg.format,
              index: msg.index,
              sampleRate: msg.sampleRate,
              durationMs: msg.durationMs,
            };
            break;

          case 'tts_done':
            // Signal the playback hook that no more audio chunks will arrive.
            // Without this, playNext() can't tell "waiting for more chunks"
            // from "all chunks played" when the queue drains.
            playbackRef.current.markDone();
            break;

          case 'turn_state':
            reconcile(msg.state, msg.turnId);
            break;

          case 'error': {
            // Route errors to the error recovery system instead of Alert
            const errStore = useErrorStore.getState();
            if (msg.code.startsWith('stt')) {
              errStore.reportSttError();
            } else if (msg.code.startsWith('tts')) {
              errStore.reportTtsError();
            } else if (msg.code.startsWith('llm')) {
              errStore.reportLlmTimeout(2);
            }
            if (!msg.recoverable) {
              resetTurn();
            }
            break;
          }

          case 'pong':
            // Latency handled internally by useWebSocket
            break;

          case 'command_result':
            // Could surface in chat; for now ignore
            break;
        }
      },
      [
        setPartialTranscript,
        setTranscript,
        reconcile,
        appendLlmToken,
        addMessage,
        resetTurn,
      ],
    ),

    onBinary: useCallback((data: ArrayBuffer) => {
      const meta = pendingTtsMetaRef.current;
      if (meta) {
        pendingTtsMetaRef.current = null;
        playbackRef.current.queueChunk(meta, data);
      }
    }, []),

    onConnect: useCallback(() => {
      // Auto-recovery: WS connected, clear disconnect error
      useErrorStore.getState().setWsDisconnected(false);
      // Send current config to server so it knows our preferences
      const config = useConfigStore.getState().config;
      wsRef.current?.send({ type: 'config', settings: config });
    }, []),

    onDisconnect: useCallback(() => {
      useErrorStore.getState().setWsDisconnected(true);
      resetTurn();
    }, [resetTurn]),
  };

  const ws = useWebSocket(GATEWAY_URL, wsHandlers);
  wsRef.current = ws;

  // ---- Sync config store changes to server ----
  useEffect(() => {
    const unsub = useConfigStore.subscribe((state, prev) => {
      if (state.config !== prev.config && wsRef.current) {
        wsRef.current.send({ type: 'config', settings: state.config });
        // Also sync auto-send delay to the turn store
        useTurnStore.setState({ autoSendDelayMs: state.config.autoSendDelayMs });
      }
    });
    return unsub;
  }, []);

  // ---- Audio capture ----
  const capture = useAudioCapture({
    sendBinary: ws.sendBinary,
    onSpeechStart: useCallback(() => {
      const currentState = useTurnStore.getState().state;
      if (currentState === 'speaking') {
        // Barge-in: user starts speaking during playback
        playbackRef.current.stop();
        wsRef.current?.send({ type: 'barge_in' });
        reconcile('listening');
      } else if (currentState === 'idle') {
        transition('listening');
      } else if (
        currentState === 'pending_send' ||
        currentState === 'transcribing' ||
        currentState === 'listening'
      ) {
        // User resumed speaking mid-turn — don't cancel, just go back to listening.
        // The server will accumulate the transcript across segments.
        // `listening` can appear here when a server turn_state message arrives
        // between VAD speech segments (race between server reconcile and VAD events).
        reconcile('listening');
      } else {
        // Speaking during thinking — cancel and restart
        wsRef.current?.send({ type: 'cancel' });
        reconcile('listening');
      }
    }, [transition, reconcile]),
    onSpeechEnd: useCallback(() => {
      transition('transcribing');
    }, [transition]),
  });

  // ---- Detect mic permission denied from capture hook ----
  // The useAudioCapture hook logs the error but doesn't expose a denied state.
  // We wrap the mic toggle to detect permission denial.
  const handleMicToggle = useCallback(async () => {
    if (capture.isCapturing) {
      capture.stop();
    } else {
      // Start capture directly — useAudioCapture already handles getUserMedia
      // and logs permission denial. We catch here to report it to the error store.
      try {
        await capture.start();
        // If start() didn't throw but isCapturing is still false after a tick,
        // the permission was denied (useAudioCapture returns early on denial).
        // We use a microtask to let state update, but the hook logs internally.
      } catch {
        useErrorStore.getState().reportMicDenied();
      }
    }
  }, [capture]);

  // ---- Countdown for auto-send ----
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoSendDelayMs = useTurnStore((s) => s.autoSendDelayMs);

  // When entering pending_send, populate the text input with the transcript
  const transcript = useTurnStore((s) => s.transcript);
  useEffect(() => {
    if (turnState === 'pending_send' && transcript) {
      setTextInput(transcript);
      const asd = useConfigStore.getState().autoSendDisabled;
      const delay = useTurnStore.getState().autoSendDelayMs;
      if (!asd && delay > 0) {
        setCountdown(Math.ceil(delay / 1000));
      } else {
        setCountdown(null);
      }
    } else if (turnState !== 'pending_send') {
      setCountdown(null);
    }
  }, [turnState, transcript]);

  // Countdown timer tick
  useEffect(() => {
    if (turnState !== 'pending_send' || countdown === null || countdown <= 0) return;
    const timer = setTimeout(() => {
      setCountdown((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown, turnState]);

  // Auto-send when countdown reaches 0
  const textInputRef = useRef(textInput);
  textInputRef.current = textInput;
  useEffect(() => {
    if (countdown === 0 && turnState === 'pending_send') {
      const text = textInputRef.current.trim();
      if (!text) return;
      const turnId = useTurnStore.getState().turnId ?? crypto.randomUUID();
      addMessage({ role: 'user', text });
      ws.send({ type: 'transcript_send', text, turnId });
      reconcile('thinking', turnId);
      setTextInput('');
    }
  }, [countdown, turnState, addMessage, ws, reconcile]);

  // ---- Unified send handler (works for both typed text and pending transcript) ----
  const handleSend = useCallback(() => {
    const text = textInput.trim();
    if (!text) return;
    // In pending_send, use the existing turnId; otherwise create a new one
    const turnId =
      turnState === 'pending_send'
        ? (useTurnStore.getState().turnId ?? crypto.randomUUID())
        : crypto.randomUUID();
    addMessage({ role: 'user', text });
    ws.send({ type: 'transcript_send', text, turnId });
    reconcile('thinking', turnId);
    setTextInput('');
    setCountdown(null);
  }, [textInput, turnState, addMessage, ws, reconcile]);

  const handleCancelTranscript = useCallback(() => {
    ws.send({ type: 'cancel' });
    resetTurn();
    setTextInput('');
    setCountdown(null);
    useErrorStore.getState().reportLlmDone();
  }, [ws, resetTurn]);

  // Reset countdown when user edits text during pending_send
  const handleTextChange = useCallback((text: string) => {
    setTextInput(text);
    if (useTurnStore.getState().state === 'pending_send') {
      const asd = useConfigStore.getState().autoSendDisabled;
      const delay = useTurnStore.getState().autoSendDelayMs;
      if (!asd && delay > 0) {
        setCountdown(Math.ceil(delay / 1000));
      }
    }
  }, []);

  // ---- LLM retry: resend the last user message ----
  const handleRetryLlm = useCallback(() => {
    ws.send({ type: 'cancel' });
    resetTurn();
    useErrorStore.getState().reportLlmDone();
    // Resend last user message
    const messages = useChatStore.getState().messages;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const turnId = crypto.randomUUID();
      ws.send({ type: 'transcript_send', text: lastUser.text, turnId });
      reconcile('thinking', turnId);
    }
  }, [ws, resetTurn, reconcile]);

  // ---- LLM cancel ----
  const handleCancelLlm = useCallback(() => {
    ws.send({ type: 'cancel' });
    resetTurn();
    useErrorStore.getState().reportLlmDone();
  }, [ws, resetTurn]);

  const handleMuteToggle = useCallback(() => {
    if (capture.isMuted) {
      capture.unmute();
    } else {
      capture.mute();
    }
  }, [capture]);

  // ---- Auto-send toggle ----
  const autoSendDisabled = useConfigStore((s) => s.autoSendDisabled);
  const toggleAutoSend = useConfigStore((s) => s.toggleAutoSend);

  // ---- Determine visibility ----
  const voiceDisabled =
    errors.wsDisconnected || errors.textOnlyMode;
  const showTranscriptBox = turnState === 'transcribing';
  const isPendingSend = turnState === 'pending_send';
  const isThinking = turnState === 'thinking';

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Header bar with connection status + settings gear */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View
            style={[
              styles.connDot,
              ws.isConnected ? styles.connDotOnline : styles.connDotOffline,
            ]}
          />
          <Text style={styles.headerTitle}>
            {ws.isConnected
              ? ws.latencyMs !== null
                ? `${ws.latencyMs}ms`
                : 'Connected'
              : ws.isReconnecting
                ? 'Reconnecting...'
                : 'Disconnected'}
          </Text>
        </View>
        <Link href="/settings" asChild>
          <Pressable style={styles.gearBtn} hitSlop={8}>
            <Text style={styles.gearIcon}>{'\u2699\uFE0F'}</Text>
          </Pressable>
        </Link>
      </View>

      {/* Error Banners */}
      <ErrorBanner
        onRetryLlm={isThinking ? handleRetryLlm : undefined}
        onCancelLlm={isThinking ? handleCancelLlm : undefined}
      />

      {/* Status Indicator */}
      <StatusIndicator />

      {/* Chat History */}
      <ChatHistory />

      {/* Transcript Box (transcribing only — live partial transcript) */}
      {showTranscriptBox && <TranscriptBox />}

      {/* Persistent text input — also used for editing transcripts in pending_send */}
      <View style={styles.textInputRow}>
        <TextInput
          style={[
            styles.textInput,
            isPendingSend && styles.textInputPending,
          ]}
          value={textInput}
          onChangeText={handleTextChange}
          placeholder={
            errors.textOnlyMode
              ? 'Voice unavailable — type your message...'
              : 'Type a message...'
          }
          placeholderTextColor="#6b7280"
          returnKeyType="send"
          onSubmitEditing={handleSend}
          editable={ws.isConnected}
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
            (!textInput.trim() || !ws.isConnected) && styles.textSendBtnDisabled,
          ]}
          disabled={!textInput.trim() || !ws.isConnected}
        >
          <Text style={styles.textSendText}>Send</Text>
        </Pressable>
        {isPendingSend && (
          <Pressable onPress={handleCancelTranscript} style={styles.cancelBtn} hitSlop={4}>
            <Text style={styles.cancelText}>{'\u2715'}</Text>
          </Pressable>
        )}
      </View>

      {/* Voice controls — hidden when voice is disabled */}
      {!voiceDisabled && (
        <View style={styles.controlsRow}>
          <Pressable
            onPress={toggleAutoSend}
            style={[
              styles.autoSendBtn,
              autoSendDisabled && styles.autoSendBtnOff,
            ]}
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
      )}
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f1115',
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connDotOnline: {
    backgroundColor: '#22c55e',
  },
  connDotOffline: {
    backgroundColor: '#ef4444',
  },
  headerTitle: {
    color: '#9ca3af',
    fontSize: 13,
  },
  gearBtn: {
    padding: 4,
  },
  gearIcon: {
    fontSize: 22,
  },
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
