import { EventEmitter } from 'events';
import { ParakeetClient } from './parakeet-client.js';
import { TranscribeResult } from '../types.js';

export class SttRouter extends EventEmitter {
  private primary: ParakeetClient;
  private usingFallback: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private readonly failureThreshold = 3;

  constructor(primary: ParakeetClient) {
    super();
    this.primary = primary;
  }

  get activeProvider(): string {
    return this.usingFallback ? 'cloud_stub' : 'parakeet';
  }

  async transcribe(audio: Buffer): Promise<TranscribeResult> {
    if (!this.usingFallback) {
      try {
        const result = await this.primary.transcribe(audio);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold) {
          this.switchToFallback();
        }
        return this.cloudFallback(audio);
      }
    }
    return this.cloudFallback(audio);
  }

  private cloudFallback(_audio: Buffer): TranscribeResult {
    // Stub for MVP - real Deepgram integration is future work
    return {
      text: '[STT unavailable - local provider offline]',
      confidence: 0,
      segments: [],
    };
  }

  private switchToFallback() {
    this.usingFallback = true;
    this.emit('provider_switched', { from: 'parakeet', to: 'cloud_stub' });

    // Clear any existing health check before starting a new one
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Start health checks to auto-recover
    this.healthCheckInterval = setInterval(async () => {
      if (await this.primary.healthCheck()) {
        this.usingFallback = false;
        this.consecutiveFailures = 0;
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        this.emit('provider_recovered', { provider: 'parakeet' });
      }
    }, 15000);
  }

  destroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
