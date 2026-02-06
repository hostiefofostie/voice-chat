/**
 * Sliding window rate limiter.
 *
 * Tracks individual request timestamps and prunes expired entries on each
 * call. This gives smoother enforcement than fixed-window or token-bucket
 * approaches — a burst that fills the window will gradually unlock as the
 * oldest timestamps age out.
 */
export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  /** Record a request and return true if allowed, false if rate-limited. */
  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }

  /** How many requests remain in the current window. */
  get remaining(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  /** Clear all tracked timestamps (e.g. on disconnect). */
  reset() {
    this.timestamps = [];
  }
}
