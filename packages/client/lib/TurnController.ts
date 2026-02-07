import type { UseWebSocketReturn } from '../hooks/useWebSocket';
import type { UseAudioPlaybackReturn, TtsChunkMeta } from '../hooks/useAudioPlayback';
import type { UseAudioCaptureReturn } from '../hooks/useAudioCapture';
import type { ServerMessage } from './types';
import { useTurnStore } from '../stores/turnStore';
import { useChatStore } from '../stores/chatStore';
import { useErrorStore } from '../hooks/useErrorRecovery';
import { useConfigStore } from '../stores/configStore';

// ---------------------------------------------------------------------------
// TurnController — non-React class that owns the turn lifecycle
// ---------------------------------------------------------------------------

/**
 * Manages the entire voice turn lifecycle outside React.
 *
 * Responsibilities:
 * - Routes WebSocket messages to the correct stores
 * - Manages tts_meta / binary pairing via a FIFO queue (fixes race condition)
 * - Handles barge-in, cancel, retry logic
 * - Manages auto-send countdown via setTimeout (fixes React batching race)
 * - Provides RAF-batched LLM token updates (reduces re-renders from 100/s to 60/s)
 * - Syncs config store changes to the server
 */
export class TurnController {
  // References to hooks — updated every render via updateRefs()
  private ws: UseWebSocketReturn | null = null;
  private playback: UseAudioPlaybackReturn | null = null;
  private capture: UseAudioCaptureReturn | null = null;

  // tts_meta / binary pairing — FIFO queue instead of single ref
  private pendingTtsMetaQueue: TtsChunkMeta[] = [];

  // Auto-send countdown
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null;
  private _countdown: number | null = null;
  private countdownTickTimer: ReturnType<typeof setTimeout> | null = null;
  onCountdownChange: ((c: number | null) => void) | null = null;

  // Text input state (mirrors React state, used for auto-send)
  private _textInput = '';

  // RAF batching for llm_token
  private pendingLlmText: string | null = null;
  private rafId: number | null = null;

  // Config sync subscription
  private configUnsub: (() => void) | null = null;

  // Whether the controller is attached
  private attached = false;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    // Subscribe to config store changes and push to server
    this.configUnsub = useConfigStore.subscribe((state, prev) => {
      if (state.config !== prev.config && this.ws) {
        this.ws.send({ type: 'config', settings: state.config });
        useTurnStore.setState({ autoSendDelayMs: state.config.autoSendDelayMs });
      }
    });
  }

  detach(): void {
    this.attached = false;
    this.clearAutoSend();
    this.cancelRaf();
    if (this.configUnsub) {
      this.configUnsub();
      this.configUnsub = null;
    }
  }

  /** Called every render to keep hook references current. */
  updateRefs(
    ws: UseWebSocketReturn,
    playback: UseAudioPlaybackReturn,
    capture: UseAudioCaptureReturn,
  ): void {
    this.ws = ws;
    this.playback = playback;
    this.capture = capture;
  }

  // -----------------------------------------------------------------------
  // WebSocket message routing
  // -----------------------------------------------------------------------

  handleServerMessage(msg: ServerMessage): void {
    const turnStore = useTurnStore.getState();
    const errorStore = useErrorStore.getState();

    switch (msg.type) {
      case 'transcript_partial':
        turnStore.setPartialTranscript(msg.stable, msg.unstable);
        break;

      case 'transcript_final':
        turnStore.setTranscript(msg.text);
        turnStore.reconcile('pending_send', msg.turnId);
        errorStore.reportSttSuccess();
        // Start auto-send countdown
        this._textInput = msg.text;
        this.onCountdownChange?.(null); // signal text change
        this.startAutoSend();
        break;

      case 'llm_token':
        this.handleLlmToken(msg.token, msg.fullText);
        break;

      case 'llm_done':
        this.handleLlmDone(msg.fullText);
        break;

      case 'chat_history':
        useChatStore.getState().setMessages(msg.messages);
        break;

      case 'tts_meta':
        this.pendingTtsMetaQueue.push({
          format: msg.format,
          index: msg.index,
          sampleRate: msg.sampleRate,
          durationMs: msg.durationMs,
        });
        break;

      case 'tts_done':
        this.playback?.markDone();
        break;

      case 'turn_state':
        turnStore.reconcile(msg.state, msg.turnId);
        break;

      case 'error': {
        if (msg.code.startsWith('stt')) {
          errorStore.reportSttError();
        } else if (msg.code.startsWith('tts')) {
          errorStore.reportTtsError();
        } else if (msg.code.startsWith('llm')) {
          errorStore.reportLlmTimeout(2);
        }
        if (!msg.recoverable) {
          turnStore.reset();
        }
        break;
      }

      case 'pong':
        // Latency handled internally by useWebSocket
        break;

      case 'command_result':
        break;
    }
  }

  handleBinaryMessage(data: ArrayBuffer): void {
    const meta = this.pendingTtsMetaQueue.shift();
    if (meta) {
      this.playback?.queueChunk(meta, data);
    }
  }

  handleConnect(): void {
    useErrorStore.getState().setWsDisconnected(false);
    const config = useConfigStore.getState().config;
    this.ws?.send({ type: 'config', settings: config });
  }

  handleDisconnect(): void {
    useErrorStore.getState().setWsDisconnected(true);
    useTurnStore.getState().reset();
    this.clearAutoSend();
    this.pendingTtsMetaQueue = [];
  }

  // -----------------------------------------------------------------------
  // User actions
  // -----------------------------------------------------------------------

  /** Send text (typed or pending transcript). */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.ws) return;

    // Warm up AudioContext on user gesture
    this.playback?.warmup?.().catch(() => {});

    const turnState = useTurnStore.getState().state;
    const turnId =
      turnState === 'pending_send'
        ? (useTurnStore.getState().turnId ?? crypto.randomUUID())
        : crypto.randomUUID();

    useChatStore.getState().addMessage({ role: 'user', text: trimmed });
    this.ws.send({ type: 'transcript_send', text: trimmed, turnId });
    useTurnStore.getState().reconcile('thinking', turnId);
    this._textInput = '';
    this.clearAutoSend();
  }

  cancelTranscript(): void {
    this.ws?.send({ type: 'cancel' });
    useTurnStore.getState().reset();
    this._textInput = '';
    this.clearAutoSend();
    useErrorStore.getState().reportLlmDone();
  }

  retryLlm(): void {
    this.ws?.send({ type: 'cancel' });
    useTurnStore.getState().reset();
    useErrorStore.getState().reportLlmDone();

    const messages = useChatStore.getState().messages;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser && this.ws) {
      const turnId = crypto.randomUUID();
      this.ws.send({ type: 'transcript_send', text: lastUser.text, turnId });
      useTurnStore.getState().reconcile('thinking', turnId);
    }
  }

  cancelLlm(): void {
    this.ws?.send({ type: 'cancel' });
    useTurnStore.getState().reset();
    useErrorStore.getState().reportLlmDone();
  }

  /** VAD speech start — handles barge-in logic. */
  onSpeechStart(): void {
    const currentState = useTurnStore.getState().state;
    const store = useTurnStore.getState();

    if (currentState === 'speaking') {
      // Barge-in: user starts speaking during playback
      this.playback?.stop();
      this.ws?.send({ type: 'barge_in' });
      store.reconcile('listening');
    } else if (currentState === 'idle') {
      store.transition('listening');
    } else if (
      currentState === 'pending_send' ||
      currentState === 'transcribing' ||
      currentState === 'listening'
    ) {
      store.reconcile('listening');
    } else {
      // Speaking during thinking — cancel and restart
      this.ws?.send({ type: 'cancel' });
      store.reconcile('listening');
    }
  }

  /** VAD speech end. */
  onSpeechEnd(): void {
    useTurnStore.getState().transition('transcribing');
  }

  /** User edited text in the input box. */
  onTextChange(text: string): void {
    this._textInput = text;
    if (useTurnStore.getState().state === 'pending_send') {
      this.resetAutoSendCountdown();
    }
  }

  /** Toggle microphone on/off. */
  async toggleMic(): Promise<void> {
    if (!this.capture) return;
    if (this.capture.isCapturing) {
      this.capture.stop();
    } else {
      try { await this.playback?.warmup?.(); } catch {}
      try {
        await this.capture.start();
      } catch {
        useErrorStore.getState().reportMicDenied();
      }
    }
  }

  /** Toggle mute/unmute. */
  toggleMute(): void {
    if (!this.capture) return;
    if (this.capture.isMuted) {
      this.capture.unmute();
    } else {
      this.capture.mute();
    }
  }

  // -----------------------------------------------------------------------
  // Playback callbacks
  // -----------------------------------------------------------------------

  onPlaybackEnd(): void {
    const current = useTurnStore.getState().state;
    if (current === 'speaking') {
      useTurnStore.getState().reconcile('idle');
    }
  }

  onChunkPlayed(): void {
    useErrorStore.getState().reportTtsSuccess();
  }

  // -----------------------------------------------------------------------
  // Auto-send countdown (setTimeout-based, no React batching race)
  // -----------------------------------------------------------------------

  get countdown(): number | null {
    return this._countdown;
  }

  get textInput(): string {
    return this._textInput;
  }

  private startAutoSend(): void {
    this.clearAutoSend();
    const asd = useConfigStore.getState().autoSendDisabled;
    const delay = useTurnStore.getState().autoSendDelayMs;
    if (asd || delay <= 0) return;

    this._countdown = Math.ceil(delay / 1000);
    this.onCountdownChange?.(this._countdown);
    this.startCountdownTick();
  }

  private resetAutoSendCountdown(): void {
    this.clearAutoSend();
    const asd = useConfigStore.getState().autoSendDisabled;
    const delay = useTurnStore.getState().autoSendDelayMs;
    if (asd || delay <= 0) return;

    this._countdown = Math.ceil(delay / 1000);
    this.onCountdownChange?.(this._countdown);
    this.startCountdownTick();
  }

  private startCountdownTick(): void {
    if (this.countdownTickTimer) clearTimeout(this.countdownTickTimer);

    this.countdownTickTimer = setTimeout(() => {
      this.countdownTickTimer = null;
      if (this._countdown === null) return;

      this._countdown -= 1;
      this.onCountdownChange?.(this._countdown);

      if (this._countdown <= 0) {
        // Auto-send
        const text = this._textInput.trim();
        const turnState = useTurnStore.getState().state;
        if (text && turnState === 'pending_send') {
          this.send(text);
        }
        this._countdown = null;
        this.onCountdownChange?.(null);
      } else {
        this.startCountdownTick();
      }
    }, 1000);
  }

  private clearAutoSend(): void {
    if (this.autoSendTimer) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
    if (this.countdownTickTimer) {
      clearTimeout(this.countdownTickTimer);
      this.countdownTickTimer = null;
    }
    if (this._countdown !== null) {
      this._countdown = null;
      this.onCountdownChange?.(null);
    }
  }

  // -----------------------------------------------------------------------
  // RAF-batched LLM token updates
  // -----------------------------------------------------------------------

  private handleLlmToken(_token: string, fullText: string): void {
    this.pendingLlmText = fullText;
    useErrorStore.getState().reportLlmToken();

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        if (this.pendingLlmText !== null) {
          useTurnStore.getState().appendLlmToken('', this.pendingLlmText);
          this.pendingLlmText = null;
        }
      });
    }
  }

  private handleLlmDone(fullText: string): void {
    // Cancel pending RAF and flush
    this.cancelRaf();
    this.pendingLlmText = null;

    useChatStore.getState().addMessage({ role: 'assistant', text: fullText });
    // Clear streaming text so ChatHistory doesn't show duplicate
    useTurnStore.getState().appendLlmToken('', '');
    useErrorStore.getState().reportLlmDone();
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
