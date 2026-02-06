import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlidingWindowRateLimiter } from '../rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within limit', () => {
    const limiter = new SlidingWindowRateLimiter(3, 1000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
  });

  it('blocks requests exceeding limit', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
    expect(limiter.check()).toBe(false);
  });

  it('allows requests after window expires', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(limiter.check()).toBe(true);
  });

  it('sliding window prunes oldest entries', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    expect(limiter.check()).toBe(true);

    vi.advanceTimersByTime(600);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false); // At limit

    // First request expires (1000ms from time 0 → at time 1000)
    vi.advanceTimersByTime(401);
    expect(limiter.check()).toBe(true); // One slot freed
  });

  it('remaining reports correct count', () => {
    const limiter = new SlidingWindowRateLimiter(5, 1000);
    expect(limiter.remaining).toBe(5);
    limiter.check();
    expect(limiter.remaining).toBe(4);
    limiter.check();
    limiter.check();
    expect(limiter.remaining).toBe(2);
  });

  it('remaining never goes negative', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1000);
    limiter.check();
    limiter.check(); // Rejected but doesn't push timestamp
    expect(limiter.remaining).toBe(0);
  });

  it('reset clears all tracked timestamps', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    limiter.check();
    limiter.check();
    expect(limiter.check()).toBe(false);

    limiter.reset();
    expect(limiter.check()).toBe(true);
    expect(limiter.remaining).toBe(1);
  });

  it('handles maxRequests of 0', () => {
    const limiter = new SlidingWindowRateLimiter(0, 1000);
    expect(limiter.check()).toBe(false);
    expect(limiter.remaining).toBe(0);
  });

  it('handles very short windows', () => {
    const limiter = new SlidingWindowRateLimiter(1, 10);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
    vi.advanceTimersByTime(11);
    expect(limiter.check()).toBe(true);
  });
});
