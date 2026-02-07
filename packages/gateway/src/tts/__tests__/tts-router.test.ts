import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsRouter } from '../router.js';
import { KokoroClient } from '../kokoro-client.js';
import { OpenAiTtsClient } from '../openai-client.js';

function createMockKokoro(shouldFail: boolean = false) {
  return {
    synthesize: vi.fn(async () => {
      if (shouldFail) throw new Error('Kokoro offline');
      return Buffer.from('kokoro-audio');
    }),
    healthCheck: vi.fn(async () => !shouldFail),
  } as unknown as KokoroClient;
}

function createMockOpenai(shouldFail: boolean = false) {
  return {
    synthesize: vi.fn(async () => {
      if (shouldFail) throw new Error('OpenAI error');
      return Buffer.from('openai-audio');
    }),
  } as unknown as OpenAiTtsClient;
}

describe('TtsRouter', () => {
  let kokoro: KokoroClient;
  let openai: OpenAiTtsClient;
  let router: TtsRouter;

  beforeEach(() => {
    kokoro = createMockKokoro();
    openai = createMockOpenai();
    router = new TtsRouter(kokoro, openai, 'kokoro');
  });

  it('uses default provider (kokoro)', async () => {
    const result = await router.synthesize('Hello');
    expect(result.provider).toBe('kokoro');
    expect(kokoro.synthesize).toHaveBeenCalledWith('Hello', 'af_heart');
    router.destroy();
  });

  it('uses openai when set', async () => {
    router.setProvider('openai');
    const result = await router.synthesize('Hello');
    expect(result.provider).toBe('openai');
    expect(openai.synthesize).toHaveBeenCalledWith('Hello', 'cedar');
    router.destroy();
  });

  it('passes custom voice to provider', async () => {
    await router.synthesize('Hello', 'custom_voice');
    expect(kokoro.synthesize).toHaveBeenCalledWith('Hello', 'custom_voice');
    router.destroy();
  });

  it('falls back to openai per-request when kokoro fails', async () => {
    const failKokoro = createMockKokoro(true);
    const r = new TtsRouter(failKokoro, openai, 'kokoro');

    // Kokoro fails -> openai fallback on same call
    const result = await r.synthesize('test');
    expect(result.provider).toBe('openai');
    expect(result.audio.toString()).toBe('openai-audio');
    r.destroy();
  });

  it('kokoro success clears failure count', async () => {
    let callCount = 0;
    const failKokoro = createMockKokoro(true);
    failKokoro.synthesize = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('fail');
      return Buffer.from('ok');
    }) as any;

    const r = new TtsRouter(failKokoro, openai, 'kokoro');

    // First two: kokoro fails, falls back to openai
    const r1 = await r.synthesize('a');
    expect(r1.provider).toBe('openai');
    const r2 = await r.synthesize('b');
    expect(r2.provider).toBe('openai');

    // Third: kokoro succeeds, failures reset
    const r3 = await r.synthesize('c');
    expect(r3.provider).toBe('kokoro');
    expect(r3.audio.toString()).toBe('ok');
    r.destroy();
  });

  it('trips circuit breaker after 3 failures and emits provider_switched', async () => {
    const failKokoro = createMockKokoro(true);
    const r = new TtsRouter(failKokoro, openai, 'kokoro');

    const switchHandler = vi.fn();
    r.on('provider_switched', switchHandler);

    // 3 failures trip the kokoro breaker (each falls back to openai)
    for (let i = 0; i < 3; i++) {
      const result = await r.synthesize('test');
      expect(result.provider).toBe('openai');
    }

    expect(switchHandler).toHaveBeenCalledWith({ from: 'kokoro', to: 'openai' });
    r.destroy();
  });

  it('setProvider changes preference', () => {
    const r = new TtsRouter(createMockKokoro(true), openai, 'kokoro');
    const handler = vi.fn();
    r.on('provider_set', handler);
    r.setProvider('openai');
    expect(handler).toHaveBeenCalledWith({ provider: 'openai' });
    expect(r.provider).toBe('openai');
    r.destroy();
  });

  it('throws if both providers fail', async () => {
    const failKokoro = createMockKokoro(true);
    const failOpenai = createMockOpenai(true);
    const r = new TtsRouter(failKokoro, failOpenai, 'kokoro');

    await expect(r.synthesize('test')).rejects.toThrow('All TTS providers unavailable');
    r.destroy();
  });
});
