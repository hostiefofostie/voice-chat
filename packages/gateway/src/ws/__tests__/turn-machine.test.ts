import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnMachine } from '../turn-machine.js';

describe('TurnMachine', () => {
  let machine: TurnMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    machine = new TurnMachine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('valid transitions', () => {
    it('idle -> listening', () => {
      expect(machine.transition('listening')).toBe(true);
      expect(machine.currentState).toBe('listening');
    });

    it('listening -> transcribing', () => {
      machine.transition('listening');
      expect(machine.transition('transcribing')).toBe(true);
      expect(machine.currentState).toBe('transcribing');
    });

    it('listening -> idle (barge-in cancel)', () => {
      machine.transition('listening');
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });

    it('transcribing -> pending_send', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      expect(machine.transition('pending_send')).toBe(true);
      expect(machine.currentState).toBe('pending_send');
    });

    it('pending_send -> thinking', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      expect(machine.transition('thinking')).toBe(true);
      expect(machine.currentState).toBe('thinking');
    });

    it('pending_send -> idle (cancel)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });

    it('thinking -> speaking', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('thinking');
      expect(machine.transition('speaking')).toBe(true);
      expect(machine.currentState).toBe('speaking');
    });

    it('thinking -> idle (cancel)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('thinking');
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });

    it('speaking -> idle', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('thinking');
      machine.transition('speaking');
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });

    it('speaking -> listening (barge-in)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('thinking');
      machine.transition('speaking');
      expect(machine.transition('listening')).toBe(true);
      expect(machine.currentState).toBe('listening');
    });

    it('full happy path: idle -> listening -> transcribing -> pending_send -> thinking -> speaking -> idle', () => {
      expect(machine.transition('listening')).toBe(true);
      expect(machine.transition('transcribing')).toBe(true);
      expect(machine.transition('pending_send')).toBe(true);
      expect(machine.transition('thinking')).toBe(true);
      expect(machine.transition('speaking')).toBe(true);
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });
  });

  describe('invalid transitions', () => {
    it('idle -> thinking (skip)', () => {
      expect(machine.transition('thinking')).toBe(false);
      expect(machine.currentState).toBe('idle');
    });

    it('idle -> speaking', () => {
      expect(machine.transition('speaking')).toBe(false);
      expect(machine.currentState).toBe('idle');
    });

    it('idle -> transcribing', () => {
      expect(machine.transition('transcribing')).toBe(false);
      expect(machine.currentState).toBe('idle');
    });

    it('idle -> pending_send', () => {
      expect(machine.transition('pending_send')).toBe(false);
      expect(machine.currentState).toBe('idle');
    });

    it('listening -> thinking (skip)', () => {
      machine.transition('listening');
      expect(machine.transition('thinking')).toBe(false);
      expect(machine.currentState).toBe('listening');
    });

    it('listening -> speaking (skip)', () => {
      machine.transition('listening');
      expect(machine.transition('speaking')).toBe(false);
      expect(machine.currentState).toBe('listening');
    });

    it('listening -> pending_send (skip transcribing)', () => {
      machine.transition('listening');
      expect(machine.transition('pending_send')).toBe(false);
      expect(machine.currentState).toBe('listening');
    });

    it('transcribing -> idle (valid for empty transcript/error)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      expect(machine.transition('idle')).toBe(true);
      expect(machine.currentState).toBe('idle');
    });

    it('transcribing -> thinking (skip)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      expect(machine.transition('thinking')).toBe(false);
      expect(machine.currentState).toBe('transcribing');
    });

    it('speaking -> thinking (invalid)', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('thinking');
      machine.transition('speaking');
      expect(machine.transition('thinking')).toBe(false);
      expect(machine.currentState).toBe('speaking');
    });

    it('emits invalid_transition event on bad transition', () => {
      const handler = vi.fn();
      machine.on('invalid_transition', handler);
      machine.transition('speaking');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'idle', to: 'speaking' }),
      );
    });
  });

  describe('transition events', () => {
    it('emits transition event with from, to, and turnId', () => {
      const handler = vi.fn();
      machine.on('transition', handler);
      machine.transition('listening');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'idle', to: 'listening' }),
      );
      expect(handler.mock.calls[0][0].turnId).toBeTruthy();
    });
  });

  describe('auto-send timer', () => {
    it('fires after delay when in pending_send', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend(500);

      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: machine.currentTurnId }),
      );
    });

    it('does not fire if not in pending_send', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      // Still in idle
      machine.startAutoSend(500);
      vi.advanceTimersByTime(1000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('cleared on transition away from pending_send', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend(500);

      // Transition away before timer fires
      machine.transition('thinking');
      vi.advanceTimersByTime(1000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('instant send when delay is 0', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend(0);

      // Should fire synchronously, no need to advance timers
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('uses default delay of 1500ms', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend();

      vi.advanceTimersByTime(1499);
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('setAutoSendDelay changes the default', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.setAutoSendDelay(300);
      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend();

      vi.advanceTimersByTime(299);
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not fire if state changed before timeout', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend(500);

      // Cancel from pending_send
      machine.transition('idle');
      vi.advanceTimersByTime(1000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('turnId management', () => {
    it('generates turnId on listening transition', () => {
      expect(machine.currentTurnId).toBeNull();
      machine.transition('listening');
      expect(machine.currentTurnId).toBeTruthy();
      expect(typeof machine.currentTurnId).toBe('string');
    });

    it('preserves turnId through full turn lifecycle', () => {
      machine.transition('listening');
      const turnId = machine.currentTurnId;
      machine.transition('transcribing');
      expect(machine.currentTurnId).toBe(turnId);
      machine.transition('pending_send');
      expect(machine.currentTurnId).toBe(turnId);
      machine.transition('thinking');
      expect(machine.currentTurnId).toBe(turnId);
    });

    it('allows explicit turnId override', () => {
      machine.transition('listening', 'custom-turn-123');
      expect(machine.currentTurnId).toBe('custom-turn-123');
    });

    it('reset clears turnId', () => {
      machine.transition('listening');
      expect(machine.currentTurnId).toBeTruthy();
      machine.reset();
      expect(machine.currentTurnId).toBeNull();
      expect(machine.currentState).toBe('idle');
    });

    it('generates new turnId for each listening cycle', () => {
      machine.transition('listening');
      const id1 = machine.currentTurnId;
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.transition('idle');

      // turnId should be cleared on idle transition
      expect(machine.currentTurnId).toBeNull();

      // New listening cycle gets a fresh turnId
      machine.transition('listening');
      const id2 = machine.currentTurnId;
      expect(id2).toBeTruthy();
      expect(id2).not.toBe(id1);
    });
  });

  describe('reset', () => {
    it('resets state to idle', () => {
      machine.transition('listening');
      machine.transition('transcribing');
      machine.reset();
      expect(machine.currentState).toBe('idle');
    });

    it('clears auto-send timer', () => {
      const handler = vi.fn();
      machine.on('auto_send', handler);

      machine.transition('listening');
      machine.transition('transcribing');
      machine.transition('pending_send');
      machine.startAutoSend(500);

      machine.reset();
      vi.advanceTimersByTime(1000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits reset event', () => {
      const handler = vi.fn();
      machine.on('reset', handler);
      machine.reset();
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
