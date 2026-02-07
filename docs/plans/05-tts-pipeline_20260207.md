# Plan 05: TTS Pipeline Fixes

**Improvement:** #5 from audit — TTS pipeline polling and no error recovery
**Date:** 2026-02-07
**Author:** streaming-pipeline agent

---

## Problem Statement

Three issues in the TTS pipeline (`tts/pipeline.ts`):

### 1. Polling drain (CPU waste)
`drainAll()` polls every 50ms in a `setTimeout` loop with a 30-second timeout. This is a busy-wait that wastes CPU cycles when it could be event-driven.

```typescript
// Current: polling loop
private drainAll(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (this.inFlight === 0 && this.pendingChunks.size === 0) {
        this.sendInOrder();
        resolve();
        return;
      }
      setTimeout(check, 50);  // <-- polls every 50ms
    };
    check();
  });
}
```

### 2. Failed chunks silently dropped
If `ttsRouter.synthesize()` throws for a specific chunk, that chunk is lost. The pipeline emits an `error` event but never retries with the fallback provider. The `TtsRouter` does provider-level failover (switch Kokoro to OpenAI after 3 failures), but if a single chunk fails below the threshold, it just disappears — causing a gap in the audio.

### 3. Stuck connections on total failure
If ALL chunks fail (e.g., both Kokoro and OpenAI are down), the pipeline sits in `speaking` state waiting for `drainAll()` to timeout after 30 seconds. The `finish()` method eventually resolves via the safety timeout, sends `tts_done`, and `onLlmDone` in handler.ts transitions to idle. But for 30 seconds the connection is stuck.

---

## Goal

Replace the polling drain with an event-driven approach, add per-chunk retry with fallback, and ensure proper state transitions when all chunks fail.

---

## Detailed Design

### 1. Event-driven drain: replace polling with a deferred Promise

Replace the `setTimeout` polling loop with a resolve callback that is called when the last in-flight synthesis completes.

**New approach:** Track a `drainResolve` callback. When `synthesizeAndQueue` completes (success or failure) and detects that `inFlight === 0 && pendingChunks.size === 0`, it calls the resolver.

```typescript
private drainResolve: (() => void) | null = null;

private drainAll(): Promise<void> {
  // If already drained, resolve immediately
  if (this.inFlight === 0 && this.pendingChunks.size === 0) {
    this.sendInOrder();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    this.drainResolve = resolve;

    // Safety timeout — don't hang forever
    const timeout = setTimeout(() => {
      if (this.drainResolve === resolve) {
        this.drainResolve = null;
        this.sendInOrder();
        resolve();
      }
    }, 30_000);

    // Store timeout ref so we can clear it on normal resolution
    this._drainTimeout = timeout;
  });
}

private checkDrained() {
  if (this.inFlight === 0 && this.pendingChunks.size === 0 && this.drainResolve) {
    this.sendInOrder();
    if (this._drainTimeout) {
      clearTimeout(this._drainTimeout);
      this._drainTimeout = null;
    }
    const resolve = this.drainResolve;
    this.drainResolve = null;
    resolve();
  }
}
```

Call `checkDrained()` at the end of `synthesizeAndQueue()` (both success and error paths) and in `cancel()`.

**Benefits:**
- Zero CPU cost while waiting (no polling)
- Resolves immediately when last chunk completes (no 50ms delay)
- Keeps the 30s safety timeout for truly stuck scenarios

### 2. Per-chunk failure tracking (no pipeline-level retry)

> **Cross-review note (2026-02-07):** Plan 07 (Provider Failover) restructures `TtsRouter.synthesize()` to internally try both providers (preferred first, then fallback via `tryProvider()`). This means a single `synthesize()` call already does per-request fallback. The pipeline does NOT need its own retry logic — if `synthesize()` throws, both providers have already been tried. The pipeline only needs to track which chunks failed so it can skip them in ordered delivery.

When `ttsRouter.synthesize()` throws, mark the chunk as failed instead of silently dropping it:

**Change in `synthesizeAndQueue()`:**

```typescript
private async synthesizeAndQueue(text: string, index: number) {
  const gen = this.generation;
  try {
    const { audio } = await this.ttsRouter.synthesize(text);
    if (gen !== this.generation) return;
    this.completedAudio.set(index, audio);
  } catch (err) {
    if (gen !== this.generation) return;
    // TtsRouter already tried both providers internally (per Plan 07).
    // If we get here, both providers failed for this chunk.
    this.failedChunks.add(index);
    this.emit('error', err);
  } finally {
    if (gen === this.generation) {
      this.inFlight--;
      this.sendInOrder();
      this.dispatch();
      this.checkDrained();
    }
  }
}
```

No `synthesizeWithFallback()` method is needed — the router handles per-request fallback internally.

### 3. Handle failed chunks in sendInOrder()

Currently, `sendInOrder()` loops while `completedAudio.has(nextSendIndex)`. If chunk N failed, it stops at N forever (or until drain timeout). With the retry logic above, most failures are recovered. But if both providers fail, we need to skip the failed chunk:

```typescript
private sendInOrder() {
  while (true) {
    if (this.cancelled) {
      this.completedAudio.clear();
      return;
    }

    if (this.completedAudio.has(this.nextSendIndex)) {
      const audio = this.completedAudio.get(this.nextSendIndex)!;
      this.completedAudio.delete(this.nextSendIndex);
      // ... send tts_meta + binary (existing code) ...
      this.nextSendIndex++;
      continue;
    }

    if (this.failedChunks.has(this.nextSendIndex)) {
      // Skip this chunk — both providers failed
      this.failedChunks.delete(this.nextSendIndex);
      this.nextSendIndex++;
      continue;
    }

    // Neither completed nor failed — still in-flight or pending
    break;
  }
}
```

### 4. Chunk-level timeouts via Promise.race

Add a per-chunk timeout so that a single slow synthesis doesn't block the entire pipeline. Currently Kokoro has a 10s timeout and OpenAI has 15s, set in their respective clients. These are sufficient as per-request timeouts, but we add a pipeline-level guard:

```typescript
private async synthesizeWithTimeout(
  text: string,
  timeoutMs: number = 12_000,
): Promise<{ audio: Buffer; provider: string }> {
  return Promise.race([
    this.ttsRouter.synthesize(text),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TTS chunk timeout')), timeoutMs)
    ),
  ]);
}
```

Use `synthesizeWithTimeout()` instead of `this.ttsRouter.synthesize()` in `synthesizeAndQueue()`. The 12s timeout is slightly longer than Kokoro's 10s client timeout to let the client timeout fire first (more informative error), but short enough to prevent indefinite hangs.

### 5. State transition on all-chunks-failed

If every chunk in a response fails (both providers down), the pipeline needs to signal this so the handler transitions out of `speaking`. The current behavior: `finish()` calls `drainAll()` which eventually resolves via safety timeout, then sends `tts_done`, then `onLlmDone` in handler.ts transitions to idle.

With the new design, `drainAll()` resolves immediately when all chunks are either completed or failed (no more in-flight). Then `finish()` sends `tts_done`. The handler transitions to idle normally.

**Additional signal:** Emit a `'all_failed'` event when `failedChunks.size > 0 && completedAudio.size === 0` at drain resolution, so the handler can send a specific error to the client:

```typescript
// In finish():
async finish() {
  await this.drainAll();
  if (!this.cancelled) {
    if (this.totalChunks > 0 && this.failedChunks.size === this.totalChunks) {
      this.emit('all_failed');
    }
    this.sendJson({ type: 'tts_done' });
    this.emit('done');
  }
}
```

Wire in handler.ts:
```typescript
conn.ttsPipeline.on('all_failed', () => {
  sendMessage(conn, {
    type: 'error',
    code: 'tts_all_failed',
    message: 'All TTS chunks failed — no audio for this response',
    recoverable: true,
  });
});
```

### 6. Track total chunks for the all-failed check

Add a `totalChunks` counter that increments in `processChunk()` and resets in `reset()`:

```typescript
private totalChunks: number = 0;
private failedChunks: Set<number> = new Set();

async processChunk(text: string, index: number, turnId: string) {
  if (this.cancelled) return;
  this.totalChunks = Math.max(this.totalChunks, index + 1);
  this.pendingChunks.set(index, { text, turnId });
  await this.dispatch();
}

reset() {
  // ... existing reset logic ...
  this.totalChunks = 0;
  this.failedChunks.clear();
  this.drainResolve = null;
  if (this._drainTimeout) {
    clearTimeout(this._drainTimeout);
    this._drainTimeout = null;
  }
}
```

### 7. PhraseChunker — no changes needed

The `PhraseChunker` operates upstream of the TTS pipeline (in the LLM pipeline). It emits `PhraseChunk` objects with `text` and `index`. The TTS pipeline consumes these. No changes needed to the chunker.

---

## Updated TtsPipeline Interface

```typescript
class TtsPipeline extends EventEmitter {
  // Public API (unchanged signatures)
  processChunk(text: string, index: number, turnId: string): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
  reset(): void;

  // Events
  //   'done'       — all chunks sent successfully
  //   'cancelled'  — pipeline was cancelled
  //   'error'      — a chunk failed (after retry)
  //   'all_failed' — every chunk in the response failed (NEW)
}
```

---

## Testing Strategy

### Unit Tests — TtsPipeline

Existing tests (6 in `tts-pipeline.test.ts`) cover:
- Single chunk processing
- Out-of-order completion with in-order sending
- Cancel stops pending synthesis
- Reset clears state
- Cancelled pipeline ignores new chunks
- Error event on synthesis failure

New tests needed:

1. **Event-driven drain resolves without polling** — Verify that `finish()` resolves immediately after last chunk completes (no 50ms delay).

2. **Chunk failure is tracked** — Mock TtsRouter.synthesize() to throw (both providers already tried internally per Plan 07). Verify the chunk is added to `failedChunks` and an error event is emitted.

3. **Failed chunk is skipped in sendInOrder** — Fail chunk 1 (synthesize throws). Verify `sendInOrder()` skips it and delivers chunks 0 and 2.

4. **Failed chunk doesn't block subsequent chunks** — Fail chunk 1, succeed chunks 0 and 2. Verify chunks 0 and 2 are sent, chunk 1 is skipped.

5. **All-failed event** — All chunks fail. Verify `all_failed` event is emitted.

6. **Chunk timeout** — Mock a synthesis that never resolves. Verify the chunk times out and the pipeline continues.

7. **Drain safety timeout still works** — Simulate a stuck inFlight counter. Verify drain resolves after 30s. (This should be rare with the new design but the safety net should still work.)

8. **Reset clears drain state** — Call `finish()`, then `reset()` before it resolves. Verify no stale resolution.

### Integration Tests

Update `handler-pipeline.test.ts`:
1. **TTS error sends error message but pipeline continues** — Fail one chunk, verify error message sent to client but other chunks succeed.
2. **All TTS failures send tts_all_failed error and transition to idle** — All chunks fail, verify client gets the error and connection returns to idle.

### Test Pattern

Follow existing patterns from `tts-pipeline.test.ts`:
- Mock `TtsRouter` with `vi.fn()` for `synthesize` and `synthesizeWithFallback`
- Capture `sentJson` and `sentBinary` arrays
- Use real timers (no fake timers needed — the new design is event-driven)

---

## Cross-Review Notes (2026-02-07)

**Dependency on Plan 07 (Provider Failover):** This plan depends on Plan 07's restructured `TtsRouter.synthesize()` which internally tries both providers per-request. Plan 07 should land first, then this plan. The original `synthesizeWithFallback()` method has been removed from this plan since the router handles fallback internally.

**Compatibility with Plan 08 (Observability):** Plan 08 instruments `tts/pipeline.ts` with `turn_tts_first_chunk_ms` and `turn_tts_total_ms` metrics. The event-driven drain and `failedChunks` tracking are compatible with these instrumentation points. The optional `metrics` parameter can be added to `TtsPipelineOptions` alongside the existing fields.

---

## Migration Strategy

### Backward Compatibility

The external interface of `TtsPipeline` is unchanged:
- `processChunk()`, `finish()`, `cancel()`, `reset()` — same signatures
- Events: `done`, `cancelled`, `error` — same
- New event: `all_failed` — purely additive, existing code ignores it

The `TtsRouter` gains one new method: `synthesizeWithFallback()`. This does not affect existing callers.

### Rollout

1. Add `synthesizeWithFallback()` to TtsRouter
2. Add `failedChunks`, `totalChunks`, `drainResolve` fields to TtsPipeline
3. Replace `drainAll()` polling with event-driven approach
4. Add per-chunk retry logic to `synthesizeAndQueue()`
5. Update `sendInOrder()` to skip failed chunks
6. Add `all_failed` event emission in `finish()`
7. Wire `all_failed` handler in `handler.ts`
8. Run tests

All changes are internal. No protocol changes. No client changes required.

---

## Risks and Mitigations

### Risk 1: Per-request fallback latency in TtsRouter
Per Plan 07, `TtsRouter.synthesize()` internally tries both providers. If Kokoro times out (10s) and then OpenAI is tried, the chunk takes 10s+. This is handled at the router level (not the pipeline level). The pipeline-level chunk timeout (12s via `Promise.race`) caps the total time per `synthesize()` call, which may cut off the fallback attempt.

**Mitigation:** The router's client-level timeouts (Kokoro 10s, OpenAI 15s) are the primary guards. The pipeline timeout should be set above the sum of both client timeouts would be too high, so it should be set to allow the router's internal fallback to complete. Set pipeline timeout to 20s (allows Kokoro timeout + OpenAI attempt). In practice, Kokoro either responds in <2s or fails quickly (connection refused), so the 10s timeout rarely fires.

### Risk 2: Event-driven drain has a race condition
If `synthesizeAndQueue` calls `checkDrained()` before `drainAll()` sets `drainResolve`, the drain never resolves.

**Mitigation:** `drainAll()` checks the immediate state first (`inFlight === 0 && pendingChunks.size === 0`) and resolves synchronously. The race only occurs if a chunk completes between the check and setting `drainResolve`, which is impossible in single-threaded JS — the await point is after `drainResolve` is set.

### Risk 3: failedChunks grows unbounded
If chunks keep failing, `failedChunks` is a Set of integers that grows to the number of chunks. For a typical response (5-15 chunks), this is negligible. Reset clears it.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/gateway/src/tts/pipeline.ts` | Replace drainAll polling, add per-chunk retry, add failedChunks tracking, add all_failed event |
| `packages/gateway/src/ws/handler.ts` | Wire `all_failed` event handler |
| `packages/gateway/src/tts/__tests__/tts-pipeline.test.ts` | Add tests for event-driven drain, failed chunk tracking/skipping, all_failed event |

---

## Estimated Complexity

- **TtsPipeline changes:** Medium — replace drain, add retry logic, add failure tracking
- **TtsRouter changes:** Small — one new method
- **handler.ts changes:** Small — wire one new event handler
- **Tests:** Medium — ~8 new test cases
- **Protocol:** None
