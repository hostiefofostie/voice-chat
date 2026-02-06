import { TranscribeResult } from '../types.js';

export class SttError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'SttError';
  }
}

export class ParakeetClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(
    baseUrl: string = process.env.PARAKEET_URL || 'http://100.86.69.14:8765',
    timeoutMs: number = 5000,
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async transcribe(audioBuffer: Buffer, mimeType: string = 'audio/wav'): Promise<TranscribeResult> {
    const startTime = Date.now();
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    form.append('audio', blob, 'audio.wav');

    const response = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new SttError(`Parakeet error ${response.status}`, response.status);
    }

    const result = await response.json() as TranscribeResult;
    const elapsed = Date.now() - startTime;
    // Timing available for callers to log via pino
    (result as TranscribeResult & { _elapsedMs: number })._elapsedMs = elapsed;
    return result;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
