import { EventEmitter } from 'events';
import { KokoroClient } from './kokoro-client.js';
import { OpenAiTtsClient } from './openai-client.js';

export class TtsRouter extends EventEmitter {
  private activeProvider: 'kokoro' | 'openai';
  private kokoro: KokoroClient;
  private openai: OpenAiTtsClient;
  private failures: number[] = []; // timestamps
  private readonly failureWindow = 60_000;
  private readonly failureThreshold = 3;

  constructor(
    kokoro: KokoroClient,
    openai: OpenAiTtsClient,
    defaultProvider: 'kokoro' | 'openai' = 'kokoro',
  ) {
    super();
    this.kokoro = kokoro;
    this.openai = openai;
    this.activeProvider = defaultProvider;
  }

  get provider(): 'kokoro' | 'openai' {
    return this.activeProvider;
  }

  setProvider(provider: 'kokoro' | 'openai') {
    this.activeProvider = provider;
    this.failures = [];
    this.emit('provider_set', { provider });
  }

  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; provider: string }> {
    const client =
      this.activeProvider === 'kokoro' ? this.kokoro : this.openai;
    const defaultVoice =
      this.activeProvider === 'kokoro' ? 'af_heart' : 'cedar';

    try {
      const audio = await client.synthesize(text, voice || defaultVoice);
      this.failures = [];
      return { audio, provider: this.activeProvider };
    } catch (err) {
      this.recordFailure();
      if (this.shouldFallback()) {
        this.switchProvider();
        // Retry with alternate provider
        const altClient =
          this.activeProvider === 'kokoro' ? this.kokoro : this.openai;
        const altVoice =
          this.activeProvider === 'kokoro' ? 'af_heart' : 'cedar';
        const audio = await altClient.synthesize(text, voice || altVoice);
        return { audio, provider: this.activeProvider };
      }
      throw err;
    }
  }

  async healthCheck(): Promise<{ kokoro: boolean; openai: boolean }> {
    const [k, o] = await Promise.all([
      this.kokoro.healthCheck(),
      Promise.resolve(true), // OpenAI doesn't have a health endpoint
    ]);
    return { kokoro: k, openai: o };
  }

  private recordFailure() {
    this.failures.push(Date.now());
    const cutoff = Date.now() - this.failureWindow;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  private shouldFallback(): boolean {
    return this.failures.length >= this.failureThreshold;
  }

  private switchProvider() {
    const from = this.activeProvider;
    this.activeProvider =
      this.activeProvider === 'kokoro' ? 'openai' : 'kokoro';
    this.failures = [];
    this.emit('provider_switched', { from, to: this.activeProvider });
  }
}
