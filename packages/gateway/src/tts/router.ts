import { EventEmitter } from 'events';
import { KokoroClient } from './kokoro-client.js';
import { OpenAiTtsClient } from './openai-client.js';
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitState,
  DEFAULT_CIRCUIT_CONFIG,
} from '../common/circuit-breaker.js';

export class TtsRouter extends EventEmitter {
  private kokoro: KokoroClient;
  private openai: OpenAiTtsClient;
  private preferredProvider: 'kokoro' | 'openai';
  private kokoroBreaker: CircuitBreaker;
  private openaiBreaker: CircuitBreaker;

  constructor(
    kokoro: KokoroClient,
    openai: OpenAiTtsClient,
    defaultProvider: 'kokoro' | 'openai' = 'kokoro',
    breakerConfig?: Partial<CircuitBreakerConfig>,
  ) {
    super();
    this.kokoro = kokoro;
    this.openai = openai;
    this.preferredProvider = defaultProvider;
    this.kokoroBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:kokoro',
      cooldownMs: 5_000,
      ...breakerConfig,
    });
    this.openaiBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:openai',
      cooldownMs: 15_000,
      ...breakerConfig,
    });
    this.kokoroBreaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'kokoro', from, to });
      if (to === 'open') {
        this.emit('provider_switched', { from: 'kokoro', to: 'openai' });
      }
    });
    this.openaiBreaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'openai', from, to });
      if (to === 'open') {
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

    try {
      const audio = await client.synthesize(text, voice || defaultVoice);
      breaker.recordSuccess();
      return { audio, provider: name };
    } catch {
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
