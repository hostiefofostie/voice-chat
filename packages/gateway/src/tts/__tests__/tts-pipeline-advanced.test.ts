import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtsPipeline } from '../pipeline.js';
import { TtsRouter } from '../router.js';
import type { ServerMessage } from '../../types.js';

function makeWav(sampleRate: number = 16000, pcmBytes: number = 3200): Buffer {
  const pcm = Buffer.alloc(pcmBytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function createMockRouter(latencyMs: number = 0) {
  const synthesize = vi.fn(async (_text: string) => {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    return { audio: makeWav(), provider: 'mock' };
  });
  return { synthesize } as unknown as TtsRouter;
}

describe('TtsPipeline — drainAll timeout', () => {
  it('resolves after 30s timeout even if inFlight is stuck', async () => {
    // Create a router that never resolves
    let callCount = 0;
    const hangingRouter = {
      synthesize: vi.fn(async () => {
        callCount++;
        // Never resolves — simulates a stuck synthesis
        return new Promise<never>(() => {});
      }),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: hangingRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
      maxParallel: 1,
    });

    // Queue a chunk — it will start synthesizing but never complete
    await pipeline.processChunk('Hello', 0, 'turn-1');

    // finish() calls drainAll which should eventually timeout
    // Use fake timers to speed this up
    vi.useFakeTimers();

    const finishPromise = pipeline.finish();

    // Advance past the 30s drain timeout
    await vi.advanceTimersByTimeAsync(31_000);

    await finishPromise;

    // finish() should have sent tts_done despite the stuck synthesis
    expect(sentJson.some((m) => m.type === 'tts_done')).toBe(true);

    vi.useRealTimers();
  });
});

describe('TtsPipeline — maxParallel enforcement', () => {
  it('does not start more than maxParallel concurrent syntheses', async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const resolvers: Array<(value: { audio: Buffer; provider: string }) => void> = [];

    const concurrentRouter = {
      synthesize: vi.fn(async () => {
        concurrentCalls++;
        if (concurrentCalls > maxConcurrent) maxConcurrent = concurrentCalls;
        return new Promise<{ audio: Buffer; provider: string }>((resolve) => {
          resolvers.push(resolve);
        });
      }),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const sentBinary: Buffer[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: concurrentRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: (data) => sentBinary.push(data),
      maxParallel: 2,
    });

    // Queue 4 chunks
    await pipeline.processChunk('Chunk 0', 0, 'turn-1');
    await pipeline.processChunk('Chunk 1', 1, 'turn-1');
    await pipeline.processChunk('Chunk 2', 2, 'turn-1');
    await pipeline.processChunk('Chunk 3', 3, 'turn-1');

    // Only 2 should have started (maxParallel=2)
    expect(concurrentRouter.synthesize).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(2);

    // Resolve the first chunk — should trigger dispatch of chunk 2
    concurrentCalls--;
    resolvers[0]({ audio: makeWav(), provider: 'mock' });
    await new Promise((r) => setTimeout(r, 10));

    expect(concurrentRouter.synthesize).toHaveBeenCalledTimes(3);

    // Resolve the second
    concurrentCalls--;
    resolvers[1]({ audio: makeWav(), provider: 'mock' });
    await new Promise((r) => setTimeout(r, 10));

    expect(concurrentRouter.synthesize).toHaveBeenCalledTimes(4);

    // Resolve remaining
    concurrentCalls--;
    resolvers[2]({ audio: makeWav(), provider: 'mock' });
    concurrentCalls--;
    resolvers[3]({ audio: makeWav(), provider: 'mock' });

    await pipeline.finish();

    // All 4 chunks should have been sent in order
    const metaMsgs = sentJson.filter((m) => m.type === 'tts_meta') as Array<{ type: 'tts_meta'; index: number }>;
    expect(metaMsgs.length).toBe(4);
    expect(metaMsgs.map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('TtsPipeline — WAV metadata edge cases', () => {
  it('handles audio shorter than WAV header (< 44 bytes)', async () => {
    const tinyRouter = {
      synthesize: vi.fn(async () => ({
        audio: Buffer.alloc(20), // Less than 44-byte WAV header
        provider: 'mock',
      })),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const sentBinary: Buffer[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: tinyRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: (data) => sentBinary.push(data),
    });

    await pipeline.processChunk('Test', 0, 'turn-1');
    await pipeline.finish();

    // Should use default sampleRate=16000 and durationMs=0 for undersized audio
    const meta = sentJson.find((m) => m.type === 'tts_meta') as {
      type: 'tts_meta';
      sampleRate: number;
      durationMs: number;
    };
    expect(meta).toBeDefined();
    expect(meta.sampleRate).toBe(16000);
    expect(meta.durationMs).toBe(0);
  });

  it('handles WAV with sampleRate=0 in header (no division by zero)', async () => {
    const badWav = makeWav(0, 3200);
    // Overwrite the sampleRate field to 0
    badWav.writeUInt32LE(0, 24);

    const badRouter = {
      synthesize: vi.fn(async () => ({
        audio: badWav,
        provider: 'mock',
      })),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: badRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
    });

    await pipeline.processChunk('Test', 0, 'turn-1');
    await pipeline.finish();

    const meta = sentJson.find((m) => m.type === 'tts_meta') as {
      type: 'tts_meta';
      sampleRate: number;
      durationMs: number;
    };
    expect(meta).toBeDefined();
    // sampleRate=0 should fallback to 16000, durationMs should be 0 (not NaN/Infinity)
    expect(meta.sampleRate).toBe(16000);
    expect(meta.durationMs).toBe(0);
  });

  it('calculates correct duration for known WAV', async () => {
    // 16000 Hz, 16-bit mono, 32000 bytes of PCM = 1 second
    const oneSecWav = makeWav(16000, 32000);

    const wavRouter = {
      synthesize: vi.fn(async () => ({
        audio: oneSecWav,
        provider: 'mock',
      })),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: wavRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
    });

    await pipeline.processChunk('Test', 0, 'turn-1');
    await pipeline.finish();

    const meta = sentJson.find((m) => m.type === 'tts_meta') as {
      type: 'tts_meta';
      durationMs: number;
      sampleRate: number;
    };
    expect(meta.durationMs).toBe(1000);
    expect(meta.sampleRate).toBe(16000);
  });
});

describe('TtsPipeline — cancel during synthesis', () => {
  it('cancel stops processing new chunks but ongoing synthesis continues', async () => {
    let synthesisResolved = false;
    let resolver: (() => void) | null = null;

    const slowRouter = {
      synthesize: vi.fn(async () => {
        return new Promise<{ audio: Buffer; provider: string }>((resolve) => {
          resolver = () => {
            synthesisResolved = true;
            resolve({ audio: makeWav(), provider: 'mock' });
          };
        });
      }),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: slowRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
    });

    // Start a chunk
    await pipeline.processChunk('Hello', 0, 'turn-1');

    // Cancel while synthesis is in progress
    pipeline.cancel();

    // tts_done should be sent immediately on cancel
    expect(sentJson.some((m) => m.type === 'tts_done')).toBe(true);

    // New chunks should be ignored
    await pipeline.processChunk('Ignored', 1, 'turn-1');
    expect(slowRouter.synthesize).toHaveBeenCalledTimes(1); // Only the original call

    // Resolve the in-flight synthesis (shouldn't cause errors or extra sends)
    (resolver as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 10));

    // Only one tts_done (from cancel), no tts_meta
    expect(sentJson.filter((m) => m.type === 'tts_done').length).toBe(1);
    expect(sentJson.filter((m) => m.type === 'tts_meta').length).toBe(0);
  });
});

describe('TtsPipeline — multiple turn reset', () => {
  it('indices restart from 0 after reset', async () => {
    const router = createMockRouter();
    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: router,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
    });

    // Turn 1
    await pipeline.processChunk('First turn chunk 0', 0, 'turn-1');
    await pipeline.processChunk('First turn chunk 1', 1, 'turn-1');
    await pipeline.finish();

    pipeline.reset();

    // Turn 2
    await pipeline.processChunk('Second turn chunk 0', 0, 'turn-2');
    await pipeline.finish();

    const metaMsgs = sentJson.filter((m) => m.type === 'tts_meta') as Array<{ type: 'tts_meta'; index: number }>;
    // Turn 1 should have indices 0, 1; Turn 2 should have index 0
    expect(metaMsgs[0].index).toBe(0);
    expect(metaMsgs[1].index).toBe(1);
    expect(metaMsgs[2].index).toBe(0);
  });
});
