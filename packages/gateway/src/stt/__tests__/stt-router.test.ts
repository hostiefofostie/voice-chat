import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SttRouter } from '../router.js';
import { ParakeetClient } from '../parakeet-client.js';
import type { TranscribeResult } from '../../types.js';

function mockResult(text: string): TranscribeResult {
  return { text, confidence: 0.95, segments: [] };
}

function createMockClient(shouldFail: boolean = false) {
  return {
    transcribe: vi.fn(async () => {
      if (shouldFail) throw new Error('Parakeet offline');
      return mockResult('hello world');
    }),
    healthCheck: vi.fn(async () => !shouldFail),
  } as unknown as ParakeetClient;
}

describe('SttRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transcribes using primary provider', async () => {
    const client = createMockClient();
    const router = new SttRouter(client);
    const result = await router.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('hello world');
    expect(router.activeProvider).toBe('parakeet');
    router.destroy();
  });

  it('falls back to cloud stub after 3 consecutive failures', async () => {
    vi.useFakeTimers();
    const client = createMockClient(true);
    const router = new SttRouter(client);

    const switchHandler = vi.fn();
    router.on('provider_switched', switchHandler);

    // First 2 failures re-throw (below threshold)
    for (let i = 0; i < 2; i++) {
      await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow('Parakeet offline');
    }

    // Third failure hits threshold — switches to fallback
    const result = await router.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('[STT unavailable - local provider offline]');
    expect(router.activeProvider).toBe('cloud_stub');
    expect(switchHandler).toHaveBeenCalledWith({ from: 'parakeet', to: 'cloud_stub' });

    router.destroy();
  });

  it('resets failure count on successful transcription', async () => {
    let callCount = 0;
    const client = {
      transcribe: vi.fn(async () => {
        callCount++;
        if (callCount === 2) throw new Error('temporary');
        return mockResult('ok');
      }),
      healthCheck: vi.fn(async () => true),
    } as unknown as ParakeetClient;

    const router = new SttRouter(client);

    // Call 1: success -> failures reset
    await router.transcribe(Buffer.alloc(100));
    // Call 2: fail -> 1 failure, throws (below threshold)
    await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow('temporary');
    // Call 3: success -> failures reset
    await router.transcribe(Buffer.alloc(100));

    // Not switched because never hit threshold
    expect(router.activeProvider).toBe('parakeet');
    router.destroy();
  });

  it('auto-recovers via circuit breaker half-open probe', async () => {
    vi.useFakeTimers();
    const client = createMockClient(true);
    const router = new SttRouter(client, { cooldownMs: 5_000 });

    const recoveredHandler = vi.fn();
    router.on('provider_recovered', recoveredHandler);

    // Trigger fallback: first 2 throw (below threshold), 3rd switches
    for (let i = 0; i < 2; i++) {
      await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow();
    }
    await router.transcribe(Buffer.alloc(100));
    expect(router.activeProvider).toBe('cloud_stub');
    expect(router.circuitState).toBe('open');

    // Make primary succeed now
    (client.transcribe as any).mockResolvedValue(mockResult('recovered'));

    // Advance past cooldown -> half_open
    await vi.advanceTimersByTimeAsync(6_000);
    expect(router.circuitState).toBe('half_open');

    // Next transcribe is the probe — should succeed and close the breaker
    const result = await router.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('recovered');
    expect(router.activeProvider).toBe('parakeet');
    expect(router.circuitState).toBe('closed');
    expect(recoveredHandler).toHaveBeenCalledWith({ provider: 'parakeet' });

    router.destroy();
  });

  it('destroy clears circuit breaker timers', () => {
    vi.useFakeTimers();
    const client = createMockClient(true);
    const router = new SttRouter(client);

    router.destroy();

    // Advancing time should not cause any errors
    vi.advanceTimersByTime(30000);
  });

  it('cloud fallback returns zero confidence', async () => {
    const client = createMockClient(true);
    const router = new SttRouter(client);

    // Need to hit the threshold to switch to fallback first
    for (let i = 0; i < 2; i++) {
      await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow();
    }
    // Third failure triggers fallback
    const result = await router.transcribe(Buffer.alloc(100));
    expect(result.confidence).toBe(0);
    expect(result.segments).toEqual([]);
    router.destroy();
  });

  it('exposes circuit state', async () => {
    vi.useFakeTimers();
    const client = createMockClient(true);
    const router = new SttRouter(client, { cooldownMs: 5_000 });

    expect(router.circuitState).toBe('closed');

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow();
    }
    await router.transcribe(Buffer.alloc(100));
    expect(router.circuitState).toBe('open');

    // Wait for half_open
    await vi.advanceTimersByTimeAsync(6_000);
    expect(router.circuitState).toBe('half_open');

    router.destroy();
  });

  it('emits circuit_state events', async () => {
    const client = createMockClient(true);
    const router = new SttRouter(client);

    const handler = vi.fn();
    router.on('circuit_state', handler);

    for (let i = 0; i < 2; i++) {
      await expect(router.transcribe(Buffer.alloc(100))).rejects.toThrow();
    }
    await router.transcribe(Buffer.alloc(100));

    expect(handler).toHaveBeenCalledWith({
      provider: 'parakeet',
      from: 'closed',
      to: 'open',
    });
    router.destroy();
  });
});
