# Voice Chat Improvement Audit — 2026-02-07

## 1. `app/index.tsx` is a god component (the worst offender)

517 lines handling WS messages, audio capture, audio playback, turn state, chat state, auto-send countdown, text input, barge-in logic, config sync, error recovery — all in one component. Every state change re-renders everything. The callback dependency arrays are wrong in several places (e.g., `handleMicToggle` depends on `[capture]` which is a new object every render). Auto-send countdown has race conditions with text editing. `pendingTtsMetaRef` (set in `onMessage`, read in `onBinary`) can race and drop metadata.

**Fresh idea:** Extract a `TurnController` class that owns the entire turn lifecycle — it receives WS messages, drives state transitions, coordinates audio capture/playback, and exposes a simple reactive interface. The React layer becomes a thin view. This also makes the core logic testable without React.

## 2. Two state machines, neither authoritative

`turn-machine.ts` exists with proper `VALID_TRANSITIONS` enforcement — but `handler.ts` **never imports it**. Instead, handler.ts does direct `conn.turnState = 'thinking'` assignments that bypass validation entirely. There are at least 3 places where state is force-set without going through any transition logic. The client has a third copy in `turnStore.ts`. None of them agree on what transitions are valid.

**Fresh idea:** One state machine definition (a simple map of `state -> event -> nextState`) shared as a pure function between gateway and client via a shared package. Both sides run the same logic. The server's transitions are canonical; the client runs them optimistically and reconciles. Kill the duplicate implementations.

## 3. handler.ts is a 742-line monolith

`processAudioBuffer` alone has nested audio transcription, noise filtering, partial transcript accumulation, silence timer management, and re-entry logic for audio arriving mid-transcription. `runLlmTtsPipeline` creates 5 event listeners, detaches them in a `finally` block, and uses a captured `currentTurnId` as a stale-turn guard — a band-aid for the lack of a coherent turn lifecycle object. There's a concurrency bug: two `transcript_send` messages arriving quickly can run two LLM pipelines in parallel, corrupting state.

**Fresh idea:** Model each turn as a self-contained `Turn` object with its own lifecycle: `Turn.listen() -> Turn.transcribe() -> Turn.think() -> Turn.speak() -> Turn.end()`. Each turn owns its audio buffer, STT result, LLM stream, and TTS pipeline. Handler.ts becomes a thin dispatcher that creates turns and cancels the previous one on barge-in. Concurrent sends become impossible because there's only ever one active Turn.

## 4. No streaming STT integration

`rolling-window.ts` (160 lines) implements streaming STT with decode cycles and stability detection — but it's **never used**. Handler.ts buffers all audio, waits for silence, then does a single `transcribe()` call. The user sees nothing until speech ends + STT completes. This adds 1.5s+ of silence timeout plus full-buffer transcription time to every turn. The spec explicitly calls for streaming partials.

**Fresh idea:** This is the single biggest latency win available. Feed audio to Parakeet every ~500ms during speech, send `transcript_partial` messages to the client as words are recognized, and start the auto-send countdown from the moment the final transcript stabilizes — not from when silence is detected. This would make the app feel dramatically more responsive and is what every commercial assistant does.

## 5. TTS pipeline polling and no error recovery

`TtsPipeline.drainAll()` polls every 50ms in a loop with a 30-second timeout — CPU waste that should be event-driven. If a TTS chunk synthesis fails, the chunk is silently dropped (no retry, no fallback to the other provider for just that chunk), and no state transition happens — the connection can get stuck in `speaking` with no audio playing.

**Fresh idea:** Make the TTS pipeline a proper async generator. Each chunk yields when ready. If synthesis fails, retry once with the fallback provider before dropping. Use `Promise.race` with chunk-level timeouts instead of a global polling drain.

## 6. Token streaming causes re-render storms

Every `llm_token` message (potentially 100/sec) calls `reportLlmToken()` which updates a Zustand store, which triggers re-renders on every subscriber. `ChatHistory` re-scrolls on every `llmText` change. There's no virtualization — rendering 500+ messages uses a plain `ScrollView`.

**Fresh idea:** Batch token updates with `requestAnimationFrame` — accumulate tokens for one frame, then flush once. Use a `FlashList` or virtualized list for chat history. Only the streaming message bubble should re-render on token updates, not the entire chat.

## 7. Provider failover is one-directional

STT failover: after 3 Parakeet failures, switches to a stub that returns `[STT unavailable]`. That's it — the "cloud fallback" is literally a hardcoded string. TTS failover: after 3 failures in 60s, switches providers, but the health check for OpenAI is `Promise.resolve(true)` — it never actually checks. No exponential backoff. No per-chunk retry.

**Fresh idea:** Circuit breaker pattern with three states (closed/open/half-open) per provider. Half-open sends one real request every N seconds to probe recovery. Per-request fallback: if Kokoro fails on a specific chunk, try OpenAI for *that chunk*, don't switch globally. Actually implement the cloud STT fallback (Deepgram is called out in the spec but never built).

## 8. No observability

Zero metrics, zero tracing. No way to know: turn-to-first-audio latency, STT processing time, LLM time-to-first-token, TTS synthesis duration, failover frequency, error rates, active connections. Operators are blind. This makes every other problem harder to diagnose and fix.

---

## Priority Ranking (Highest ROI)

1. **Streaming STT** (#4) — biggest user-facing latency improvement
2. **Turn-as-object refactor** (#3) — eliminates the concurrency bugs and makes handler.ts maintainable
3. **Shared state machine** (#2) — eliminates an entire class of state corruption bugs with minimal code
4. **God component refactor** (#1) — makes client maintainable and testable
5. **TTS pipeline** (#5) — fixes stuck connections and CPU waste
6. **Re-render optimization** (#6) — fixes performance degradation in long conversations
7. **Provider failover** (#7) — improves reliability
8. **Observability** (#8) — enables diagnosing all the above
