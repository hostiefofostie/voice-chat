import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsPipeline } from '../pipeline.js';
import { TtsRouter } from '../router.js';
import type { ServerMessage } from '../../types.js';

function createMockRouter(latencyMs: number = 0) {
  const synthesize = vi.fn(async (text: string) => {
    if (latencyMs > 0) {
      await new Promise((r) => setTimeout(r, latencyMs));
    }
    // Create minimal WAV: 44 byte header + 3200 bytes of silence (100ms at 16kHz 16-bit)
    const pcm = Buffer.alloc(3200);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return { audio: Buffer.concat([header, pcm]), provider: 'mock' };
  });

  return { synthesize } as unknown as TtsRouter;
}

describe('TtsPipeline', () => {
  let pipeline: TtsPipeline;
  let mockRouter: TtsRouter;
  let sentJson: ServerMessage[];
  let sentBinary: Buffer[];

  beforeEach(() => {
    mockRouter = createMockRouter();
    sentJson = [];
    sentBinary = [];
    pipeline = new TtsPipeline({
      ttsRouter: mockRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: (data) => sentBinary.push(data),
      maxParallel: 2,
    });
  });

  it('processes a single chunk and sends tts_meta + binary', async () => {
    await pipeline.processChunk('Hello world', 0, 'turn-1');
    await pipeline.finish();

    expect(sentJson.some((m) => m.type === 'tts_meta')).toBe(true);
    expect(sentBinary.length).toBe(1);
    expect(sentJson.some((m) => m.type === 'tts_done')).toBe(true);
  });

  it('sends chunks in order even when synthesis completes out-of-order', async () => {
    // Chunk 1 takes longer than chunk 0 — but both should be dispatched
    // because maxParallel=2
    let resolveSlowChunk: (() => void) | null = null;
    let callCount = 0;
    const slowRouter = {
      synthesize: vi.fn(async (text: string) => {
        callCount++;
        if (callCount === 1) {
          // First call (index 0) — slow
          await new Promise<void>((r) => { resolveSlowChunk = r; });
        }
        const pcm = Buffer.alloc(3200);
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcm.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(16000, 24);
        header.writeUInt32LE(32000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcm.length, 40);
        return { audio: Buffer.concat([header, pcm]), provider: 'mock' };
      }),
    } as unknown as TtsRouter;

    const orderedJson: ServerMessage[] = [];
    const orderedBinary: Buffer[] = [];
    const orderedPipeline = new TtsPipeline({
      ttsRouter: slowRouter,
      sendJson: (msg) => orderedJson.push(msg),
      sendBinary: (data) => orderedBinary.push(data),
      maxParallel: 2,
    });

    // Queue both chunks
    await orderedPipeline.processChunk('First chunk', 0, 'turn-1');
    await orderedPipeline.processChunk('Second chunk', 1, 'turn-1');

    // Chunk 1 completes first (fast), chunk 0 is still pending
    // Wait a tick for chunk 1 to complete
    await new Promise((r) => setTimeout(r, 10));

    // Binary should NOT have been sent yet because chunk 0 hasn't completed
    expect(orderedBinary.length).toBe(0);

    // Now resolve chunk 0
    resolveSlowChunk!();
    await orderedPipeline.finish();

    // Both should now be sent in order
    expect(orderedBinary.length).toBe(2);
    const metaMsgs = orderedJson.filter((m) => m.type === 'tts_meta') as Array<{ type: 'tts_meta'; index: number }>;
    expect(metaMsgs[0].index).toBe(0);
    expect(metaMsgs[1].index).toBe(1);
  });

  it('cancel stops pending synthesis and emits tts_done', async () => {
    // Don't await processChunk finish — cancel immediately
    pipeline.processChunk('Hello', 0, 'turn-1');
    pipeline.cancel();

    expect(sentJson.some((m) => m.type === 'tts_done')).toBe(true);
  });

  it('reset clears all state', async () => {
    await pipeline.processChunk('Hello', 0, 'turn-1');
    await pipeline.finish();

    const prevJsonCount = sentJson.length;
    const prevBinaryCount = sentBinary.length;

    pipeline.reset();
    await pipeline.processChunk('World', 0, 'turn-2');
    await pipeline.finish();

    // Should have sent new tts_meta + binary + tts_done after reset
    const newMeta = sentJson.slice(prevJsonCount).filter((m) => m.type === 'tts_meta');
    expect(newMeta.length).toBe(1);
    expect(sentBinary.length).toBe(prevBinaryCount + 1);
  });

  it('cancelled pipeline ignores new chunks', async () => {
    pipeline.cancel();
    await pipeline.processChunk('Ignored', 0, 'turn-1');
    // Only the tts_done from cancel should exist, no tts_meta
    expect(sentJson.filter((m) => m.type === 'tts_meta').length).toBe(0);
  });

  it('emits error event when synthesis fails', async () => {
    const failingRouter = {
      synthesize: vi.fn(async () => { throw new Error('TTS failed'); }),
    } as unknown as TtsRouter;

    const errorPipeline = new TtsPipeline({
      ttsRouter: failingRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: (data) => sentBinary.push(data),
    });

    const errors: Error[] = [];
    errorPipeline.on('error', (e) => errors.push(e));

    await errorPipeline.processChunk('Hello', 0, 'turn-1');
    // Wait for synthesis to fail
    await new Promise((r) => setTimeout(r, 10));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('TTS failed');
  });

  it('sends tts_meta with correct WAV metadata', async () => {
    await pipeline.processChunk('Test audio metadata', 0, 'turn-1');
    await pipeline.finish();

    const meta = sentJson.find((m) => m.type === 'tts_meta') as {
      type: 'tts_meta';
      format: string;
      index: number;
      sampleRate: number;
      durationMs: number;
    };
    expect(meta).toBeDefined();
    expect(meta.format).toBe('wav');
    expect(meta.index).toBe(0);
    expect(meta.sampleRate).toBe(16000);
    expect(meta.durationMs).toBeGreaterThan(0);
  });

  it('event-driven drain resolves without polling delay', async () => {
    const start = Date.now();
    await pipeline.processChunk('Fast chunk', 0, 'turn-1');
    await pipeline.finish();
    const elapsed = Date.now() - start;

    // With event-driven drain, finish() should resolve almost instantly
    // after synthesis completes (no 50ms polling delay)
    expect(elapsed).toBeLessThan(500);
    expect(sentBinary.length).toBe(1);
  });

  it('failed chunk is tracked and skipped in sendInOrder', async () => {
    let callCount = 0;
    const partialFailRouter = {
      synthesize: vi.fn(async (text: string) => {
        callCount++;
        if (callCount === 2) {
          // Fail the second chunk (index 1)
          throw new Error('TTS failed for chunk 1');
        }
        const pcm = Buffer.alloc(3200);
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcm.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(16000, 24);
        header.writeUInt32LE(32000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcm.length, 40);
        return { audio: Buffer.concat([header, pcm]), provider: 'mock' };
      }),
    } as unknown as TtsRouter;

    const json: ServerMessage[] = [];
    const binary: Buffer[] = [];
    const failPipeline = new TtsPipeline({
      ttsRouter: partialFailRouter,
      sendJson: (msg) => json.push(msg),
      sendBinary: (data) => binary.push(data),
      maxParallel: 2,
    });
    failPipeline.on('error', () => {}); // Prevent unhandled error

    await failPipeline.processChunk('Chunk 0', 0, 'turn-1');
    await failPipeline.processChunk('Chunk 1', 1, 'turn-1');
    await failPipeline.processChunk('Chunk 2', 2, 'turn-1');
    await failPipeline.finish();

    // Chunks 0 and 2 should be sent, chunk 1 skipped
    expect(binary.length).toBe(2);
    const metaMsgs = json.filter((m) => m.type === 'tts_meta') as Array<{ type: 'tts_meta'; index: number }>;
    expect(metaMsgs[0].index).toBe(0);
    expect(metaMsgs[1].index).toBe(2);
  });

  it('emits all_failed when every chunk fails', async () => {
    // Use a failing router with a delay to ensure synthesis is in-flight
    // when finish() is called
    const failingRouter = {
      synthesize: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error('All providers down');
      }),
    } as unknown as TtsRouter;

    const json: ServerMessage[] = [];
    const allFailedPipeline = new TtsPipeline({
      ttsRouter: failingRouter,
      sendJson: (msg) => json.push(msg),
      sendBinary: () => {},
      maxParallel: 2,
    });
    allFailedPipeline.on('error', () => {}); // Prevent unhandled error

    const allFailedHandler = vi.fn();
    allFailedPipeline.on('all_failed', allFailedHandler);

    await allFailedPipeline.processChunk('Chunk 0', 0, 'turn-1');
    await allFailedPipeline.processChunk('Chunk 1', 1, 'turn-1');

    // Both should be in-flight now
    expect((allFailedPipeline as any).inFlight).toBe(2);

    // finish() calls drainAll which waits for inFlight to hit 0
    await allFailedPipeline.finish();

    expect((allFailedPipeline as any).failedTotal).toBe(2);
    expect(allFailedHandler).toHaveBeenCalledTimes(1);
    expect(json.some((m) => m.type === 'tts_done')).toBe(true);
  });

  it('reset clears drain state and failed chunks', async () => {
    const failingRouter = {
      synthesize: vi.fn(async () => { throw new Error('fail'); }),
    } as unknown as TtsRouter;

    const json: ServerMessage[] = [];
    const resetPipeline = new TtsPipeline({
      ttsRouter: failingRouter,
      sendJson: (msg) => json.push(msg),
      sendBinary: () => {},
    });
    resetPipeline.on('error', () => {});

    await resetPipeline.processChunk('Fail', 0, 'turn-1');
    await new Promise((r) => setTimeout(r, 10));
    resetPipeline.reset();

    // After reset, pipeline should work with a new router
    const goodRouter = createMockRouter();
    (resetPipeline as any).ttsRouter = goodRouter;
    json.length = 0;

    await resetPipeline.processChunk('Success', 0, 'turn-2');
    await resetPipeline.finish();

    expect(json.some((m) => m.type === 'tts_meta')).toBe(true);
    expect(json.some((m) => m.type === 'tts_done')).toBe(true);
  });
});
