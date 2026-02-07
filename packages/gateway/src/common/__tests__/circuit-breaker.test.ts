import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // CLOSED state
  // -----------------------------------------------------------------------

  describe('CLOSED state', () => {
    it('starts in closed state', () => {
      const cb = new CircuitBreaker({ name: 'test' });
      expect(cb.state).toBe('closed');
      cb.destroy();
    });

    it('allows requests in closed state', () => {
      const cb = new CircuitBreaker({ name: 'test' });
      expect(cb.canRequest()).toBe(true);
      cb.destroy();
    });

    it('stays closed when failures are below threshold', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('closed');
      expect(cb.canRequest()).toBe(true);
      cb.destroy();
    });

    it('resets failure count on success', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      // Two more failures should not trip (counter was reset)
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('closed');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // CLOSED -> OPEN transition
  // -----------------------------------------------------------------------

  describe('CLOSED -> OPEN transition', () => {
    it('transitions to open when failures reach threshold', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');
      cb.destroy();
    });

    it('rejects requests in open state', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.canRequest()).toBe(false);
      cb.destroy();
    });

    it('emits state_change event on transition', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const handler = vi.fn();
      cb.onStateChange(handler);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(handler).toHaveBeenCalledWith('closed', 'open');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Failure window expiration
  // -----------------------------------------------------------------------

  describe('Failure window expiration', () => {
    it('old failures age out of the window', () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        windowMs: 60_000,
      });
      cb.recordFailure();
      cb.recordFailure();
      // Advance past the window
      vi.advanceTimersByTime(61_000);
      cb.recordFailure();
      // Should still be closed — old failures aged out
      expect(cb.state).toBe('closed');
      cb.destroy();
    });

    it('failures within window accumulate to threshold', () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        windowMs: 60_000,
      });
      cb.recordFailure();
      vi.advanceTimersByTime(10_000);
      cb.recordFailure();
      vi.advanceTimersByTime(10_000);
      cb.recordFailure();
      expect(cb.state).toBe('open');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // OPEN -> HALF_OPEN transition
  // -----------------------------------------------------------------------

  describe('OPEN -> HALF_OPEN transition', () => {
    it('transitions to half_open after cooldown', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // Advance past cooldown (with jitter margin)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');
      cb.destroy();
    });

    it('emits state_change for open -> half_open', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      const handler = vi.fn();
      cb.onStateChange(handler);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(handler).toHaveBeenCalledWith('open', 'half_open');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // HALF_OPEN probe behavior
  // -----------------------------------------------------------------------

  describe('HALF_OPEN probe', () => {
    function tripBreaker(cb: CircuitBreaker) {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
    }

    it('allows exactly one probe request in half_open', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      tripBreaker(cb);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');

      expect(cb.canRequest()).toBe(true); // first probe allowed
      expect(cb.canRequest()).toBe(false); // second rejected while probe in flight
      cb.destroy();
    });

    it('transitions to closed on probe success', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      tripBreaker(cb);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');

      cb.canRequest(); // start probe
      cb.recordSuccess();
      expect(cb.state).toBe('closed');
      expect(cb.canRequest()).toBe(true);
      cb.destroy();
    });

    it('transitions back to open on probe failure', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      tripBreaker(cb);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');

      cb.canRequest(); // start probe
      cb.recordFailure();
      expect(cb.state).toBe('open');
      cb.destroy();
    });

    it('emits state_change for half_open -> closed', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      const handler = vi.fn();
      cb.onStateChange(handler);
      tripBreaker(cb);
      await vi.advanceTimersByTimeAsync(6_000);

      cb.canRequest();
      cb.recordSuccess();
      expect(handler).toHaveBeenCalledWith('half_open', 'closed');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Exponential backoff
  // -----------------------------------------------------------------------

  describe('Exponential backoff', () => {
    it('doubles cooldown on repeated probe failures', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
        maxCooldownMs: 120_000,
        backoffMultiplier: 2,
      });

      // Trip the breaker
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // Wait for first cooldown (~5s + jitter)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');

      // Probe fails -> back to open, cooldown should be ~10s now
      cb.canRequest();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // 6s is not enough for the doubled cooldown
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('open');

      // But 12s total should be enough (~10s + jitter)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');
      cb.destroy();
    });

    it('caps cooldown at maxCooldownMs', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 50_000,
        maxCooldownMs: 60_000,
        backoffMultiplier: 2,
      });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      await vi.advanceTimersByTimeAsync(58_000);
      expect(cb.state).toBe('half_open');

      // Probe fails -> cooldown would be 100_000 but capped at 60_000
      cb.canRequest();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // Wait ~60s + jitter -> should transition
      await vi.advanceTimersByTimeAsync(70_000);
      expect(cb.state).toBe('half_open');
      cb.destroy();
    });

    it('resets cooldown to base after probe success', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
        backoffMultiplier: 2,
      });

      // Trip, fail probe (doubles cooldown), then recover
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      await vi.advanceTimersByTimeAsync(6_000);
      cb.canRequest();
      cb.recordFailure(); // cooldown now 10s
      await vi.advanceTimersByTimeAsync(12_000);
      cb.canRequest();
      cb.recordSuccess(); // back to closed, cooldown resets

      // Trip again — cooldown should be base 5s, not 10s
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(cb.state).toBe('half_open');
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('destroy', () => {
    it('clears cooldown timer', () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        cooldownMs: 5_000,
      });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      cb.destroy();

      // Advancing time should not cause transition
      vi.advanceTimersByTime(10_000);
      expect(cb.state).toBe('open'); // stuck in open, no transition
    });
  });

  // -----------------------------------------------------------------------
  // onStateChange
  // -----------------------------------------------------------------------

  describe('onStateChange', () => {
    it('returns unsubscribe function', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const handler = vi.fn();
      const unsub = cb.onStateChange(handler);

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      // Further transitions should not call handler
      // (need to get back to closed first — destroy and recreate)
      cb.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Config defaults
  // -----------------------------------------------------------------------

  describe('config', () => {
    it('uses default config when none provided', () => {
      const cb = new CircuitBreaker();
      expect(cb.config.name).toBe('unnamed');
      expect(cb.config.failureThreshold).toBe(3);
      expect(cb.config.windowMs).toBe(60_000);
      expect(cb.config.cooldownMs).toBe(5_000);
      expect(cb.config.maxCooldownMs).toBe(120_000);
      expect(cb.config.backoffMultiplier).toBe(2);
      cb.destroy();
    });

    it('merges partial config with defaults', () => {
      const cb = new CircuitBreaker({ name: 'custom', failureThreshold: 5 });
      expect(cb.config.name).toBe('custom');
      expect(cb.config.failureThreshold).toBe(5);
      expect(cb.config.windowMs).toBe(60_000); // default
      cb.destroy();
    });
  });
});
