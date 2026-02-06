import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsPipeline } from '../pipeline.js';
import { TtsRouter } from '../router.js';
import type { ServerMessage } from '../../types.js';

function makeWav(pcmBytes: number = 3200): Buffer {
  const pcm = Buffer.alloc(pcmBytes);
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
  return Buffer.concat([header, pcm]);
}

describe('TtsPipeline — generation counter (cancel+reset race)', () => {
  it('stale synthesis completing after cancel+reset does not corrupt inFlight', async () => {
    // Scenario:
    // 1. processChunk starts synthesis (inFlight=1)
    // 2. cancel() is called (cancelled=true, inFlight still 1)
    // 3. reset() is called (inFlight=0, cancelled=false, generation++)
    // 4. The synthesis from step 1 completes
    // Without the generation counter fix, step 4 would decrement inFlight to -1,
    // causing dispatch() to start too many syntheses (since -1 < maxParallel).

    let resolver: ((value: { audio: Buffer; provider: string }) => void) | null = null;
    let callCount = 0;
    const slowRouter = {
      synthesize: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // First call (turn 1) — hold it open
          return new Promise<{ audio: Buffer; provider: string }>((resolve) => {
            resolver = resolve;
          });
        }
        // Subsequent calls (turn 2) — resolve immediately
        return { audio: makeWav(), provider: 'mock' };
      }),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const sentBinary: Buffer[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: slowRouter,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: (data) => sentBinary.push(data),
      maxParallel: 2,
    });

    // Turn 1: start synthesis
    await pipeline.processChunk('Turn one text', 0, 'turn-1');
    expect(callCount).toBe(1);

    // Cancel + reset (simulates barge-in → new turn)
    pipeline.cancel();
    pipeline.reset();

    // Turn 2: start new synthesis
    await pipeline.processChunk('Turn two text', 0, 'turn-2');
    expect(callCount).toBe(2);

    // Now resolve the stale turn-1 synthesis
    (resolver as ((value: { audio: Buffer; provider: string }) => void) | null)?.({ audio: makeWav(), provider: 'mock' });
    await new Promise((r) => setTimeout(r, 10));

    // The stale synthesis should be silently ignored.
    // Verify: Turn 2 should complete normally.
    await pipeline.finish();

    // Check that turn 2 produced exactly one tts_meta (index 0)
    // and one tts_done. The stale turn-1 result should not appear.
    const metaMsgs = sentJson.filter((m) => m.type === 'tts_meta');
    const doneMsgs = sentJson.filter((m) => m.type === 'tts_done');
    // Turn 1 cancel sends tts_done, turn 2 finish sends tts_done
    expect(doneMsgs.length).toBe(2);
    // Only turn 2 should have produced a tts_meta
    expect(metaMsgs.length).toBe(1);
  });

  it('stale synthesis error after cancel+reset does not emit error', async () => {
    let rejecter: ((reason: Error) => void) | null = null;
    let callCount = 0;
    const failingRouter = {
      synthesize: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Promise<never>((_resolve, reject) => {
            rejecter = reject;
          });
        }
        return { audio: makeWav(), provider: 'mock' };
      }),
    } as unknown as TtsRouter;

    const errors: unknown[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: failingRouter,
      sendJson: () => {},
      sendBinary: () => {},
    });
    pipeline.on('error', (err) => errors.push(err));

    // Start synthesis for turn 1
    await pipeline.processChunk('Text', 0, 'turn-1');

    // Cancel + reset
    pipeline.cancel();
    pipeline.reset();

    // Reject the stale synthesis
    (rejecter as ((reason?: unknown) => void) | null)?.(new Error('Network error'));
    await new Promise((r) => setTimeout(r, 10));

    // The error should be silently swallowed since it belongs to the old generation
    expect(errors.length).toBe(0);
  });

  it('inFlight does not go negative after rapid cancel+reset cycles', async () => {
    const resolvers: Array<(value: { audio: Buffer; provider: string }) => void> = [];
    const router = {
      synthesize: vi.fn(async () => {
        return new Promise<{ audio: Buffer; provider: string }>((resolve) => {
          resolvers.push(resolve);
        });
      }),
    } as unknown as TtsRouter;

    const sentJson: ServerMessage[] = [];
    const pipeline = new TtsPipeline({
      ttsRouter: router,
      sendJson: (msg) => sentJson.push(msg),
      sendBinary: () => {},
      maxParallel: 2,
    });

    // Rapid cycle: start → cancel → reset × 3
    for (let i = 0; i < 3; i++) {
      await pipeline.processChunk(`Text ${i}`, 0, `turn-${i}`);
      pipeline.cancel();
      pipeline.reset();
    }

    // Resolve all stale syntheses
    for (const resolver of resolvers) {
      resolver({ audio: makeWav(), provider: 'mock' });
    }
    await new Promise((r) => setTimeout(r, 10));

    // After all stale work completes, the pipeline should be in a clean state.
    // Verify by running a new turn successfully.
    await pipeline.processChunk('Final turn text', 0, 'final-turn');

    // Resolve the final turn synthesis too.
    const finalResolver = resolvers[resolvers.length - 1];
    finalResolver({ audio: makeWav(), provider: 'mock' });

    await pipeline.finish();

    // Should have tts_meta from the final turn
    const metaAfterCycles = sentJson.filter((m) => m.type === 'tts_meta');
    expect(metaAfterCycles.length).toBe(1);
  });
});
