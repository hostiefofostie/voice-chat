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
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // 2 failures (each falls back to openai per-request)
    await router.synthesize('a');
    await router.synthesize('b');

    // Advance past the 60s failure window
    vi.advanceTimersByTime(61_000);

    // Third failure should not trip breaker (old ones aged out)
    await router.synthesize('c');
    expect(router.circuitStateOf('kokoro')).toBe('closed');
    expect(router.provider).toBe('kokoro');
    router.destroy();
  });

  it('failures within window accumulate to threshold', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // 3 failures rapidly — trips the breaker
    await router.synthesize('a');
    await router.synthesize('b');
    await router.synthesize('c');

    expect(router.circuitStateOf('kokoro')).toBe('open');
    router.destroy();
  });
});

describe('TtsRouter — success clears failures', () => {
  it('a success after failures resets the failure count', async () => {
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

    // 2 failures (fall back to openai each time)
    const r1 = await router.synthesize('a');
    expect(r1.provider).toBe('openai');
    const r2 = await router.synthesize('b');
    expect(r2.provider).toBe('openai');

    // Success on 3rd call — should clear failure count
    const result = await router.synthesize('c');
    expect(result.audio.toString()).toBe('ok');
    expect(result.provider).toBe('kokoro');
    expect(router.circuitStateOf('kokoro')).toBe('closed');

    // Now another 2 failures should NOT trip breaker (counter was reset)
    callCount = 0;
    await router.synthesize('d');
    await router.synthesize('e');
    expect(router.circuitStateOf('kokoro')).toBe('closed');
    router.destroy();
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
    router.destroy();
  });

  it('switching back after circuit breaker trip works', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    // Trip kokoro breaker
    for (let i = 0; i < 3; i++) {
      await router.synthesize('test');
    }
    expect(router.circuitStateOf('kokoro')).toBe('open');

    // All requests still work via openai fallback
    const result1 = await router.synthesize('after trip');
    expect(result1.provider).toBe('openai');

    // Manually switch preference to kokoro (breaker is still open though)
    router.setProvider('kokoro');
    expect(router.provider).toBe('kokoro');
    router.destroy();
  });
});

describe('TtsRouter — healthCheck', () => {
  it('reports kokoro status from actual health check', async () => {
    const kokoro = createMockKokoro();
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai);

    const status = await router.healthCheck();
    expect(status.kokoro).toBe(true);
    expect(status.openai).toBe(true);
    router.destroy();
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
    router.destroy();
  });

  it('reports openai as unhealthy when synthesize fails', async () => {
    const kokoro = createMockKokoro();
    const openai = createMockOpenai(true);
    const router = new TtsRouter(kokoro, openai);

    const status = await router.healthCheck();
    expect(status.kokoro).toBe(true);
    expect(status.openai).toBe(false);
    router.destroy();
  });
});

describe('TtsRouter — circuit state', () => {
  it('exposes circuit state per provider', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    expect(router.circuitStateOf('kokoro')).toBe('closed');
    expect(router.circuitStateOf('openai')).toBe('closed');

    // Trip kokoro
    for (let i = 0; i < 3; i++) {
      await router.synthesize('test');
    }

    expect(router.circuitStateOf('kokoro')).toBe('open');
    expect(router.circuitStateOf('openai')).toBe('closed');
    router.destroy();
  });

  it('emits circuit_state events', async () => {
    const kokoro = createMockKokoro(true);
    const openai = createMockOpenai();
    const router = new TtsRouter(kokoro, openai, 'kokoro');

    const handler = vi.fn();
    router.on('circuit_state', handler);

    for (let i = 0; i < 3; i++) {
      await router.synthesize('test');
    }

    expect(handler).toHaveBeenCalledWith({
      provider: 'kokoro',
      from: 'closed',
      to: 'open',
    });
    router.destroy();
  });

  it('destroy cleans up circuit breaker timers', () => {
    const router = new TtsRouter(createMockKokoro(), createMockOpenai());
    router.destroy();
    // Should not throw or leak timers
  });
});
