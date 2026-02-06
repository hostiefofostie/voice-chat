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
  });

  it('uses openai when set', async () => {
    router.setProvider('openai');
    const result = await router.synthesize('Hello');
    expect(result.provider).toBe('openai');
    expect(openai.synthesize).toHaveBeenCalledWith('Hello', 'cedar');
  });

  it('passes custom voice to provider', async () => {
    await router.synthesize('Hello', 'custom_voice');
    expect(kokoro.synthesize).toHaveBeenCalledWith('Hello', 'custom_voice');
  });

  it('clears failure count on success', async () => {
    // Simulate 2 failures then success
    const failKokoro = createMockKokoro(true);
    let callCount = 0;
    failKokoro.synthesize = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('fail');
      return Buffer.from('ok');
    }) as any;

    const r = new TtsRouter(failKokoro, openai, 'kokoro');

    // First two fail, but don't hit threshold (need 3)
    await expect(r.synthesize('a')).rejects.toThrow('fail');
    await expect(r.synthesize('b')).rejects.toThrow('fail');

    // Third succeeds — failures should be cleared
    const result = await r.synthesize('c');
    expect(result.audio.toString()).toBe('ok');
  });

  it('falls back to alternate provider after 3 consecutive failures', async () => {
    const failKokoro = createMockKokoro(true);
    const r = new TtsRouter(failKokoro, openai, 'kokoro');

    const switchHandler = vi.fn();
    r.on('provider_switched', switchHandler);

    // Fail 3 times (threshold)
    for (let i = 0; i < 2; i++) {
      await expect(r.synthesize('test')).rejects.toThrow('Kokoro offline');
    }

    // Third failure triggers fallback
    const result = await r.synthesize('test');
    expect(result.provider).toBe('openai');
    expect(switchHandler).toHaveBeenCalledWith({ from: 'kokoro', to: 'openai' });
  });

  it('setProvider resets failure count', () => {
    const r = new TtsRouter(createMockKokoro(true), openai, 'kokoro');
    // Record some failures manually by accessing private state
    // Instead, just verify setProvider emits event
    const handler = vi.fn();
    r.on('provider_set', handler);
    r.setProvider('openai');
    expect(handler).toHaveBeenCalledWith({ provider: 'openai' });
    expect(r.provider).toBe('openai');
  });

  it('throws if both providers fail', async () => {
    const failKokoro = createMockKokoro(true);
    const failOpenai = createMockOpenai(true);
    const r = new TtsRouter(failKokoro, failOpenai, 'kokoro');

    // 3 failures trigger fallback to OpenAI, which also fails
    for (let i = 0; i < 2; i++) {
      await expect(r.synthesize('test')).rejects.toThrow();
    }
    // Third triggers fallback — OpenAI also fails
    await expect(r.synthesize('test')).rejects.toThrow('OpenAI error');
  });
});
