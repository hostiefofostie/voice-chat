import { EventEmitter } from 'events';
import { ParakeetClient } from './parakeet-client.js';
import { TranscribeResult } from '../types.js';
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitState,
  DEFAULT_CIRCUIT_CONFIG,
} from '../common/circuit-breaker.js';

export class SttRouter extends EventEmitter {
  private primary: ParakeetClient;
  private breaker: CircuitBreaker;

  constructor(primary: ParakeetClient, config?: Partial<CircuitBreakerConfig>) {
    super();
    this.primary = primary;
    this.breaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'stt:parakeet',
      failureThreshold: 3,
      cooldownMs: 10_000,
      ...config,
    });
    this.breaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'parakeet', from, to });
      // Backward-compatible events
      if (to === 'open') {
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

    try {
      const result = await this.primary.transcribe(audio);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
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
