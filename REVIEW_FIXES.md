# Code Review Fixes

Comprehensive bug-fix pass across all 41 source files. All fixes verified: TypeScript compiles clean, 84/84 tests pass.

## Critical Fixes

### 1. Wired up STT/LLM/TTS pipelines in WebSocket handler (SHOWSTOPPER)
**File:** `packages/gateway/src/ws/handler.ts`

The handler received audio frames and `transcript_send` messages but never processed them. All pipeline components (`ParakeetClient`, `SttRouter`, `GatewayClient`, `LlmPipeline`, `TtsPipeline`, etc.) existed but weren't instantiated or connected. Both voice and text-input flows were dead ends.

**Fix:** Fully wired up the handler:
- Per-connection instances of `SttRouter`, `LlmPipeline`, `TtsPipeline`
- Singleton `GatewayClient` shared across connections
- Audio silence timeout (1.5s) auto-triggers STT after VAD ends
- `transcript_send` now invokes LLM pipeline with streaming tokens and sentence-level TTS pipelining
- `barge_in` and `cancel` now properly cancel in-flight LLM and TTS pipelines
- Clean resource teardown on disconnect

### 2. Fixed state machine: text-input send silently failed (SHOWSTOPPER)
**File:** `packages/client/app/index.tsx`

`handleTextSend` and `handleSendTranscript` called `transition('thinking')` from `idle` state, but `VALID_TRANSITIONS['idle']` only allows `['listening']`. The transition silently returned `false`, so the UI stayed in `idle` with no "Thinking..." indicator.

**Fix:** Changed to use `reconcile()` instead of `transition()` for sends. `reconcile` bypasses validation (appropriate since the server is authoritative and will send its own `turn_state`). Also fixed `handleRetryLlm` which had the same bug.

### 3. Fixed `llm_done` resetting turn state prematurely (CRITICAL)
**File:** `packages/client/app/index.tsx`

The `llm_done` handler called `resetTurn()` which set state to `idle`. But after `llm_done`, the server transitions to `speaking` for TTS playback. The client's premature reset to `idle` meant TTS audio would arrive while the client was in `idle` state.

**Fix:** Removed `resetTurn()` from `llm_done` handler. The server drives state transitions via `turn_state` messages.

### 4. Fixed text-input LLM pipeline: server state machine dead end
**File:** `packages/gateway/src/ws/handler.ts`

`runLlmTtsPipeline` called `transitionState(conn, 'thinking')`, but for text-input sends the server is in `idle` (not `pending_send`). `idle -> thinking` is not a valid transition, so the pipeline would silently abort.

**Fix:** Added special handling: if the server is in `idle`, `listening`, or `transcribing` when `transcript_send` arrives, force-set state to `thinking` (bypassing the state machine validation, since these are legitimate text-input flows).

## Important Fixes

### 5. Fixed barge-in from non-speaking states
**File:** `packages/client/app/index.tsx`

`onSpeechStart` called `transition('listening')` unconditionally. This failed silently from states like `thinking` or `pending_send` (where VAD could trigger from background noise).

**Fix:** Added state-aware handling: `idle` uses normal `transition`, `speaking` does barge-in with `reconcile`, other states cancel and restart via `reconcile`.

### 6. Fixed audio buffer not cleared on new turn
**File:** `packages/gateway/src/ws/handler.ts`

When audio arrived in `idle` state (starting a new turn), leftover audio from a previous aborted turn could still be in the buffer.

**Fix:** Added `cleanup(conn)` call before starting the new turn.

### 7. Fixed Zustand mutation bug in `updateLastAssistant`
**File:** `packages/client/stores/chatStore.ts`

`updateLastAssistant` did `const msgs = [...state.messages]` (shallow array copy) then `last.text = text` which mutated the original message object. Components subscribing to individual messages might not re-render.

**Fix:** Used immutable update with `map()` to create a new object for the updated message.

### 8. Fixed unhandled server start error
**File:** `packages/gateway/src/server.ts`

`start()` returned a promise that was never caught. If the port was in use, the error would be silently swallowed.

**Fix:** Added `.catch()` handler that logs the error and exits with code 1.

### 9. Fixed fire-and-forget `dispatch()` in TTS pipeline
**File:** `packages/gateway/src/tts/pipeline.ts`

`dispatch()` inside `synthesizeAndQueue` was called without `await`, so errors from subsequent synthesis jobs were uncaught.

**Fix:** Added `await` to the `dispatch()` call.

## Documentation Fix

### 10. Added missing env vars to `.env.example`
**File:** `.env.example`

`PORT`, `LOG_LEVEL`, `NODE_ENV`, and `EXPO_PUBLIC_GATEWAY_URL` were referenced in code but not documented in the env example file.

## What Was Already Correct
- Client and server types are an exact copy (verified line-by-line)
- WebSocket message types match perfectly between client and server
- Turn state machine transitions match between client and server
- Slash commands on client match server command handler
- WAV encoding in `audio-utils.ts` and `rolling-window.ts` are both correct
- React hooks have proper dependency arrays and cleanup functions
- Rate limiter implementation is sound
- Phrase chunker handles edge cases well (abbreviations, URLs, code blocks)
- Reconnection with exponential backoff is properly implemented
- Error recovery system (tiered STT/TTS/LLM error handling) is well designed

## Test Results
- **Before fixes:** 84/84 passing
- **After fixes:** 84/84 passing
- Gateway builds clean with `tsc`
- Client typechecks clean with `tsc --noEmit`

---

## Round 3 Addendum (2026-02-06)

### 11. Fixed constructor mocking in handler pipeline tests (TEST SHOWSTOPPER)
**File:** `packages/gateway/src/ws/__tests__/handler-pipeline.test.ts`

Vitest v4 rejected constructor mocks written as arrow functions (`vi.fn().mockImplementation(() => ({...}))`) with `is not a constructor`, which caused all handler pipeline tests to fail and WebSocket connections to close with code 1006.

**Fix:** Rewrote mocked class constructors (`GatewayClient`, `ParakeetClient`, `KokoroClient`, `OpenAiTtsClient`) to use function-style constructor implementations (`function (this: any) { ... }`) compatible with `new`.

### 12. Fixed stale-turn race in WebSocket LLM/TTS orchestration (RACE CONDITION)
**File:** `packages/gateway/src/ws/handler.ts`

`onLlmDone`/`onLlmError` could finish asynchronously after a newer turn started and incorrectly force the connection back to `idle`, clobbering the newer turn state.

**Fix:** Added turn-scoped stale-callback guards using captured `currentTurnId`; async callbacks now no-op when a newer turn has replaced the active one.

### 13. Fixed STT fallback semantics to avoid placeholder transcript leakage
**Files:**
- `packages/gateway/src/stt/router.ts`
- `packages/gateway/src/stt/__tests__/stt-router.test.ts`

Before: any primary STT failure immediately returned cloud placeholder text (`[STT unavailable - local provider offline]`) even below threshold, which could be forwarded into LLM as user text.

**Fix:**
- Below failure threshold: rethrow STT error so caller can surface recoverable error.
- At threshold: switch to fallback and return fallback result.
- Updated tests for new threshold behavior and recovery path.

### 14. Fixed reconnect/close race handling in GatewayClient + test stability
**Files:**
- `packages/gateway/src/llm/gateway-client.ts`
- `packages/gateway/src/llm/__tests__/gateway-client.integration.test.ts`

There was an intermittent unhandled rejection (`Gateway connection closed`) during integration tests due to asynchronous close/reconnect events after test teardown.

**Fix:**
- `ensureConnected()` now rejects early when client is closed (`shouldReconnect === false`).
- Close/error handlers ignore stale socket events unless they belong to the active socket.
- Integration test teardown now waits for async close handlers and suppresses known post-teardown close rejections.

### 15. Fixed TypeScript test compile errors in async resolver callbacks
**Files:**
- `packages/gateway/src/ws/__tests__/handler-pipeline.test.ts`
- `packages/gateway/src/tts/__tests__/tts-pipeline-advanced.test.ts`
- `packages/gateway/src/tts/__tests__/tts-pipeline-generation.test.ts`

TypeScript control-flow narrowing treated closure-assigned resolver variables as `never` at call sites.

**Fix:** Added explicit callable union assertions at resolver invocation points.

## Round 3 Verification
- `cd packages/gateway && npx vitest run --reporter=verbose` → **213/213 passing**
- `cd packages/gateway && npx tsc --noEmit` → clean

---

## Round 4 — Client Review + Final Gateway Pass (2026-02-06)

First comprehensive review of `packages/client/`. Also final pass on gateway code.

### 16. Fixed premature playback-end in audio playback hook (CLIENT BUG)
**File:** `packages/client/hooks/useAudioPlayback.ts`

`playNext()` declared playback complete (`onPlaybackEnd()`) whenever the queue was empty and no chunk was processing. But more TTS chunks could still be in flight from the server — the queue drains faster than the server can send. This caused `onPlaybackEnd` → `transition('idle')` to fire mid-response, cutting off TTS audio.

**Fix:** Added `ttsDoneRef` flag. `playNext()` now only fires `onPlaybackEnd` when both the queue is empty AND `markDone()` has been called. The `tts_done` server message triggers `markDone()`. Added `markDone()` to the hook's return API.

### 17. Fixed tts_done message not wired to playback hook (CLIENT BUG)
**File:** `packages/client/app/index.tsx`

The `tts_done` handler was a no-op comment ("Playback handles its own completion via queue drain"). But playback cannot know when the server is done sending chunks without this signal.

**Fix:** `tts_done` handler now calls `playbackRef.current.markDone()`.

### 18. Fixed duplicate streaming message in ChatHistory (CLIENT BUG)
**File:** `packages/client/app/index.tsx`

When `llm_done` fires, `addMessage()` adds the assistant message to the persistent `messages` array. But `turnStore.llmText` still contains the full response text, and `ChatHistory` renders a streaming bubble whenever `(turnState === 'thinking' || turnState === 'speaking') && llmText.length > 0`. During the `speaking` phase (between `llm_done` and `turn_state: idle`), both the persistent message and the streaming bubble were visible — a duplicate.

**Fix:** Clear `llmText` on `llm_done` via `useTurnStore.getState().appendLlmToken('', '')`.

### 19. Fixed stale binary audio queue on reconnect (CLIENT BUG)
**File:** `packages/client/hooks/useWebSocket.ts`

`sendBinary()` queued `ArrayBuffer` data in `sendQueueRef` when the WebSocket was disconnected. On reconnect, `flushQueue()` sent all buffered audio to the server. Stale audio from a previous turn would confuse the server's turn state machine (starting a new "listening" phase from audio recorded minutes ago).

**Fix:** `sendBinary()` now drops data when disconnected instead of queuing. Binary audio is ephemeral — queueing it serves no purpose since the turn context is lost on disconnect.

### 20. Fixed double getUserMedia call on mic toggle (CLIENT BUG)
**Files:** `packages/client/app/index.tsx`, `packages/client/hooks/useAudioCapture.ts`

`handleMicToggle` called `navigator.mediaDevices.getUserMedia()` to test permission, stopped the tracks, then called `capture.start()` which called `getUserMedia()` again. This caused a brief "mic flash" on some devices and wasted the user's time on the permission prompt.

**Fix:** `useAudioCapture.start()` now re-throws the permission error instead of swallowing it. `handleMicToggle` calls `capture.start()` directly and catches to report mic denial to the error store.

### 21. Fixed config changes not sent to server (CLIENT BUG)
**File:** `packages/client/app/index.tsx`

The settings page updates `configStore` (Zustand), but nothing sent the updated config to the server via WebSocket. The server always used `DEFAULT_CONFIG` for every connection, ignoring user preferences for TTS voice, STT provider, VAD sensitivity, etc.

**Fix:** Added `useConfigStore.subscribe()` effect that sends a `config` message to the server whenever the config store changes. Also sends the full config on WebSocket connect/reconnect so the server starts with the right settings.

### 22. Fixed LLM cancel flushing remaining phrases to TTS (GATEWAY BUG)
**File:** `packages/gateway/src/llm/pipeline.ts`

`cancel()` called `this.phraseChunker.feed('', true)` which flushed remaining buffered text as `phrase_ready` events. These events are processed synchronously by the handler, which calls `ttsPipeline.processChunk()` → `dispatch()` → starts new TTS synthesis. This happens *before* the handler calls `ttsPipeline.cancel()`, creating a race where cancelled turns could still trigger TTS synthesis work.

**Fix:** `cancel()` now calls `this.phraseChunker.reset()` instead of flushing. When cancelling, there's no point synthesizing remaining text — the user asked to stop.

## Round 4 Verification
- `cd packages/gateway && npx vitest run --reporter=verbose` → **213/213 passing**
- `cd packages/gateway && npx tsc --noEmit` → clean
- `cd packages/client && npx tsc --noEmit` → clean

## What Was Reviewed and Found Correct (Client)
- WebSocket reconnection with exponential backoff (correct delays, proper cleanup)
- Turn state machine transitions match server-side `VALID_TRANSITIONS` exactly
- Zustand stores use immutable updates (chatStore `updateLastAssistant` fixed in R1, rest correct)
- React hooks have proper dependency arrays and cleanup functions
- Audio WAV encoding (`float32ToWav`) produces correct 16-bit PCM headers
- VAD integration (`@ricky0123/vad-web`) properly handles async init/destroy lifecycle
- AudioContext lazy creation respects browser autoplay policy
- Barge-in flow correctly stops playback, sends `barge_in` to server, reconciles state
- Error recovery system properly tracks STT/TTS/LLM errors with thresholds
- LLM timeout tracker uses tiered approach (15s warning, 30s with retry option)
- TranscriptBox auto-send countdown resets on user edit (correct)
- Settings page properly renders web-only controls with native fallback text
- Expo Router layout and navigation structure correct
- `KeyboardAvoidingView` uses correct platform-specific behavior
