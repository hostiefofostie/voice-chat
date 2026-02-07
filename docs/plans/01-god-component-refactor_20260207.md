# Plan 01: God Component Refactor

**Improvement:** #1 from the audit — `app/index.tsx` is a 517-line god component
**Author:** client-refactor agent
**Date:** 2026-02-07

---

## Problem

`packages/client/app/index.tsx` handles everything in a single React component:

1. **WebSocket message dispatch** — a 70-line `onMessage` callback switches on 10+ message types, calling into 3 different stores and managing `pendingTtsMetaRef` for tts_meta/binary pairing.
2. **Audio capture orchestration** — `onSpeechStart` has a 6-branch conditional for barge-in, idle start, resume-speaking, and cancel-during-thinking. `handleMicToggle` wraps capture start/stop with AudioContext warmup and permission error reporting.
3. **Audio playback wiring** — `useAudioPlayback` callbacks feed back into turn state transitions.
4. **Auto-send countdown** — three separate `useEffect` hooks (initialize countdown on `pending_send`, tick every second, auto-send at zero) with a `textInputRef` to avoid stale closure over `textInput`.
5. **Text input + send** — `handleSend`, `handleCancelTranscript`, `handleTextChange`, `handleRetryLlm`, `handleCancelLlm` all manipulate turn state + WS + chat store.
6. **Config sync** — a `useEffect` subscribes to `configStore` changes and pushes them to the server.
7. **Error recovery** — `useErrorRecovery()` + `useLlmTimeoutTracker()` plus scattered `useErrorStore.getState()` calls inside callbacks.

### Specific bugs and code smells

- **`handleMicToggle` depends on `[capture]`** — `capture` is a new object every render (returned by `useAudioCapture`), so the memoization does nothing. Every render creates a new `handleMicToggle`, which cascades to re-rendering `VoiceButton`.
- **`handleMuteToggle` depends on `[capture]`** — same problem.
- **`pendingTtsMetaRef` race condition** — `tts_meta` (JSON frame) sets the ref, then the next binary frame reads it. If two `tts_meta` messages arrive before any binary frame (e.g., network reordering, or the server sends meta for chunk N+1 before the binary for chunk N arrives), the first meta is silently overwritten and chunk N plays with chunk N+1's metadata (wrong duration, wrong index). Since `queueChunk` uses the meta's `index` field for ordering, this corrupts playback order.
- **Auto-send countdown race** — if the user types during `pending_send`, `handleTextChange` resets `countdown` to `Math.ceil(delay / 1000)`. But `setCountdown` is batched by React, and the `useEffect` that fires auto-send checks `countdown === 0`. If a keystroke and the timeout decrement happen in the same React batch, the user's edit can be sent prematurely.
- **`onPlaybackEnd` calls `transition('idle')`** — but `transition()` validates against `VALID_TRANSITIONS`, and if the server has already moved state to something other than `speaking` (e.g., barge-in moved to `listening`), this transition silently fails. Should use `reconcile` instead or check current state.

---

## Solution: TurnController + Component Decomposition

### TurnController

Extract a **non-React class** (`packages/client/lib/TurnController.ts`) that owns the entire turn lifecycle. It is constructed once per app mount and passed around via React context.

```
TurnController
  |-- ws: WebSocket adapter (send, sendBinary, onMessage, onBinary, onConnect, onDisconnect)
  |-- turnStore: reference to Zustand store (for state reads/writes)
  |-- chatStore: reference to Zustand store
  |-- errorStore: reference to Zustand error store
  |-- configStore: reference to Zustand config store
  |-- playback: UseAudioPlaybackReturn (passed in after hook initialization)
  |-- pendingTtsMeta: TtsChunkMeta | null (replaces pendingTtsMetaRef)
  |-- autoSendTimer: ReturnType<typeof setTimeout> | null
  |-- autoSendCountdown: number (exposed as getter for UI)
```

#### Public API

```typescript
class TurnController {
  // Lifecycle
  attach(ws: UseWebSocketReturn, playback: UseAudioPlaybackReturn): void;
  detach(): void;

  // WS message routing (called by useWebSocket handlers)
  handleServerMessage(msg: ServerMessage): void;
  handleBinaryMessage(data: ArrayBuffer): void;
  handleConnect(): void;
  handleDisconnect(): void;

  // User actions
  send(text: string): void;           // Send text (typed or pending transcript)
  cancelTranscript(): void;           // Cancel pending_send
  retryLlm(): void;                   // Retry last user message
  cancelLlm(): void;                  // Cancel current LLM generation
  onSpeechStart(): void;              // VAD speech start (barge-in logic lives here)
  onSpeechEnd(): void;                // VAD speech end
  onTextChange(text: string): void;   // User edited text in pending_send

  // Auto-send countdown (reactive)
  get countdown(): number | null;
  onCountdownChange: ((c: number | null) => void) | null;
}
```

#### Key design decisions

1. **All WS message handling in one place.** No React callbacks, no stale closures. The controller reads store state via `getState()` (synchronous, always current).

2. **pendingTtsMeta pairing uses a queue, not a single ref.** Instead of `pendingTtsMetaRef.current = meta`, the controller maintains a `pendingTtsMetaQueue: TtsChunkMeta[]`. On binary frame, it shifts the first item. This eliminates the overwrite race.

3. **Auto-send uses setTimeout, not React state + useEffect.** The controller manages a single `setTimeout` for auto-send. `onTextChange` calls `clearTimeout` + `setTimeout` atomically. No React batching race.

4. **Barge-in logic is a method, not a closure.** `onSpeechStart()` reads `turnStore.getState().state` synchronously and branches. No dependency array issues.

5. **Testable without React.** The controller can be unit tested by mocking the stores and WS adapter. No need for `@testing-library/react` or rendering components.

### Component Decomposition

**Before:** One `Index` component (517 lines) renders everything.

**After:**

```
app/index.tsx (< 80 lines)
  |-- TurnControllerProvider (React context, creates + attaches controller)
  |-- ChatScreen (layout shell)
        |-- HeaderBar (connection dot, latency, settings link)
        |-- ErrorBanner (unchanged — already a separate component)
        |-- StatusIndicator (unchanged — already a separate component)
        |-- ChatHistory (updated — see plan 06)
        |-- TranscriptBox (unchanged)
        |-- MessageInput (text input + send button + countdown + cancel)
        |-- VoiceControls (auto-send toggle + VoiceButton)
```

**New files:**

| File | Responsibility |
|------|---------------|
| `lib/TurnController.ts` | Turn lifecycle, WS dispatch, auto-send timer, barge-in |
| `lib/TurnControllerContext.tsx` | React context + provider + `useTurnController()` hook |
| `components/HeaderBar.tsx` | Connection status dot, latency display, settings gear |
| `components/MessageInput.tsx` | Text input, send button, countdown display, cancel button |
| `components/VoiceControls.tsx` | Auto-send toggle + VoiceButton wrapper |
| `components/ChatScreen.tsx` | Layout shell composing all child components |

**Deleted or simplified:**

- `app/index.tsx` becomes ~60 lines: mount `TurnControllerProvider`, render `ChatScreen`.
- All `useCallback` wrappers for WS handlers are replaced by `controller.handleServerMessage` etc.
- The three auto-send `useEffect` hooks are deleted.
- `handleMicToggle`, `handleMuteToggle`, `handleSend`, etc. move into the controller or become one-liner wrappers.

### Fixing the pendingTtsMetaRef Race Condition

Current code:
```typescript
// onMessage (JSON frame)
case 'tts_meta':
  pendingTtsMetaRef.current = { format, index, sampleRate, durationMs };
  break;

// onBinary (binary frame)
const meta = pendingTtsMetaRef.current;
pendingTtsMetaRef.current = null;
playbackRef.current.queueChunk(meta, data);
```

If two `tts_meta` JSON frames arrive before a binary frame (possible under WebSocket message reordering within the browser's event loop, or if the gateway sends meta+meta+binary+binary), the first meta is lost.

**Fix:** Use a FIFO queue:
```typescript
// In TurnController
private pendingTtsMetaQueue: TtsChunkMeta[] = [];

handleServerMessage(msg: ServerMessage) {
  // ...
  case 'tts_meta':
    this.pendingTtsMetaQueue.push({ format, index, sampleRate, durationMs });
    break;
}

handleBinaryMessage(data: ArrayBuffer) {
  const meta = this.pendingTtsMetaQueue.shift();
  if (meta) {
    this.playback.queueChunk(meta, data);
  }
}
```

### Fixing Callback Dependency Arrays

The `handleMicToggle` and `handleMuteToggle` callbacks depend on `[capture]`, but `capture` is the return value of `useAudioCapture` which is a new object every render. Fix: instead of depending on `capture`, the `VoiceControls` component will call `controller.toggleMic()` and `controller.toggleMute()`, which read capture state from a ref or direct reference, not a closure.

In the new design, the `useAudioCapture` hook is called inside `ChatScreen` and its return value is stored in a ref that the `TurnController` reads. The controller's methods never close over React state.

### Fixing onPlaybackEnd Transition

Current: `onPlaybackEnd: () => { transition('idle'); }` — uses validated transition which can silently fail.

Fix: `onPlaybackEnd` in the controller checks current state:
```typescript
onPlaybackEnd() {
  const current = this.turnStore.getState().state;
  if (current === 'speaking') {
    this.turnStore.getState().reconcile('idle');
  }
  // If state is already something else (e.g., listening from barge-in), do nothing.
}
```

---

## Testing Strategy

### Unit tests for TurnController (no React)

File: `packages/client/lib/__tests__/TurnController.test.ts`

- Mock stores (simple objects implementing the store interface with `getState`/`setState`)
- Mock WS adapter (captures sent messages)
- Mock playback (captures `queueChunk`, `markDone`, `stop` calls)

Tests:
1. **Message routing:** Each ServerMessage type calls the correct store method
2. **tts_meta/binary pairing:** Queue-based pairing handles sequential, interleaved, and missing-meta cases
3. **Barge-in logic:** `onSpeechStart()` during each turn state produces the correct actions (stop playback, send barge_in, transition state)
4. **Auto-send countdown:** Timer starts on pending_send, resets on text edit, fires send at zero, cancels on explicit send or cancel
5. **Config sync:** Config store subscription pushes changes to WS
6. **Error routing:** Error messages route to correct error store methods

### Component tests (minimal)

- `MessageInput`: renders countdown, calls `controller.send()` on submit, calls `controller.cancelTranscript()` on cancel
- `HeaderBar`: renders connection status from WS state
- `VoiceControls`: passes through to `controller.toggleMic()`

---

## Migration Steps

1. **Create `TurnController` class** with full logic, exporting from `lib/TurnController.ts`.
2. **Create `TurnControllerContext.tsx`** with provider and `useTurnController()` hook.
3. **Extract `HeaderBar` component** from index.tsx header JSX.
4. **Extract `MessageInput` component** from index.tsx text input row JSX. It uses `useTurnController()` for send/cancel/countdown.
5. **Extract `VoiceControls` component** wrapping auto-send toggle + VoiceButton. It calls controller methods.
6. **Create `ChatScreen` component** composing HeaderBar, ErrorBanner, StatusIndicator, ChatHistory, TranscriptBox, MessageInput, VoiceControls.
7. **Rewrite `app/index.tsx`** to mount TurnControllerProvider + ChatScreen. Delete all the old callback/effect code.
8. **Write TurnController unit tests.**
9. **Run `npm run typecheck`** to verify.

Each step is a separate commit.

---

## Risks

1. **Hooks that depend on render lifecycle.** `useAudioCapture` and `useAudioPlayback` return values that change across renders. The controller must not store stale references. Mitigation: use a ref pattern where the controller receives a `playbackRef` whose `.current` is updated every render.

2. **Store subscription timing.** The config sync `useEffect` subscribes to Zustand's `subscribe()`. Moving this into the controller means calling `useConfigStore.subscribe()` outside React. This is supported by Zustand — `subscribe()` returns an unsubscribe function, and the controller calls it in `detach()`.

3. **Circular dependency risk.** TurnController imports from store files, and stores are created with `create()`. As long as the controller doesn't import React components, there's no circular dependency.

4. **Integration with state-arch plans.** Resolved in cross-review -- see below.

---

## Cross-Review: Integration with Plan 02 (Shared State Machine) and Plan 03 (Turn-as-Object)

**Reviewed:** 2026-02-07 by client-refactor agent

### Plan 02 Impact on TurnController

Plan 02 replaces state-targeted `transition(toState)` with event-driven `transitionByEvent(event: TurnEvent)`. The `TurnEvent` type includes: `AUDIO_START`, `SILENCE_DETECTED`, `STT_DONE`, `SEND`, `TEXT_SEND`, `BARGE_IN`, `CANCEL`, `LLM_FIRST_CHUNK`, `LLM_DONE`, `ERROR`, etc.

**Required changes to TurnController:**

The TurnController currently plans to call `turnStore.getState().transition('listening')` (state-targeted). After Plan 02, it must call `turnStore.getState().transitionByEvent('AUDIO_START')` (event-driven).

Mapping of TurnController actions to TurnEvents:

| TurnController method | Current call | New call (after Plan 02) |
|---|---|---|
| `onSpeechStart()` (from idle) | `transition('listening')` | `transitionByEvent('AUDIO_START')` |
| `onSpeechStart()` (barge-in from speaking) | `reconcile('listening')` | `transitionByEvent('BARGE_IN')` then `transitionByEvent('AUDIO_START')` -- but see note below |
| `onSpeechStart()` (resume from pending_send/transcribing) | `reconcile('listening')` | `transitionByEvent('AUDIO_RESUME')` |
| `onSpeechEnd()` | `transition('transcribing')` | `transitionByEvent('SILENCE_DETECTED')` |
| `send()` (from pending_send) | `reconcile('thinking', turnId)` | `transitionByEvent('SEND')` |
| `send()` (text input from idle) | `reconcile('thinking', turnId)` | `transitionByEvent('TEXT_SEND')` |
| `cancelTranscript()` | `resetTurn()` | `transitionByEvent('CANCEL')` |
| `cancelLlm()` | `resetTurn()` | `transitionByEvent('CANCEL')` |
| `onPlaybackEnd()` | `reconcile('idle')` | Wait for server `turn_state` message (see below) |

**Important note on barge-in:** Plan 02's transition table has `speaking + BARGE_IN -> idle`, not `speaking + BARGE_IN -> listening`. This means barge-in is a two-step process on the client: (1) `BARGE_IN` moves to `idle`, (2) `AUDIO_START` moves to `listening`. The TurnController's `onSpeechStart()` during `speaking` state should:
1. Stop playback
2. Send `{ type: 'barge_in' }` to server
3. Call `transitionByEvent('BARGE_IN')` (speaking -> idle)
4. Call `transitionByEvent('AUDIO_START')` (idle -> listening)

This is semantically cleaner than the current `reconcile('listening')` which force-skips the idle state.

**Important note on onPlaybackEnd:** The client's `onPlaybackEnd` fires when the last audio chunk finishes playing locally. But the server drives the `speaking -> idle` transition via `LLM_DONE` event (which happens when TTS finishes sending all chunks). The server's `turn_state: idle` message arrives via WebSocket and `reconcile()` handles it. The client should NOT optimistically transition on playback end -- it should wait for the server's authoritative state. If the server message arrives before playback ends (unlikely but possible with network delays), `reconcile()` already handles that. If playback ends before the server message, the client remains in `speaking` until the server confirms. This is a behavioral change from the current code but is more correct.

Updated `onPlaybackEnd`:
```typescript
onPlaybackEnd() {
  // Do nothing -- wait for server's turn_state message.
  // The server sends LLM_DONE -> idle after TTS pipeline finishes.
  // If the server has already sent idle (reconcile moved us), this is a no-op.
}
```

### Plan 02 Impact on turnStore.ts

Plan 02 adds `transitionByEvent(event: TurnEvent)` to `turnStore`. The old `transition(toState)` is kept during migration but deprecated. My TurnController should use only `transitionByEvent()` and `reconcile()`. The `VALID_TRANSITIONS` import from `lib/types.ts` is replaced by importing from `lib/turn-fsm.ts` (Option C copy).

**turnStore interface update:**
```typescript
interface TurnStore {
  // ... existing fields ...
  transitionByEvent: (event: TurnEvent) => boolean;  // NEW
  transition: (to: TurnState, turnId?: string) => boolean;  // DEPRECATED, kept for migration
  reconcile: (serverState: TurnState, turnId?: string) => void;  // UNCHANGED
}
```

### Plan 03 Impact

Plan 03 is a pure gateway refactor. It creates a `Turn` class in `packages/gateway/src/ws/turn.ts` and refactors `handler.ts`. No client-side protocol changes. The same `ServerMessage` types (`turn_state`, `llm_token`, `tts_meta`, etc.) continue to flow over the WebSocket. **No impact on the client refactor.**

One indirect benefit: Plan 03 ensures every state transition on the server sends a `turn_state` message (via `Turn.transition()` which calls `deps.sendJson()`). This makes the client's reliance on `reconcile()` for server-driven transitions more robust.

### No Conflicts Found

All integration points are additive, not conflicting. The key adaptation is switching from state-targeted to event-driven transitions in the TurnController, which is a straightforward mechanical change. No plan changes are required for Plan 02 or Plan 03.

### Updated Migration Ordering

1. Plan 02 lands first (shared state machine + `turn-fsm.ts` + client copy)
2. Plan 01 lands second (TurnController uses `transitionByEvent()` from the start)
3. Plan 06 lands third (re-render optimization, independent of transition API)
