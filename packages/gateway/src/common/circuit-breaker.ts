import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Name for logging/metrics. */
  name: string;
  /** Number of failures within `windowMs` to trip the breaker. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). */
  windowMs: number;
  /** Initial cooldown before entering half_open (ms). */
  cooldownMs: number;
  /** Maximum cooldown after repeated probe failures (ms). */
  maxCooldownMs: number;
  /** Backoff multiplier for cooldown on repeated probe failures. */
  backoffMultiplier: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  name: 'unnamed',
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 5_000,
  maxCooldownMs: 120_000,
  backoffMultiplier: 2,
};

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * Generic circuit breaker with three states:
 *
 *   CLOSED  — requests pass through, failures are counted
 *   OPEN    — requests are rejected immediately (fast-fail)
 *   HALF_OPEN — one probe request is allowed through
 *
 * Events:
 *   state_change  { from: CircuitState, to: CircuitState, name: string }
 */
export class CircuitBreaker extends EventEmitter {
  private _state: CircuitState = 'closed';
  private failures: number[] = [];
  private currentCooldownMs: number;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private probeInFlight: boolean = false;
  readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.currentCooldownMs = this.config.cooldownMs;
  }

  get state(): CircuitState {
    return this._state;
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * Returns true if a request should be allowed through.
   * CLOSED: always true.
   * HALF_OPEN: true for exactly one probe request.
   * OPEN: always false.
   */
  canRequest(): boolean {
    if (this._state === 'closed') return true;
    if (this._state === 'half_open' && !this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** Record a successful call. Resets failures in CLOSED. Transitions HALF_OPEN to CLOSED. */
  recordSuccess(): void {
    if (this._state === 'closed') {
      this.failures = [];
      return;
    }
    if (this._state === 'half_open') {
      this.probeInFlight = false;
      this.currentCooldownMs = this.config.cooldownMs;
      this.failures = [];
      this.transition('closed');
    }
  }

  /** Record a failed call. May transition CLOSED to OPEN or HALF_OPEN back to OPEN. */
  recordFailure(): void {
    if (this._state === 'closed') {
      const now = Date.now();
      this.failures.push(now);
      this.pruneFailures(now);
      if (this.failures.length >= this.config.failureThreshold) {
        this.failures = [];
        this.transition('open');
        this.scheduleCooldown();
      }
      return;
    }
    if (this._state === 'half_open') {
      this.probeInFlight = false;
      // Exponential backoff on probe failure
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * this.config.backoffMultiplier,
        this.config.maxCooldownMs,
      );
      this.transition('open');
      this.scheduleCooldown();
    }
  }

  /** Subscribe to state transitions. Returns unsubscribe function. */
  onStateChange(listener: (from: CircuitState, to: CircuitState) => void): () => void {
    this.on('state_change', listener);
    return () => this.off('state_change', listener);
  }

  /** Clear internal timers. */
  destroy(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private transition(to: CircuitState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.emit('state_change', from, to);
  }

  private scheduleCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    // Add jitter: +/-15%
    const jitter = 1 + (Math.random() * 0.3 - 0.15);
    const delay = Math.round(this.currentCooldownMs * jitter);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      if (this._state === 'open') {
        this.probeInFlight = false;
        this.transition('half_open');
      }
    }, delay);
  }

  private pruneFailures(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }
}
