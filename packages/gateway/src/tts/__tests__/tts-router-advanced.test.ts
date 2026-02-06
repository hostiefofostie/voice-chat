import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('TtsRouter — failure window expiration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('old failures age out of the window', async () => {
    let failCount = 0;
    const kokoro = {
      synthesize: vi.fn(async () => {
        failCount++;
        throw new Error('fail');
      }),
      healthCheck: vi.fn(async () => false),
    } as unknown as KokoroClient;
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // 2 failures
    await expect(router.synthesize('a')).rejects.toThrow();
    await expect(router.synthesize('b')).rejects.toThrow();

    // Advance past the 60s failure window
    vi.advanceTimersByTime(61_000);

    // Third failure should not trigger fallback (old ones aged out)
    await expect(router.synthesize('c')).rejects.toThrow();
    expect(router.provider).toBe('kokoro'); // Still on kokoro
  });

  it('failures within window accumulate to threshold', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // 3 failures rapidly
    await expect(router.synthesize('a')).rejects.toThrow();
    await expect(router.synthesize('b')).rejects.toThrow();
    // Third triggers fallback to openai
    const result = await router.synthesize('c');
    expect(result.provider).toBe('openai');
    expect(router.provider).toBe('openai');
  });
});

describe('TtsRouter — success clears failures', () => {
  it('a success after failures resets the failure array', async () => {
    let callCount = 0;
    const kokoro = {
      synthesize: vi.fn(async () => {
        callCount++;
        if (callCount <= 2) throw new Error('intermittent');
        return Buffer.from('ok');
      }),
      healthCheck: vi.fn(async () => true),
    } as unknown as KokoroClient;
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // 2 failures (below threshold)
    await expect(router.synthesize('a')).rejects.toThrow();
    await expect(router.synthesize('b')).rejects.toThrow();

    // Success on 3rd call — should clear failure count
    const result = await router.synthesize('c');
    expect(result.audio.toString()).toBe('ok');
    expect(router.provider).toBe('kokoro');

    // Now another 2 failures should NOT trigger fallback (counter was reset)
    callCount = 0; // Reset the mock
    await expect(router.synthesize('d')).rejects.toThrow();
    await expect(router.synthesize('e')).rejects.toThrow();
    expect(router.provider).toBe('kokoro'); // Still on kokoro
  });
});

describe('TtsRouter — setProvider', () => {
  it('switching provider allows immediate use of new provider', async () => {
    const kokoro = createMockKokoro();
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    router.setProvider('openai');
    const result = await router.synthesize('Hello');
    expect(result.provider).toBe('openai');
    expect(openai.synthesize).toHaveBeenCalled();
    expect(kokoro.synthesize).not.toHaveBeenCalled();
  });

  it('switching back after fallback works', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // Trigger automatic fallback
    for (let i = 0; i < 3; i++) {
      try { await router.synthesize('test'); } catch {}
    }
    // Now on openai
    const result1 = await router.synthesize('after fallback');
    expect(result1.provider).toBe('openai');

    // Manually switch back (e.g., /tts kokoro command)
    router.setProvider('kokoro');
    expect(router.provider).toBe('kokoro');
  });
});

describe('TtsRouter — healthCheck', () => {
  it('reports kokoro status from actual health check', async () => {
    const kokoro = createMockKokoro();
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai);

    const status = await router.healthCheck();
    expect(status.kokoro).toBe(true);
    expect(status.openai).toBe(true); // OpenAI always returns true
  });

  it('reports kokoro as unhealthy when health check fails', async () => {
    const kokoro = {
      synthesize: vi.fn(async () => Buffer.from('')),
      healthCheck: vi.fn(async () => false),
    } as unknown as KokoroClient;
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai);

    const status = await router.healthCheck();
    expect(status.kokoro).toBe(false);
    expect(status.openai).toBe(true);
  });
});
