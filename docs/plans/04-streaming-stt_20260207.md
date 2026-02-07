# Plan 04: Streaming STT Integration

**Improvement:** #4 from audit — No streaming STT integration
**Date:** 2026-02-07
**Author:** streaming-pipeline agent

---

## Problem Statement

`RollingWindowSTT` (160 lines in `stt/rolling-window.ts`) implements periodic decode cycles with stable/unstable prefix tracking — but it is **never used**. The handler (`ws/handler.ts`) buffers all audio during `LISTENING`, waits for a 1.5s silence timeout, then sends the entire buffer to Parakeet in a single `transcribe()` call. The user sees nothing until speech ends + full-buffer STT completes.

This adds **1.5s silence timeout + full-buffer transcription time** to every turn. For a 5-second utterance, the user waits ~2-3 seconds after stopping speech before seeing any transcript. The spec explicitly calls for streaming partials.

## Goal

Feed audio to Parakeet every ~500ms during speech, display streaming partials on the client, and start the auto-send countdown from the moment the final transcript stabilizes — not from when silence is detected.

---

## Current Data Flow

```
Client VAD → binary frames → handler.ts buffers audio
  → 1.5s silence timeout fires
  → processAudioBuffer() concatenates all audio
  → sttRouter.transcribe(fullAudio)
  → transcript_final → PENDING_SEND
  → auto-send countdown (1.5s)
  → transcript_send → LLM pipeline
```

**Total latency from end-of-speech to LLM:** ~1.5s (silence) + ~0.5-1.5s (STT) + 1.5s (auto-send) = **3.5-4.5s**

## Proposed Data Flow

```
Client VAD → binary frames → handler.ts feeds audio to RollingWindowSTT
  → every 500ms: decode cycle → transcript_partial to client
  → 1.5s silence timeout fires
  → RollingWindowSTT.finalize() (full-buffer decode for accuracy)
  → transcript_final → PENDING_SEND
  → auto-send countdown (1.5s)
  → transcript_send → LLM pipeline
```

**Key difference:** The user sees words appearing in real-time during speech. The stable/unstable split gives visual feedback about confidence. The final transcript still uses the full buffer for best accuracy.

**Latency improvement:** The perceived latency drops dramatically because the user sees their words as they speak. The actual pipeline latency is unchanged (finalize still runs), but the UX is transformed.

---

## Detailed Design

### 1. Wire RollingWindowSTT into handler.ts

**File:** `packages/gateway/src/ws/handler.ts`

Add a `RollingWindowSTT` instance to `ConnectionState`:

```typescript
interface ConnectionState {
  // ... existing fields ...
  rollingWindow: RollingWindowSTT;
}
```

Initialize it alongside the other per-connection instances in `registerWebSocket()`:

```typescript
const rollingWindow = new RollingWindowSTT(parakeetClient);
```

### 2. Modify handleAudioFrame()

Currently, `handleAudioFrame()` pushes audio to `conn.audioBuffer` and resets a silence timer. The change:

- **On transition to LISTENING:** Call `conn.rollingWindow.start()` to begin 500ms decode cycles.
- **On each audio frame:** Call `conn.rollingWindow.appendAudio(data)` in addition to (or instead of) pushing to `conn.audioBuffer`.
- **Wire `transcript_partial` events** from `RollingWindowSTT` to the WebSocket:

```typescript
conn.rollingWindow.on('transcript_partial', ({ stable, unstable, text }) => {
  sendMessage(conn, {
    type: 'transcript_partial',
    text,
    stable,
    unstable,
  });
});
```

### 3. Modify processAudioBuffer() to use finalize()

When the silence timeout fires, instead of concatenating `conn.audioBuffer` and calling `sttRouter.transcribe()`, call `conn.rollingWindow.finalize()`:

```typescript
async function processAudioBuffer(conn: ConnectionState, app: FastifyInstance) {
  if (!transitionState(conn, 'transcribing', app)) return;

  const turnId = conn.turnId ?? crypto.randomUUID();
  conn.turnId = turnId;

  try {
    const result = await conn.rollingWindow.finalize();
    const cleaned = cleanSttText(result.text ?? '');
    const noisy = isNoisySegment(cleaned);
    // ... rest of existing logic (combine with pendingTranscript, etc.)
  } catch (err) {
    // ... existing error handling
  }
}
```

This is a **minimal change** to the existing flow: finalize() does a full-buffer decode (same as current behavior) but also stops the periodic timer.

### 4. Keep the TRANSCRIBING state

The `TRANSCRIBING` state is still needed. The streaming partials happen during `LISTENING`. When silence is detected, the transition is:

```
LISTENING → TRANSCRIBING (finalize running) → PENDING_SEND
```

The `TRANSCRIBING` state represents the brief period where the final full-buffer decode is running. This is useful because:
- It prevents new audio from starting a second `finalize()` call
- The client can show a "finalizing..." indicator
- The existing re-entry logic (audio arriving mid-STT) still works

### 5. Silence timer interaction

The 1.5s silence timeout remains as-is. It serves a different purpose than streaming:
- **Streaming partials** show words as they are spoken (every 500ms during speech)
- **Silence timeout** detects when the user has stopped speaking

These are orthogonal. The silence timer fires, which calls `processAudioBuffer()`, which calls `finalize()`, which stops the periodic decode timer and does one final full-buffer decode.

**Possible optimization (future):** If the rolling window's stable prefix matches the finalize result, skip the finalize decode. But for v1, always finalize for accuracy.

### 6. RollingWindowSTT lifecycle management

- **start():** Called when entering LISTENING state
- **appendAudio():** Called on each binary frame during LISTENING
- **finalize():** Called when silence timeout fires (enters TRANSCRIBING)
- **reset():** Called on cancel, barge-in, or connection close

Add `rollingWindow.reset()` to the `cleanup()` function and to the cancel/barge-in handlers.

### 7. Audio buffer strategy

Currently `conn.audioBuffer` holds raw chunks and `conn.audioBufferBytes` tracks size. With `RollingWindowSTT`, the audio is managed internally by the rolling window. Two approaches:

**Option A (recommended): Dual buffering.** Keep `conn.audioBuffer` for the existing overflow guard and re-entry detection (`conn.audioBufferBytes > 0` check in processAudioBuffer). Also feed chunks to `rollingWindow.appendAudio()`. The rolling window manages its own internal buffer for windowed decodes.

**Option B: Single buffer.** Remove `conn.audioBuffer` and rely entirely on the rolling window. This simplifies code but loses the ability to detect "new audio arrived during STT" via `conn.audioBufferBytes > 0`.

Recommend Option A for v1 to minimize risk. The duplication is cheap (just pointer copies of the same Buffer objects).

### 8. Error handling in decode cycles

If a periodic decode fails (Parakeet timeout, etc.), `RollingWindowSTT` emits an `error` event. The handler should:
- Log the error but NOT transition state (we're still LISTENING)
- NOT increment the SttRouter's failure counter (partials failing is not critical)
- Continue collecting audio; the finalize() call will go through SttRouter with proper failover

Wire the error handler:
```typescript
conn.rollingWindow.on('error', (err) => {
  app.log.warn({ connId: conn.id, err }, 'Rolling window decode failed (non-fatal)');
});
```

### 9. RollingWindowSTT uses ParakeetClient directly, not SttRouter

This is intentional. The rolling window calls `parakeetClient.transcribe()` directly for periodic partials. The finalize call should go through `sttRouter.transcribe()` for proper failover handling.

**Change needed in RollingWindowSTT:** The `finalize()` method currently uses `this.sttClient.transcribe()` (ParakeetClient). Refactor to accept an optional `transcriber` parameter or extract finalize to use the SttRouter:

```typescript
// In handler.ts:
async function processAudioBuffer(conn: ConnectionState, app: FastifyInstance) {
  // Stop rolling window timer
  conn.rollingWindow.stopTimer();  // Need to expose this or add a stop() method

  // Get the full audio from rolling window
  const fullAudio = conn.rollingWindow.getFullAudio();  // Need to expose this

  // Transcribe through router for failover support
  const result = await conn.sttRouter.transcribe(fullAudio);
  // ...
}
```

Alternatively, add a `stop()` method to `RollingWindowSTT` that stops the timer without doing a final decode, and let the handler do the final transcription through the router.

**Recommended approach:** Add `stop(): Buffer` to RollingWindowSTT that stops the timer and returns the full concatenated audio (with WAV header). The handler then sends this through `sttRouter.transcribe()`.

### 10. Protocol — transcript_partial message

The `transcript_partial` message type already exists in `types.ts`:

```typescript
| {
    type: 'transcript_partial';
    text: string;
    stable: string;
    unstable: string;
  }
```

No protocol changes needed. The client already has this type defined.

---

## Client-Side Display

The client should render streaming partials with visual distinction between stable and unstable text:

- **Stable text:** Normal styling, committed words
- **Unstable text:** Dimmed/italic styling, may change on next partial

The client `turnStore.ts` should have fields for `partialStable` and `partialUnstable`. On each `transcript_partial` message, update these. When `transcript_final` arrives, clear the partials and show the final text in the pending_send input.

**Note:** Client changes are out of scope for this plan (owned by the client-refactor agent). This plan focuses on gateway-side integration.

---

## Cross-Review Notes (2026-02-07)

**Circuit breaker interaction (Plan 07):** The `RollingWindowSTT` calls `ParakeetClient.transcribe()` directly for periodic partial decodes, bypassing `SttRouter` and its circuit breaker. This is intentional:
- Partial decode failures are best-effort and should NOT trip the circuit breaker
- A failed partial doesn't mean Parakeet is down (could be transient, or the audio window was too short)
- Tripping the breaker from partials could disable STT for the final decode, which is the critical path
- The final transcription goes through `SttRouter.transcribe()` with proper circuit breaker protection

**Observability (Plan 08):** Streaming partial metrics (e.g., `stt_partial_decode_ms`, `stt_partial_error_total`) could be added via the optional `metrics` parameter on `RollingWindowSTT` in a future pass. These are independent of the circuit breaker metrics.

---

## Migration Strategy

### Phase 1: Wire up (this plan)
- Add RollingWindowSTT to ConnectionState
- Feed audio to it during LISTENING
- Emit transcript_partial messages
- Use stop() + sttRouter.transcribe() for finalize
- No behavior change for clients that ignore transcript_partial

### Phase 2: Optimize (future)
- Skip finalize if stable prefix is close to complete
- Reduce silence timeout based on stability (if last 3 decodes are identical, shorter timeout)
- Adaptive decode interval based on speech rate

### Backward Compatibility

Clients that don't handle `transcript_partial` messages are unaffected. The existing flow (silence → transcribing → transcript_final → pending_send) is preserved. Streaming partials are purely additive.

---

## Testing Strategy

### Unit Tests — RollingWindowSTT (existing + new)

The existing `rolling-window.test.ts` covers:
- Stable prefix tracking (7 tests)
- Integration: finalize, reset, appendAudio, decodeCycle, buildWav

New tests needed:
1. **stop() returns full audio buffer as WAV** — verify the returned buffer has correct WAV header and all accumulated PCM data
2. **Concurrent decode guard** — verify `inFlight` flag prevents overlapping decodes
3. **Error in decode cycle emits error event, does not stop timer** — verify the timer continues after a failed decode

### Integration Tests — handler.ts

Mock `ParakeetClient.transcribe()` to return progressive results:
1. **Streaming partials flow** — send audio frames, verify `transcript_partial` messages are emitted with stable/unstable split
2. **Silence timeout triggers finalize** — verify the silence timer still fires and produces `transcript_final`
3. **Cancel during streaming** — verify `rollingWindow.reset()` is called on cancel/barge-in
4. **Re-entry during transcribing** — verify audio arriving during finalize() goes to the audioBuffer and loops back to LISTENING

### Test Pattern

Follow existing pattern from `rolling-window.test.ts`:
- Use `(stt as any).processDecodeResult()` for direct stable-prefix testing
- Use `(stt as any).decodeCycle()` for direct decode cycle testing (avoids fake timer issues)
- Mock `ParakeetClient` with `vi.fn()`

---

## Risks and Mitigations

### Risk 1: Parakeet doesn't handle frequent requests well
Parakeet is a local MLX model. Sending transcribe requests every 500ms with overlapping audio windows could overload it.

**Mitigation:** The `inFlight` flag in `RollingWindowSTT.decodeCycle()` already guards against this — if a previous decode is still running, the next cycle is skipped. If Parakeet consistently takes >500ms, decode cycles will naturally throttle to ~1/s.

### Risk 2: WAV header overhead
Each decode cycle builds a WAV header for the windowed audio. This is 44 bytes — negligible.

### Risk 3: Memory from dual buffering
Both `conn.audioBuffer` and `RollingWindowSTT.audioBuffer` hold references to the same Buffer chunks. The actual audio data is not duplicated (Buffer objects are reference-counted). Memory impact is minimal (array of pointers).

### Risk 4: Partial transcripts confuse the client
If the client doesn't handle `transcript_partial`, it will simply ignore them. The final transcript is authoritative. No risk of data corruption.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/gateway/src/stt/rolling-window.ts` | Add `stop(): Buffer` method that stops timer and returns full audio as WAV |
| `packages/gateway/src/ws/handler.ts` | Add `rollingWindow` to ConnectionState; wire up in handleAudioFrame, processAudioBuffer, cleanup, cancel/barge-in |
| `packages/gateway/src/stt/__tests__/rolling-window.test.ts` | Add tests for stop(), error handling during decode |
| `packages/gateway/src/ws/__tests__/handler-pipeline.test.ts` | Add integration tests for streaming partial flow |

---

## Estimated Complexity

- **RollingWindowSTT changes:** Small — add one public method (`stop`)
- **handler.ts changes:** Medium — wire up lifecycle, modify processAudioBuffer, update cleanup paths
- **Tests:** Medium — add ~5-8 new test cases
- **Protocol:** None — `transcript_partial` already defined
