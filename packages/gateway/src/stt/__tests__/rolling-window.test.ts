import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RollingWindowSTT } from '../rolling-window.js';
import { ParakeetClient } from '../parakeet-client.js';
import type { TranscribeResult } from '../../types.js';

function mockResult(text: string): TranscribeResult {
  return { text, confidence: 0.95, segments: [] };
}

function createMockClient(results: string[]): ParakeetClient {
  let callIdx = 0;
  const client = {
    transcribe: vi.fn(async () => {
      const text = results[Math.min(callIdx, results.length - 1)];
      callIdx++;
      return mockResult(text);
    }),
  } as unknown as ParakeetClient;
  return client;
}

function feedDummyAudio(stt: RollingWindowSTT) {
  stt.appendAudio(Buffer.alloc(3200));
}

/**
 * Helper to call the private processDecodeResult method directly.
 * This lets us test the stable prefix algorithm without fake timers.
 */
function processDecodeResult(stt: RollingWindowSTT, transcript: string): { stable: string; unstable: string } {
  return (stt as any).processDecodeResult(transcript);
}

describe('RollingWindowSTT — Stable prefix tracking', () => {
  let client: ParakeetClient;
  let stt: RollingWindowSTT;

  beforeEach(() => {
    client = createMockClient([]);
    stt = new RollingWindowSTT(client);
  });

  it('first decode has no stable prefix', () => {
    const result = processDecodeResult(stt, 'hello world');
    expect(result.stable).toBe('');
    expect(result.unstable).toBe('hello world');
  });

  it('two matching decodes create stable prefix', () => {
    processDecodeResult(stt, 'hello world');
    const result = processDecodeResult(stt, 'hello world how are you');

    // Common prefix: "hello world" (11 chars)
    // lastIndexOf(' ') in "hello world" = 5
    // stablePrefix = "hello world".substring(0, 6).trimEnd() = "hello"
    expect(result.stable).toBe('hello');
    expect(result.unstable).toBe(' world how are you');
  });

  it('prefix snaps to word boundary', () => {
    processDecodeResult(stt, 'testing the algorithm');
    const result = processDecodeResult(stt, 'testing the algorithms are great');

    // Common character prefix: "testing the algorithm" (21 chars)
    // char 21 in second string is 's' but first string ends -> common = "testing the algorithm"
    // Hmm actually let me trace through more carefully:
    // "testing the algorithm" has length 21
    // "testing the algorithms are great" has length 31
    // Char-by-char comparison up to min(21, 31) = 21:
    // All 21 chars of first string... index 0-20
    // first[20] = 'm', second[20] = 'm' (both are "algorithm") -> match
    // But wait: first string is "testing the algorithm" (ends), second is "testing the algorithms..."
    // The loop goes i < recent[0].length where recent[0] is first decode
    // recent[0] = "testing the algorithm", length 21
    // At i=20: recent[0][20] = 'm', recent[1][20] = 'm' -> match
    // i=21: loop ends (i < 21 is false)
    // Wait but the loop iterates over recent[0], which is the first transcript "testing the algorithm"
    // Actually no: decodeHistory = ["testing the algorithm", "testing the algorithms are great"]
    // recent = last 2 = same
    // Loop: for i=0; i < recent[0].length (21); i++
    // All 21 chars match -> commonPrefix = "testing the algorithm"
    // lastIndexOf(' ') = 11 (space between "the" and "algorithm")
    // stablePrefix = "testing the algorithm".substring(0, 12).trimEnd() = "testing the"
    expect(result.stable).toBe('testing the');
  });

  it('prefix grows monotonically', () => {
    processDecodeResult(stt, 'the quick brown');
    const r2 = processDecodeResult(stt, 'the quick brown fox');
    const r3 = processDecodeResult(stt, 'the quick brown fox jumps over');

    // Decode 1: stable = '' (only 1 decode, need threshold=2)
    // Decode 2: common("the quick brown", "the quick brown fox") = "the quick brown"
    //   lastSpace = 9 -> stable = "the quick"
    // Decode 3: common("the quick brown fox", "the quick brown fox jumps over") = "the quick brown fox"
    //   lastSpace = 15 -> but must be > current stable (9), so 15 > 9 -> stable = "the quick brown"
    expect(r2.stable).toBe('the quick');
    expect(r3.stable.length).toBeGreaterThanOrEqual(r2.stable.length);
    expect(r3.stable).toBe('the quick brown');
  });

  it('divergent decodes keep last stable prefix', () => {
    processDecodeResult(stt, 'hello world today');
    const r2 = processDecodeResult(stt, 'hello world today');
    const r3 = processDecodeResult(stt, 'hello completely different text now');

    // Decode 2: identical transcripts -> common = "hello world today"
    //   lastSpace = 11 -> stable = "hello world"
    expect(r2.stable).toBe('hello world');

    // Decode 3: common("hello world today", "hello completely different text now")
    //   chars match: h,e,l,l,o,' ' then diverge at 'w' vs 'c' -> commonPrefix = "hello "
    //   lastSpace = 5, but 5 < stablePrefix.length (11) -> NO UPDATE
    //   stablePrefix stays as "hello world"
    expect(r3.stable).toBe('hello world');
    expect(r3.stable.length).toBeGreaterThanOrEqual(r2.stable.length);
  });

  it('identical consecutive decodes stabilize entire common prefix', () => {
    processDecodeResult(stt, 'the cat sat on the mat');
    const r2 = processDecodeResult(stt, 'the cat sat on the mat');

    // Identical transcripts -> commonPrefix = "the cat sat on the mat"
    // lastSpace = 19 (before "mat") -> stablePrefix = "the cat sat on the"
    expect(r2.stable).toBe('the cat sat on the');
  });

  it('empty transcript does not crash', () => {
    const r = processDecodeResult(stt, '');
    expect(r.stable).toBe('');
    expect(r.unstable).toBe('');
  });

  it('single word transcripts handle correctly', () => {
    processDecodeResult(stt, 'hello');
    const r2 = processDecodeResult(stt, 'hello');

    // Common prefix = "hello", lastIndexOf(' ') = -1
    // -1 > 0 is false -> no stable prefix update
    expect(r2.stable).toBe('');
    expect(r2.unstable).toBe('hello');
  });
});

describe('RollingWindowSTT — Integration', () => {
  it('finalize emits transcript_final', async () => {
    const client = createMockClient(['final transcript text']);
    const stt = new RollingWindowSTT(client);
    const handler = vi.fn();
    stt.on('transcript_final', handler);

    feedDummyAudio(stt);
    const result = await stt.finalize();

    expect(result.text).toBe('final transcript text');
    expect(handler).toHaveBeenCalledWith({ text: 'final transcript text' });
  });

  it('reset clears all state and stops timer', () => {
    vi.useFakeTimers();
    const client = createMockClient(['hello']);
    const stt = new RollingWindowSTT(client);

    feedDummyAudio(stt);
    stt.start();
    stt.reset();

    // After reset, advancing time should not call transcribe
    vi.advanceTimersByTime(2000);
    expect(client.transcribe).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('appendAudio accumulates buffer', () => {
    const client = createMockClient([]);
    const stt = new RollingWindowSTT(client);

    stt.appendAudio(Buffer.alloc(100));
    stt.appendAudio(Buffer.alloc(200));

    // Access private audioBytes to verify
    expect((stt as any).audioBytes).toBe(300);
  });

  it('decodeCycle calls transcribe and emits transcript_partial', async () => {
    const client = createMockClient(['hello world']);
    const stt = new RollingWindowSTT(client);
    const handler = vi.fn();
    stt.on('transcript_partial', handler);

    feedDummyAudio(stt);
    // Call decodeCycle directly to avoid fake timer issues with async
    await (stt as any).decodeCycle();

    expect(client.transcribe).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ stable: '', unstable: 'hello world', text: 'hello world' }),
    );
  });

  it('decodeCycle skips when no audio', async () => {
    vi.useFakeTimers();
    const client = createMockClient(['hello']);
    const stt = new RollingWindowSTT(client);

    // Start without feeding audio
    stt.start();

    await vi.advanceTimersByTimeAsync(501);
    await vi.advanceTimersByTimeAsync(0);

    // No audio means audioBytes=0, decodeCycle should bail early
    expect(client.transcribe).not.toHaveBeenCalled();

    stt.reset();
    vi.useRealTimers();
  });

  it('buildWav creates valid WAV header', () => {
    const client = createMockClient([]);
    const stt = new RollingWindowSTT(client);
    const pcm = Buffer.alloc(100);
    const wav: Buffer = (stt as any).buildWav(pcm);

    // WAV header should be 44 bytes + PCM data
    expect(wav.length).toBe(144);
    // Check RIFF header
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    // Check PCM data size in header
    expect(wav.readUInt32LE(40)).toBe(100);
  });
});
