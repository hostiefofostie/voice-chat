# Test Suite Critical Review

**Date:** 2026-02-06
**Reviewer:** Clawd (automated review)
**State:** 84 tests across 4 files, all passing

## Executive Summary

The test suite has **decent coverage of pure utility logic** (PhraseChunker, TurnMachine, RollingWindowSTT) but **critically lacks coverage of the pipeline code that actually runs in production** — the WebSocket handler, LLM pipeline, TTS pipeline, and their interactions. The integration test exists but only covers the simplest happy paths (ping, commands, config). The most bug-prone code (async pipeline orchestration, cancellation, error recovery) is essentially untested.

---

## 1. Tests Designed to Pass

### 1a. Overly Loose Assertions

**`turn-machine.test.ts` — turnId management**
```ts
it('generates new turnId for each listening cycle', () => {
  machine.transition('listening');
  const id1 = machine.currentTurnId;
  machine.transition('transcribing');
  machine.transition('pending_send');
  machine.transition('idle');
  machine.transition('listening');
  const id2 = machine.currentTurnId;
  expect(id2).toBeTruthy(); // ← This would pass even if id2 === id1
});
```
The test has a COMMENT acknowledging the bug ("turnId from first cycle may persist since idle doesn't clear it") but then uses `toBeTruthy()` instead of asserting the turnId is actually different. This is a test designed to work around a known bug rather than catch it.

**`rolling-window.test.ts` — appendAudio**
```ts
it('appendAudio accumulates buffer', () => {
  stt.appendAudio(Buffer.alloc(100));
  stt.appendAudio(Buffer.alloc(200));
  expect((stt as any).audioBytes).toBe(300);
});
```
Tests private field via `as any` — brittle and tests implementation detail. If the field name changes, test breaks even if behavior is fine.

### 1b. Tests That Test Mocks, Not Code

**`integration.test.ts` — config update test**
```ts
it('accepts config update without error', async () => {
  sendJson(ws, { type: 'config', settings: { ttsProvider: 'openai' } });
  const pingTs = Date.now();
  sendJson(ws, { type: 'ping', ts: pingTs });
  const msg = await nextJsonMessage(ws);
  expect(msg.type).toBe('pong');
});
```
This doesn't verify the config was actually applied. It just verifies the server didn't crash. The test would pass if the config handler was `case 'config': break;` (literally doing nothing).

**`integration.test.ts` — binary audio frame**
```ts
it('buffers binary audio frame without error', async () => {
  // ... sends audio, checks for turn_state: 'listening'
  const pingTs = Date.now();
  sendJson(ws, { type: 'ping', ts: pingTs });
  const pong = await nextJsonMessage(ws);
  expect(pong.type).toBe('pong');
});
```
The "buffer without error" test doesn't verify anything was actually buffered. The ping/pong afterward is meaningless — it just proves the connection is alive.

---

## 2. Missing Test Coverage (Critical Gaps)

### 2a. WebSocket Handler (`ws/handler.ts`) — THE MOST COMPLEX FILE

The handler is **~300 lines of async pipeline orchestration** and is tested only through 6 integration tests that cover:
- Ping/pong ✓
- `/help` command ✓
- Config update (barely) ✓
- Binary audio → listening state ✓
- Turn state broadcast ✓
- Invalid JSON error ✓

**Not tested at all:**
- `processAudioBuffer()` — The STT transcription flow
- `runLlmTtsPipeline()` — The entire LLM→TTS flow (THE CORE FEATURE)
- `handleAudioFrame()` — Audio buffer overflow protection
- Silence timeout triggering auto-transcription
- `barge_in` message handling
- `cancel` message handling
- `transcript_send` message handling
- Rate limiting (message rate limiter, LLM rate limiter)
- Connection cleanup on disconnect
- Keepalive mechanism
- Audio discarding in non-listening states
- Error paths in processAudioBuffer (STT failure)
- Error paths in runLlmTtsPipeline (LLM failure, TTS failure)
- The force-state logic in `runLlmTtsPipeline` for text-input sends

### 2b. LLM Pipeline (`llm/pipeline.ts`)

**Zero dedicated tests.** This file:
- Streams tokens from Gateway
- Feeds tokens into PhraseChunker for TTS pipelining
- Handles cancellation via AbortController
- Emits events that drive the entire TTS pipeline

**Not tested:**
- Token streaming and accumulation
- Phrase chunking integration during streaming
- Cancel behavior (does abort actually stop the stream?)
- Error event emission
- The `previousBufferLength` delta extraction logic
- AbortController is created but **never passed to `gateway.sendChat()`** — cancel is broken!

### 2c. TTS Pipeline (`tts/pipeline.ts`)

**Zero dedicated tests.** This file:
- Manages parallel TTS synthesis with ordered delivery
- Has a `drainAll()` that polls with `setTimeout(check, 50)` — potential for infinite hang
- Handles cancellation mid-pipeline

**Not tested:**
- Chunk ordering (index 2 completes before index 1 — does it wait?)
- Parallel synthesis limiting (`maxParallel`)
- Cancel during synthesis
- Reset between turns
- `drainAll()` behavior (could hang if inFlight count gets out of sync)
- Error propagation from synthesis failures
- `finish()` calculating totalChunks incorrectly (see bugs section)

### 2d. TTS Router (`tts/router.ts`)

**Zero dedicated tests.**

**Not tested:**
- Fallback after 3 failures
- Provider switching
- Failure window sliding (old failures aging out)
- `failures` array cleared on success (not just on switch)
- Health check always returning `true` for OpenAI

### 2e. STT Router (`stt/router.ts`)

**Zero dedicated tests.**

**Not tested:**
- Fallback to cloud stub after 3 failures
- Auto-recovery via health check interval
- `destroy()` cleanup
- Cloud fallback returning placeholder text

### 2f. Commands (`ws/commands.ts`)

**Tested only via integration test (`/help`).** Not tested:
- `/model`, `/agent`, `/voice`, `/tts`, `/stt` with valid args
- Any command with missing args (error paths)
- `/tts` with invalid provider
- Unknown command handling

### 2g. Rate Limiter (`ws/rate-limiter.ts`)

**Zero dedicated tests.**

### 2h. Client-Side Code

No tests at all for:
- Zustand stores (`turnStore`, `configStore`, `chatStore`)
- WebSocket hook (`useWebSocket`)
- Audio capture/playback hooks
- Error recovery hook
- React components

---

## 3. Test Quality Issues

### 3a. Integration Test Doesn't Test Integration

The "integration test" only tests individual message types in isolation. It never tests the actual voice chat flow: audio → STT → LLM → TTS → audio playback. This is the **entire point of the app** and it's untested.

### 3b. Private Field Access

`rolling-window.test.ts` accesses private fields 6 times via `(stt as any)`:
- `processDecodeResult` — testing a private method directly
- `decodeCycle` — testing a private method directly
- `buildWav` — testing a private method directly
- `audioBytes` — asserting on a private field

This makes tests fragile and couples them to implementation details.

### 3c. No Mocking of External Services

The integration test creates real `ParakeetClient`, `KokoroClient`, `OpenAiTtsClient`, and `GatewayClient` instances. The tests only work because:
1. They never trigger STT/LLM/TTS (except the audio test, which triggers a silence timeout that would try to call Parakeet — but the test ends before it fires)
2. The silence timer fires AFTER test cleanup, potentially causing unhandled errors

### 3d. Cleanup Race Condition

In `integration.test.ts`, the binary audio test sends audio which starts a 1500ms silence timer. The `afterEach` closes the WebSocket and server, but the silence timer may still fire and try to call `processAudioBuffer` → `sttRouter.transcribe()` on a closed connection. This is a flaky test waiting to happen.

---

## 4. Best Practices Violations

### 4a. Module-Level Singleton State in Tests

`silenceTimers` in `handler.ts` is a module-level `Map`. Tests that create multiple connections or run in parallel could leak timers between tests. The integration test doesn't clear these.

### 4b. No Test Isolation for EventEmitter Listeners

`TurnMachine` extends `EventEmitter` but tests never call `removeAllListeners()`. Listeners from one test could theoretically fire in another.

### 4c. Inconsistent Timer Handling

`turn-machine.test.ts` uses `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach` — correct.
`rolling-window.test.ts` only uses fake timers in specific tests that need them — also fine, but the `decodeCycle skips when no audio` test uses fake timers with `await vi.advanceTimersByTimeAsync()` which can be fragile.

---

## 5. Recommendations (Priority Order)

1. **Add handler pipeline tests** with mocked STT/LLM/TTS clients — test the full audio→STT→LLM→TTS→binary flow
2. **Add TTS pipeline unit tests** — especially chunk ordering and cancellation
3. **Add LLM pipeline unit tests** — especially the AbortController bug (it's created but never used!)
4. **Add rate limiter unit tests** — simple but important for DoS protection
5. **Fix the turnId non-regeneration bug** that the test comments acknowledge
6. **Add TTS/STT router fallback tests** — the fallback logic is complex enough to warrant testing
7. **Add command unit tests** — low complexity but untested error paths
8. **Clean up private field access** in rolling-window tests — test through public API
9. **Add connection cleanup test** — verify silence timers, intervals are cleared on disconnect
10. **Fix silence timer leak** in integration test — ensure timers don't outlive test lifecycle
