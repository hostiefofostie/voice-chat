import { EventEmitter } from 'events';
import { KokoroClient } from './kokoro-client.js';
import { OpenAiTtsClient } from './openai-client.js';
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitState,
  DEFAULT_CIRCUIT_CONFIG,
} from '../common/circuit-breaker.js';
import { MetricsRegistry, NOOP_METRICS } from '../metrics/registry.js';

export interface TtsRouterOptions extends Partial<CircuitBreakerConfig> {
  metrics?: MetricsRegistry;
}

export class TtsRouter extends EventEmitter {
  private kokoro: KokoroClient;
  private openai: OpenAiTtsClient;
  private preferredProvider: 'kokoro' | 'openai';
  private kokoroBreaker: CircuitBreaker;
  private openaiBreaker: CircuitBreaker;
  private metrics: MetricsRegistry;

  constructor(
    kokoro: KokoroClient,
    openai: OpenAiTtsClient,
    defaultProvider: 'kokoro' | 'openai' = 'kokoro',
    options?: TtsRouterOptions,
  ) {
    super();
    this.kokoro = kokoro;
    this.openai = openai;
    this.preferredProvider = defaultProvider;
    this.metrics = options?.metrics ?? NOOP_METRICS;
    this.kokoroBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:kokoro',
      cooldownMs: 5_000,
      ...options,
    });
    this.openaiBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:openai',
      cooldownMs: 15_000,
      ...options,
    });
    const stateToNum: Record<CircuitState, number> = { closed: 0, open: 1, half_open: 2 };
    this.kokoroBreaker.onStateChange((from, to) => {
      this.metrics.gauge('provider_circuit_state', stateToNum[to], { provider: 'kokoro' });
      this.emit('circuit_state', { provider: 'kokoro', from, to });
      if (to === 'open') {
        this.metrics.increment('provider_failover_total', { from: 'kokoro', to: 'openai' });
        this.emit('provider_switched', { from: 'kokoro', to: 'openai' });
      }
    });
    this.openaiBreaker.onStateChange((from, to) => {
      this.metrics.gauge('provider_circuit_state', stateToNum[to], { provider: 'openai' });
      this.emit('circuit_state', { provider: 'openai', from, to });
      if (to === 'open') {
        this.metrics.increment('provider_failover_total', { from: 'openai', to: 'kokoro' });
        this.emit('provider_switched', { from: 'openai', to: 'kokoro' });
      }
    });
  }

  get provider(): 'kokoro' | 'openai' {
    return this.preferredProvider;
  }

  circuitStateOf(provider: 'kokoro' | 'openai'): CircuitState {
    return provider === 'kokoro'
      ? this.kokoroBreaker.state
      : this.openaiBreaker.state;
  }

  setProvider(provider: 'kokoro' | 'openai') {
    this.preferredProvider = provider;
    this.emit('provider_set', { provider });
  }

  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; provider: string }> {
    const primary = this.preferredProvider;
    const fallback: 'kokoro' | 'openai' =
      primary === 'kokoro' ? 'openai' : 'kokoro';

    // Try preferred provider first
    const primaryResult = await this.tryProvider(primary, text, voice);
    if (primaryResult) return primaryResult;

    // Preferred provider failed or circuit open — try fallback
    const fallbackResult = await this.tryProvider(fallback, text, voice);
    if (fallbackResult) return fallbackResult;

    throw new Error(`All TTS providers unavailable (${primary} and ${fallback})`);
  }

  private async tryProvider(
    name: 'kokoro' | 'openai',
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; provider: string } | null> {
    const breaker = name === 'kokoro' ? this.kokoroBreaker : this.openaiBreaker;
    const client = name === 'kokoro' ? this.kokoro : this.openai;
    const defaultVoice = name === 'kokoro' ? 'af_heart' : 'cedar';

    if (!breaker.canRequest()) return null;

    const start = performance.now();
    try {
      const audio = await client.synthesize(text, voice || defaultVoice);
      breaker.recordSuccess();
      const elapsed = performance.now() - start;
      this.metrics.observe('provider_request_ms', elapsed, { provider: name });
      this.metrics.increment('provider_requests_total', { provider: name, outcome: 'success' });
      return { audio, provider: name };
    } catch {
      const elapsed = performance.now() - start;
      this.metrics.observe('provider_request_ms', elapsed, { provider: name });
      this.metrics.increment('provider_requests_total', { provider: name, outcome: 'failure' });
      breaker.recordFailure();
      return null;
    }
  }

  async healthCheck(): Promise<{ kokoro: boolean; openai: boolean }> {
    const [k, o] = await Promise.all([
      this.kokoro.healthCheck(),
      this.checkOpenAi(),
    ]);
    return { kokoro: k, openai: o };
  }

  /** Real health check for OpenAI — synthesize a short test phrase. */
  private async checkOpenAi(): Promise<boolean> {
    try {
      await this.openai.synthesize('.', 'cedar');
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this.kokoroBreaker.destroy();
    this.openaiBreaker.destroy();
  }
}
