import { EventEmitter } from 'events';
import { ParakeetClient } from './parakeet-client.js';
import { TranscribeResult } from '../types.js';
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitState,
  DEFAULT_CIRCUIT_CONFIG,
} from '../common/circuit-breaker.js';
import { MetricsRegistry, NOOP_METRICS } from '../metrics/registry.js';

export interface SttRouterOptions extends Partial<CircuitBreakerConfig> {
  metrics?: MetricsRegistry;
}

export class SttRouter extends EventEmitter {
  private primary: ParakeetClient;
  private breaker: CircuitBreaker;
  private metrics: MetricsRegistry;

  constructor(primary: ParakeetClient, config?: SttRouterOptions) {
    super();
    this.primary = primary;
    this.metrics = config?.metrics ?? NOOP_METRICS;
    this.breaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'stt:parakeet',
      failureThreshold: 3,
      cooldownMs: 10_000,
      ...config,
    });
    const stateToNum: Record<CircuitState, number> = { closed: 0, open: 1, half_open: 2 };
    this.breaker.onStateChange((from, to) => {
      this.metrics.gauge('provider_circuit_state', stateToNum[to], { provider: 'parakeet' });
      this.emit('circuit_state', { provider: 'parakeet', from, to });
      // Backward-compatible events
      if (to === 'open') {
        this.metrics.increment('provider_failover_total', { from: 'parakeet', to: 'cloud_stub' });
        this.emit('provider_switched', { from: 'parakeet', to: 'cloud_stub' });
      }
      if (from !== 'closed' && to === 'closed') {
        this.emit('provider_recovered', { provider: 'parakeet' });
      }
    });
  }

  get activeProvider(): string {
    return this.breaker.state === 'closed' ? 'parakeet' : 'cloud_stub';
  }

  get circuitState(): CircuitState {
    return this.breaker.state;
  }

  async transcribe(audio: Buffer): Promise<TranscribeResult> {
    if (!this.breaker.canRequest()) {
      return this.cloudFallback(audio);
    }

    const start = performance.now();
    try {
      const result = await this.primary.transcribe(audio);
      this.breaker.recordSuccess();
      const elapsed = performance.now() - start;
      this.metrics.observe('provider_request_ms', elapsed, { provider: 'parakeet' });
      this.metrics.increment('provider_requests_total', { provider: 'parakeet', outcome: 'success' });
      return result;
    } catch (err) {
      const elapsed = performance.now() - start;
      this.metrics.observe('provider_request_ms', elapsed, { provider: 'parakeet' });
      this.metrics.increment('provider_requests_total', { provider: 'parakeet', outcome: 'failure' });
      this.breaker.recordFailure();
      // If breaker just tripped open, use fallback for this request
      if (!this.breaker.canRequest()) {
        return this.cloudFallback(audio);
      }
      throw err;
    }
  }

  private cloudFallback(_audio: Buffer): TranscribeResult {
    // Stub for MVP - real Deepgram integration is future work
    return {
      text: '[STT unavailable - local provider offline]',
      confidence: 0,
      segments: [],
    };
  }

  destroy() {
    this.breaker.destroy();
  }
}
