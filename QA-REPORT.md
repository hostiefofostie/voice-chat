# Voice Chat — QA Bug Report

**Date:** 2026-02-07  
**Reviewer:** Automated Code Review (2-round audit)  
**Scope:** bridge.html, packages/gateway/, packages/client/

---

## Round 1 — Code Review

### 🔴 CRITICAL

#### BUG-001: TTS voice parameter ignored — Kokoro always gets default, OpenAI never gets `instructions`

**File:** `packages/gateway/src/tts/router.ts` lines 38–47  
**File:** `packages/gateway/src/tts/openai-client.ts` lines 14–15

The `TtsRouter.synthesize()` passes `voice` to the client's `synthesize()`, but the `OpenAiTtsClient.synthesize()` accepts an optional `options?: OpenAiTtsOptions` parameter containing `instructions` — and **nothing in the pipeline ever passes instructions through**.

The `SessionConfig` has `ttsVoice` but the handler in `handler.ts` never reads `conn.config.ttsVoice` or `conn.config.ttsProvider` when invoking the TTS pipeline. The `TtsPipeline.processChunk()` calls `this.ttsRouter.synthesize(text)` with **no voice argument** (line 68 of `tts/pipeline.ts`), so every request uses the hardcoded defaults (`af_heart` for Kokoro, `cedar` for OpenAI).

Meanwhile, the bridge.html client sends `config.voice` and `config.instructions` to `/api/tts` but the gateway WebSocket pipeline **never receives or forwards these** — the config object's `ttsVoice` field sits unused.

**Impact:** Voice and speaking-style customization doesn't work through the WebSocket gateway at all. Users changing voices in the config dialog see no effect.

**Fix:** Pass `conn.config.ttsVoice` through the pipeline. Add an `instructions` field to the TTS pipeline options or SessionConfig, and thread it through `TtsPipeline → TtsRouter → OpenAiTtsClient`.

---

#### BUG-002: `GatewayClient` singleton shared across all WebSocket connections — cross-session event routing

**File:** `packages/gateway/src/ws/handler.ts` lines 62–68  
**File:** `packages/gateway/src/llm/gateway-client.ts` lines 346–350 (`pendingSessions`)

`getGatewayClient()` returns a process-wide singleton. This client tracks pending chat runs by `sessionKey` in `this.pendingSessions` (a plain `Map`). If two users connect with the same session key (e.g. `"main"`), or if a second request fires before the first completes, `pendingSessions.set(sessionKey, pending)` **overwrites the first pending run**. The first request will never resolve (no timeout cleanup either — the timeout handle is orphaned).

Even with different session keys, all streaming events route through the same `handleChatEvent` method. A race between `sendChat` calls could associate a runId to the wrong pending request if the gateway emits the chat event before the `chat.send` response returns the runId.

**Impact:** Multi-user scenarios or rapid successive requests on the same session key can cause responses to route to the wrong connection, hang forever, or leak memory.

**Fix:** Use per-connection `GatewayClient` instances (at the cost of more WebSocket connections to the gateway), or add a correlation ID / nonce to disambiguate pending runs beyond just `sessionKey`.

---

### 🟠 HIGH

#### BUG-003: `bridge.html` — VAD instance never destroyed, only paused — MediaStream leaks

**File:** `bridge.html` line ~365 (`stop` function)

```js
const stop = () => {
  running = false;
  if (vadInstance) { vadInstance.pause(); vadInstance = null; }
  ...
```

`vad.MicVAD` is paused and dereferenced, but **never destroyed**. The `MicVAD` library holds references to a `MediaStream`, `AudioContext`, `ScriptProcessorNode`, and ONNX runtime. Setting it to `null` without calling `.destroy()` (if the API provides one) or manually stopping the media tracks means:

- The microphone indicator stays lit in the browser tab
- The AudioContext and ONNX session continue to consume memory
- Repeated start/stop cycles accumulate leaked resources

**Impact:** Memory leak and persistent microphone access after stopping.

**Fix:** Call `vadInstance.destroy()` if available, or at minimum stop all `MediaStream` tracks:
```js
if (vadInstance) {
  vadInstance.pause();
  if (vadInstance.stream) vadInstance.stream.getTracks().forEach(t => t.stop());
  vadInstance = null;
}
```

---

#### BUG-004: `bridge.html` — AudioContext never closed

**File:** `bridge.html` — `audioCtx` is created in `ensureAudioContext` but never closed

The `AudioContext` created via `ensureAudioContext()` is stored globally and **never closed** — not on stop, not on page unload. Each `AudioContext` reserves a render thread and system audio resources.

While browsers typically GC these on navigation, in a long-running SPA or PWA this is a resource leak.

**Impact:** Audio system resource leak in long-running sessions.

**Fix:** Close the `AudioContext` in the `stop()` function and null it out.

---

#### BUG-005: Race condition in `processNextAudio` — concurrent execution possible

**File:** `bridge.html` lines ~309–321

```js
const processNextAudio = async () => {
  if (busy || audioQueue.length === 0) return;
  busy = true;
  ...
  await processAudio(merged);
  busy = false;
  ...
  if (audioQueue.length > 0) processNextAudio();
```

The `busy` flag is checked and set non-atomically. While JavaScript is single-threaded, the `vadDebounceTimer` callback and the `sendBtn` click handler can both call `processNextAudio()`. If the timer fires while `processAudio` is awaiting (between `busy = true` and `busy = false`), the check `if (busy)` correctly guards. However, the recursive call at the end `if (audioQueue.length > 0) processNextAudio()` runs synchronously before the trailing `tryPlayTts()`, which means `tryPlayTts` is called even if the next processNextAudio started a new async chain — creating parallel `speak()` calls.

More critically: the Send button handler calls `processNextAudio()` directly without clearing the debounce timer first when `textInput.value.trim()` is empty:

```js
if (textInput.value.trim()) {
  await sendText(textInput.value);
} else if (audioQueue.length > 0 && !busy) {
  clearTimeout(vadDebounceTimer);
  processNextAudio();
}
```

This is fine, but if the user clicks Send and then the debounce timer fires simultaneously, you could get two `processNextAudio` calls in rapid succession. The `busy` flag only guards after the first `await`.

**Impact:** Potential double-processing of audio segments or overlapping TTS playback.

**Fix:** Use a proper queue/mutex pattern, or cancel the debounce timer in all paths that call `processNextAudio`.

---

#### BUG-006: `TtsPipeline.drainAll()` uses polling instead of event-driven completion

**File:** `packages/gateway/src/tts/pipeline.ts` lines 96–113

```js
private drainAll(): Promise<void> {
  const DRAIN_TIMEOUT_MS = 30_000;
  return new Promise((resolve) => {
    const check = () => {
      ...
      setTimeout(check, 50);
    };
    check();
  });
}
```

This polls every 50ms (up to 30 seconds) to check if all in-flight TTS requests completed. This is wasteful and adds up to 50ms latency to the end-of-turn transition. More importantly, the **promise never rejects** — if something goes permanently wrong, it silently resolves after 30s with potentially incomplete audio delivery.

**Impact:** Up to 50ms unnecessary delay per turn completion; silent failure mode on stuck TTS requests.

**Fix:** Replace with an event-driven approach: have `synthesizeAndQueue` signal when `inFlight` drops to 0, or use a counter + Promise resolver pattern.

---

#### BUG-007: `GatewayClient` pending request leak when connection is lost during handshake

**File:** `packages/gateway/src/llm/gateway-client.ts` — `ensureConnected()`

If the WebSocket closes during the handshake (between `ws.on('open')` and the `connect` response), and `this.ws === ws` evaluates false (because another connection attempt raced), the close handler skips `handleDisconnect`. Meanwhile, the `finish()` callback does fire with an error, but any requests that were queued between `connecting = Promise` and the socket opening are not cleaned up — they're stuck in `pendingReqs` forever.

Additionally, the `connecting` promise is only set to `null` inside `finish()`, but if `ws.on('close')` fires after `finish()` already resolved (edge case with rapid reconnect), `handleDisconnect` runs on a stale socket and rejects all pending requests from the *new* connection.

**Impact:** Memory leak and hung requests under flaky network conditions.

**Fix:** Guard `handleDisconnect` with a connection generation counter, and ensure `finish()` always clears all state associated with that specific connection attempt.

---

#### BUG-008: No input sanitization on `config.sessionKey` before use in gateway RPC

**File:** `packages/gateway/src/ws/handler.ts` lines 84–88

```js
function normalizeSessionKey(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SESSION_KEY;
  const trimmed = raw.trim();
  return trimmed || DEFAULT_SESSION_KEY;
}
```

Session keys are trimmed but not validated for dangerous characters. A malicious client could send session keys with newlines, control characters, path traversal sequences, or extremely long strings. These flow directly into `gatewayClient.sendChat(sessionKey, ...)` and `gatewayClient.sendRequest('chat.history', { sessionKey, ... })`.

**Impact:** Potential injection into downstream gateway operations; extremely long session keys could cause memory issues.

**Fix:** Validate session keys against a whitelist pattern (e.g., `^[a-zA-Z0-9:._-]{1,128}$`) and reject invalid ones.

---

### 🟡 MEDIUM

#### BUG-009: `bridge.html` — `currentAssistantEl` reset timing allows duplicate messages

**File:** `bridge.html` — `sendText()` (line ~182) and `processAudio()` (line ~268)

Both `sendText` and `processAudio` set `currentAssistantEl = null` at the end. But `updateAssistant()` creates a new `<div>` when `currentAssistantEl` is null. If the user sends a text message while voice processing is in flight, both code paths could create separate assistant message elements for what's conceptually the same response, or the text response could appear in the old assistant element.

**Impact:** Duplicate or misplaced assistant messages in the chat UI.

**Fix:** Associate `currentAssistantEl` with a turn ID and check before creating new elements.

---

#### BUG-010: `TtsRouter` clears failures on success even after fallback switch

**File:** `packages/gateway/src/tts/router.ts` lines 42–43

```js
const audio = await client.synthesize(text, voice || defaultVoice);
this.failures = [];
return { audio, provider: this.activeProvider };
```

After a successful synthesis, `this.failures = []` is called. But if the router previously switched to the fallback provider and the fallback succeeds, the failure array is cleared — meaning the next call will still use the fallback provider. There's no mechanism to **switch back** to the primary provider after it recovers (unlike the STT router which has a health-check loop).

**Impact:** Once TTS fails over to OpenAI, it stays on OpenAI permanently until the process restarts, even if Kokoro comes back online.

**Fix:** Add a periodic health check for the primary TTS provider (similar to `SttRouter.switchToFallback`) to auto-recover.

---

#### BUG-011: `bridge.html` — `isSpeaking` never reset on TTS fetch failure before audio decode

**File:** `bridge.html` — `speak()` function, line ~226

The `isSpeaking` flag is set to `true` after creating the `AudioBufferSourceNode`, but in the error catch block it's correctly reset. However, if `audioCtx.decodeAudioData(arrayBuffer)` throws (e.g. corrupted audio data), the code flows into the catch correctly. But there's a subtler issue: if `fetch('/api/tts', ...)` succeeds but returns audio that `decodeAudioData` can't parse, the `isSpeaking = true` was already set and gets properly caught. Actually wait — `isSpeaking` is set **after** `decodeAudioData` succeeds. Let me re-read...

Actually, `isSpeaking = true` is set on line ~236, **after** `decodeAudioData`. So the specific decode failure is handled. However, there's no timeout on the TTS fetch itself — if the server hangs, `speak()` blocks indefinitely, and during that time `tryPlayTts` won't fire because `isSpeaking` is false but `busy` could prevent it through another path.

**Impact:** TTS fetch hang blocks the entire audio pipeline with no timeout.

**Fix:** Add `AbortSignal.timeout(15_000)` to the TTS fetch call in bridge.html.

---

#### BUG-012: `bridge.html` uses HTTP POST endpoints — no WebSocket integration

**File:** `bridge.html` (entire client implementation)

The bridge.html client uses `fetch('/api/transcribe')`, `fetch('/api/chat')`, and `fetch('/api/tts')` — HTTP POST endpoints served by `bridge.js`. Meanwhile, the gateway server (`packages/gateway/`) implements a fully WebSocket-based protocol with turn state management, streaming tokens, and chunked TTS delivery.

**These two systems are completely independent.** The bridge.html + bridge.js path is a separate legacy system with no streaming, no turn state machine, and no chunked TTS. Depending on which server the user connects to, they get a fundamentally different experience.

**Impact:** Two divergent codepaths to maintain; bridge.html users miss all the WebSocket protocol features (streaming tokens, chunked TTS, barge-in, turn state).

**Fix:** Either deprecate bridge.html in favor of the client package, or rewrite bridge.html to use the WebSocket protocol.

---

#### BUG-013: `handleAudioFrame` — buffer overflow recovery doesn't clear `pendingTranscript`

**File:** `packages/gateway/src/ws/handler.ts` lines 250–260

When the audio buffer exceeds 10MB, the handler clears the audio buffer and transitions to idle, but doesn't clear `conn.pendingTranscript`. On the next turn, stale transcript text from the overflowed turn could be prepended to the new transcription.

**Impact:** Stale transcript text leaking across turns after a buffer overflow.

**Fix:** Add `conn.pendingTranscript = '';` and `conn.turnId = null;` in the overflow handler.

---

#### BUG-014: `bridge.html` — `vadDebounceTimer` not cleared on stop

**File:** `bridge.html` — `stop()` function

```js
const stop = () => {
  running = false;
  if (vadInstance) { vadInstance.pause(); vadInstance = null; }
  ...
  audioQueue.length = 0;
```

The `vadDebounceTimer` is not cleared in `stop()`. If the timer fires after stop, it calls `processNextAudio()` which checks `busy` and `audioQueue.length` (now 0), so it's a no-op. But it's still sloppy — and if the timing is unlucky, the queue could have items added between stop clearing it and the timer firing.

**Impact:** Minor — potential processing after stop in edge case.

**Fix:** Add `clearTimeout(vadDebounceTimer);` to the `stop()` function.

---

#### BUG-015: Unused `TurnMachine` class

**File:** `packages/gateway/src/ws/turn-machine.ts`

The `TurnMachine` class is fully implemented but **never imported or used anywhere**. The handler (`handler.ts`) implements its own inline state transition logic instead. This is dead code that adds maintenance burden and could confuse developers.

**Impact:** Dead code; maintenance burden; potential for drift between the two implementations.

**Fix:** Either integrate `TurnMachine` into the handler, or delete it.

---

#### BUG-016: `RollingWindowSTT` class exists but is unused

**File:** `packages/gateway/src/stt/rolling-window.ts`

Similar to TurnMachine, this class is implemented and tested but never used in the actual handler pipeline. The handler uses one-shot transcription via `SttRouter.transcribe()` instead.

**Impact:** Dead code.

**Fix:** Remove or integrate.

---

#### BUG-017: `better-sqlite3` dependency declared but never used

**File:** `packages/gateway/package.json`

`better-sqlite3` (a native Node.js addon requiring compilation) is listed as a dependency but no source file imports it. This adds build complexity (native compilation), binary size, and potential platform compatibility issues for no benefit.

**Impact:** Unnecessary build dependency; potential install failures on some platforms.

**Fix:** Remove `better-sqlite3` and `@types/better-sqlite3` from package.json.

---

#### BUG-018: `ws` module type mismatch — `@types/ws` in devDependencies but `ws` not in dependencies

**File:** `packages/gateway/package.json`

The handler imports `{ WebSocket, RawData } from 'ws'`, and `@types/ws` is in devDependencies, but `ws` itself is **not listed as a direct dependency**. It likely comes transitively through `@fastify/websocket`, but this is fragile — a major version bump of `@fastify/websocket` could change its `ws` version or drop the re-export.

**Impact:** Fragile transitive dependency; potential breakage on upgrade.

**Fix:** Add `ws` as a direct dependency with a version range matching what `@fastify/websocket` uses.

---

### 🟢 LOW

#### BUG-019: `bridge.html` — CDN version mismatch with client package

**File:** `bridge.html` lines 56–57 vs `packages/client/hooks/useAudioCapture.ts` lines 65, 106–109

bridge.html loads:
- `onnxruntime-web@1.22.0`
- `@ricky0123/vad-web@0.0.29`

The client package uses:
- `onnxruntime-web@1.24.1`
- `@ricky0123/vad-web@0.0.30`

**Impact:** bridge.html runs older ONNX/VAD versions. Potential behavioral differences or missed bug fixes.

**Fix:** Align CDN versions with the client package.

---

#### BUG-020: `console.log` in production TTS clients

**File:** `packages/gateway/src/tts/kokoro-client.ts` line 19  
**File:** `packages/gateway/src/tts/openai-client.ts` line 29

Both TTS clients use `console.log` for timing information instead of the structured `pino` logger used elsewhere in the gateway.

**Impact:** Unstructured log output in production; timing data not captured in log aggregation.

**Fix:** Replace `console.log` with the pino logger (inject via constructor or use a module-level instance).

---

#### BUG-021: `bridge.html` — no escaping of chat message text (XSS risk if source is untrusted)

**File:** `bridge.html` — `addMessage()` function

```js
div.textContent = `${role === 'user' ? 'You' : 'Clawd'}: ${text}`;
```

Uses `textContent`, which is safe against XSS. ✅ However, `updateAssistant()` also uses `textContent`:

```js
currentAssistantEl.textContent = `Clawd: ${text}`;
```

This is correctly safe. No XSS issue here — noting this for completeness as it was reviewed.

**Impact:** None — correctly using `textContent` not `innerHTML`.

---

#### BUG-022: `ecosystem.config.js` — missing `NODE_ENV` for https-proxy

**File:** `ecosystem.config.js`

The `voice-gateway` app sets `NODE_ENV: 'production'` but the `https-proxy` app has no env configuration at all. If the proxy needs environment variables (like `TLS_CERT`, `TLS_KEY`, `METRO_PORT`), they must come from the shell environment or be hardcoded.

**Impact:** HTTPS proxy may fail to start if TLS cert paths differ from defaults.

**Fix:** Add env configuration to the https-proxy PM2 app definition:
```js
env: {
  TLS_CERT: './certs/tailscale.crt',
  TLS_KEY: './certs/tailscale.key',
}
```

---

#### BUG-023: `@types/react` version mismatch with React 19

**File:** `packages/client/package.json`

React 19.1.0 is installed but `@types/react` is pinned to `~18.3.18`. This will cause TypeScript errors for React 19 features and incorrect type information.

**Impact:** Type errors; incorrect autocomplete/IntelliSense for React 19 APIs.

**Fix:** Update `@types/react` to `^19.0.0`.

---

#### BUG-024: `bridge.html` — config dialog doesn't update `voice` in running TTS

**File:** `bridge.html` — config is saved to localStorage but the active `config` object is updated in-place via `applyFormToConfig()`. The `speak()` function reads `config.voice` each time, so changes take effect on the next TTS call. This is correct but there's a subtlety:

If the user changes voice while audio is in the `pendingReplyText` queue, the queued text will be spoken with the **new** voice, not the voice active when the reply was generated. This is probably fine UX-wise but worth noting.

**Impact:** Cosmetic — voice change takes effect mid-reply if text is queued.

---

#### BUG-025: `packages/gateway/src/ws/handler.ts` — `handleJsonMessage` exhaustive check unreachable

**File:** `packages/gateway/src/ws/handler.ts` — default case in `handleJsonMessage`

```js
default: {
  const _exhaustive: never = msg;
```

The JSON is parsed as `ClientMessage` without runtime validation. A malformed message with an unknown `type` field will be cast to `ClientMessage` and hit the default case, but only after TypeScript's exhaustive check has verified at compile time that all types are handled. At runtime, the `_exhaustive` assignment would fail since `msg` isn't `never`. This would throw a runtime error rather than sending the intended error response.

**Impact:** Unknown message types cause uncaught exceptions instead of graceful error responses.

**Fix:** Validate `msg.type` against known values before the switch, or use a try-catch around the exhaustive check:
```js
default:
  sendMessage(conn, { type: 'error', code: 'UNKNOWN_MESSAGE', ... });
```

---

## Round 2 — Config & Integration

### 🟠 HIGH

#### BUG-026: `bridge.js` (legacy) and gateway server conflict on port 8787 / 8788

**File:** `bridge.js` line 14: `const PORT = Number(process.env.VOICE_BRIDGE_PORT || 8787);`  
**File:** `ecosystem.config.js`: `PORT: 8788`  
**File:** `packages/gateway/src/tts/kokoro-client.ts` line 8: default Kokoro URL is `http://100.86.69.14:8787`

The legacy bridge server defaults to port 8787 — the **same port** as the Kokoro TTS server. If both are running on the same machine, they'll conflict. The ecosystem.config.js correctly puts the gateway on 8788, but the bridge.js default is dangerous.

**Impact:** Port conflict between bridge.js and Kokoro TTS if both run locally.

**Fix:** Change bridge.js default port to something else (e.g., 8786), or document the conflict.

---

#### BUG-027: Hardcoded Tailscale IPs for Kokoro and Parakeet services

**File:** `packages/gateway/src/tts/kokoro-client.ts` line 8: `http://100.86.69.14:8787`  
**File:** `packages/gateway/src/stt/parakeet-client.ts` line 10: `http://100.86.69.14:8765`  
**File:** `bridge.js` lines 16, 18

Both STT and TTS clients hardcode the Tailscale IP `100.86.69.14` as the default. This is specific to one developer's network topology. Any deployment to a different machine or network will fail silently (connection refused / timeout) with cryptic errors.

**Impact:** App unusable outside the original developer's Tailscale network without setting env vars.

**Fix:** Use `localhost` as the default (fail fast) or document the required environment variables prominently. Consider adding a startup health check that warns if Kokoro/Parakeet are unreachable.

---

#### BUG-028: No `dotenv` / `.env` file loading in bridge.js

**File:** `bridge.js` — reads `process.env.*` directly  
**File:** `packages/gateway/src/server.ts` line 1: `import 'dotenv/config';`

The gateway server loads `.env` via `dotenv`, but `bridge.js` does not. Environment variables must be set in the shell or via PM2, which is inconsistent and error-prone.

**Impact:** bridge.js ignores `.env` files, causing config confusion.

**Fix:** Add `require('dotenv/config')` at the top of bridge.js.

---

### 🟡 MEDIUM

#### BUG-029: `ecosystem.config.js` — no `cwd` specified

**File:** `ecosystem.config.js`

PM2 runs with the cwd of wherever `pm2 start` was invoked from. The script path `packages/gateway/dist/server.js` is relative, and the TLS cert resolution in server.ts uses `process.cwd()`:

```js
const certPath = process.env.TLS_CERT || path.resolve(process.cwd(), '..', '..', 'certs', 'tailscale.crt');
```

If PM2 is started from a different directory, cert resolution will fail, and the server will start without TLS (falling back silently to HTTP).

**Impact:** TLS certs not found if PM2 started from wrong directory; silent HTTP fallback.

**Fix:** Add `cwd: __dirname` or an absolute path to the PM2 config.

---

#### BUG-030: `SttRouter` fallback sends placeholder text to LLM

**File:** `packages/gateway/src/stt/router.ts` lines 36–41

```js
private cloudFallback(_audio: Buffer): TranscribeResult {
  return {
    text: '[STT unavailable - local provider offline]',
    confidence: 0,
    segments: [],
  };
}
```

When Parakeet fails 3 times, the STT router switches to the "cloud" fallback which returns a literal placeholder string. This string gets sent to the LLM as if it were user speech, producing a confusing assistant response like "I see you're having technical difficulties..."

**Impact:** LLM receives garbage input after STT failure; confusing user experience.

**Fix:** Return an empty string or a special sentinel value that the handler recognizes and skips (similar to the `isNoisySegment` check). Or actually implement a cloud STT fallback.

---

#### BUG-031: Client `useAudioPlayback` — `warmup()` defined but not exported

**File:** `packages/client/hooks/useAudioPlayback.ts` lines 186–189

```js
const warmup = useCallback(async () => {
  const ctx = ensureContext();
  await resumeContext(ctx);
}, [ensureContext, resumeContext]);

return { isPlaying, queueChunk, markDone, stop, setVolume, warmup };
```

Wait — `warmup` IS in the return statement. But the `UseAudioPlaybackReturn` interface (line 20) doesn't include it:

```ts
export interface UseAudioPlaybackReturn {
  isPlaying: boolean;
  queueChunk: (meta: TtsChunkMeta, audioData: ArrayBuffer) => void;
  markDone: () => void;
  stop: () => void;
  setVolume: (vol: number) => void;
}
```

TypeScript's structural typing means calling code can't access `warmup` through the typed return value without a cast.

**Impact:** `warmup()` is inaccessible to consumers of the hook through the declared type.

**Fix:** Add `warmup: () => Promise<void>` to the `UseAudioPlaybackReturn` interface.

---

#### BUG-032: `packages/client/lib/types.ts` is a manual copy of gateway types

**File:** `packages/client/lib/types.ts` — comment at top: "copied from packages/gateway/src/types.ts"

These types are manually synchronized. If the gateway types evolve (new message types, changed fields), the client will silently drift. This is already visible: the files are nearly identical now, but maintenance burden grows with every protocol change.

**Impact:** Type drift between client and server after future changes.

**Fix:** Create a shared `packages/shared` or `packages/protocol` package, or use TypeScript project references.

---

#### BUG-033: HTTPS proxy doesn't handle TLS cert read failures gracefully

**File:** `scripts/https-proxy.mjs` lines 18–19

```js
const cert = readFileSync(process.env.TLS_CERT || resolve(root, 'certs', 'tailscale.crt'));
const key = readFileSync(process.env.TLS_KEY || resolve(root, 'certs', 'tailscale.key'));
```

If the cert files don't exist, `readFileSync` throws with a cryptic `ENOENT` error and the process crashes. No helpful error message about what the user needs to do.

**Impact:** Confusing error on fresh installs without certs.

**Fix:** Check file existence first and print a helpful message about how to generate/obtain TLS certs.

---

### 🟢 LOW

#### BUG-034: `useWebSocket` — `sendQueueRef` grows unbounded during disconnection

**File:** `packages/client/hooks/useWebSocket.ts` — `send()` callback

```js
const send = useCallback((msg: ClientMessage) => {
  ...
  } else {
    sendQueueRef.current.push(serialized);
  }
}, []);
```

JSON messages are queued during disconnection with no size limit. If the client is disconnected for an extended period while the user keeps typing, the queue grows without bound. On reconnection, all queued messages are flushed at once, potentially overwhelming the server's rate limiter.

**Impact:** Memory growth during prolonged disconnection; potential rate limiting on reconnect.

**Fix:** Cap the queue size (e.g., 50 messages) and drop oldest entries.

---

#### BUG-035: `SlidingWindowRateLimiter` re-filters on every `check()` and `remaining` call

**File:** `packages/gateway/src/ws/rate-limiter.ts`

The filter `this.timestamps.filter(t => now - t < this.windowMs)` runs on every call, which is O(n) where n is the number of timestamps in the window. At 100 msgs/sec, this means filtering up to 100 entries per call. Not a real performance issue at this scale, but could be optimized with a circular buffer.

**Impact:** Negligible — minor CPU overhead.

---

#### BUG-036: `ecosystem.config.js` uses CommonJS but gateway uses ESM

**File:** `ecosystem.config.js` uses `module.exports`  
**File:** `packages/gateway/package.json` has `"type": "module"`

PM2's ecosystem config must be CommonJS (PM2 requires it), which is correct. But it's worth noting that the built `dist/server.js` needs to be valid ESM. The TypeScript compiler config targets ES2022 modules, which should produce ESM output. This works but could break if `tsconfig` changes `module` to CommonJS.

**Impact:** Potential future breakage if build config changes.

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| 🔴 Critical | 2 | TTS voice config ignored; shared singleton cross-session routing |
| 🟠 High | 8 | Media stream leaks; race conditions; missing input validation; port conflicts; hardcoded IPs |
| 🟡 Medium | 10 | Dead code; fallback sending garbage to LLM; type drift; missing timeout; missing interface field |
| 🟢 Low | 6 | Version mismatches; console.log in production; unbounded queue; minor config issues |

**Most impactful quick wins:**
1. Fix BUG-001 (thread voice/instructions through TTS pipeline)
2. Fix BUG-003 (destroy VAD + stop media tracks on stop)
3. Fix BUG-008 (validate session keys)
4. Fix BUG-013 (clear pendingTranscript on buffer overflow)
5. Fix BUG-030 (don't send placeholder STT text to LLM)
