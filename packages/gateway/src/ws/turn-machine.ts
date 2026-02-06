import { TurnState, VALID_TRANSITIONS } from '../types.js';
import { EventEmitter } from 'events';

interface TransitionEvent {
  from: TurnState;
  to: TurnState;
  turnId: string | null;
}

export class TurnMachine extends EventEmitter {
  private state: TurnState = 'idle';
  private turnId: string | null = null;
  private autoSendTimer: NodeJS.Timeout | null = null;
  private autoSendDelayMs: number = 1500;

  get currentState(): TurnState { return this.state; }
  get currentTurnId(): string | null { return this.turnId; }

  transition(to: TurnState, turnId?: string): boolean {
    const validTargets = VALID_TRANSITIONS[this.state];
    if (!validTargets.includes(to)) {
      this.emit('invalid_transition', { from: this.state, to, turnId });
      return false;
    }

    const from = this.state;
    this.state = to;
    if (turnId) this.turnId = turnId;

    // Clear turnId when returning to idle so next turn gets a fresh one
    if (to === 'idle') {
      this.turnId = null;
    }

    // Generate new turnId on transition to listening
    if (to === 'listening' && !this.turnId) {
      this.turnId = crypto.randomUUID();
    }

    // Clear auto-send timer on any transition away from pending_send
    if (from === 'pending_send') {
      this.clearAutoSend();
    }

    this.emit('transition', { from, to, turnId: this.turnId } as TransitionEvent);
    return true;
  }

  startAutoSend(delayMs?: number) {
    this.clearAutoSend();
    if (this.state !== 'pending_send') return;
    const delay = delayMs ?? this.autoSendDelayMs;
    if (delay <= 0) {
      this.emit('auto_send', { turnId: this.turnId });
      return;
    }
    this.autoSendTimer = setTimeout(() => {
      if (this.state === 'pending_send') {
        this.emit('auto_send', { turnId: this.turnId });
      }
    }, delay);
  }

  setAutoSendDelay(ms: number) {
    this.autoSendDelayMs = ms;
  }

  reset() {
    this.clearAutoSend();
    this.state = 'idle';
    this.turnId = null;
    this.emit('reset', {});
  }

  private clearAutoSend() {
    if (this.autoSendTimer) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
  }
}
