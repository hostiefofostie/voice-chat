import { TtsError } from './tts-error.js';

export interface OpenAiTtsOptions {
  instructions?: string;
  model?: string;
}

export class OpenAiTtsClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string = process.env.OPENAI_API_KEY || '',
    baseUrl: string = 'https://api.openai.com',
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async synthesize(
    text: string,
    voice: string = 'cedar',
    options?: OpenAiTtsOptions,
  ): Promise<Buffer> {
    const start = performance.now();
    const resp = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o-mini-tts',
        voice,
        input: text,
        instructions: options?.instructions,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new TtsError(`OpenAI TTS ${resp.status}`, resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log(`[tts:openai] synthesize ${buf.length}B in ${(performance.now() - start).toFixed(0)}ms`);
    return buf;
  }
}
