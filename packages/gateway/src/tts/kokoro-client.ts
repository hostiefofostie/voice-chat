import { VoiceCatalog } from '../types.js';
import { TtsError } from './tts-error.js';

export class KokoroClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.KOKORO_URL || 'http://100.86.69.14:8787') {
    this.baseUrl = baseUrl;
  }

  async synthesize(text: string, voice: string = 'af_heart'): Promise<Buffer> {
    const start = performance.now();
    const resp = await fetch(`${this.baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new TtsError(`Kokoro ${resp.status}`, resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log(`[tts:kokoro] synthesize ${buf.length}B in ${(performance.now() - start).toFixed(0)}ms`);
    return buf;
  }

  async voices(): Promise<VoiceCatalog> {
    const start = performance.now();
    const resp = await fetch(`${this.baseUrl}/api/voices`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new TtsError(`Kokoro voices ${resp.status}`, resp.status);
    const catalog = (await resp.json()) as VoiceCatalog;
    console.log(`[tts:kokoro] voices ${catalog.voices.length} in ${(performance.now() - start).toFixed(0)}ms`);
    return catalog;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
