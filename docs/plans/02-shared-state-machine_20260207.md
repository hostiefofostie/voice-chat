# Plan 02: Shared State Machine

**Author:** state-arch agent
**Date:** 2026-02-07
**Audit item:** #2 — Two state machines, neither authoritative

---

## Problem

There are three separate implementations of the turn state machine that disagree:

1. **`packages/gateway/src/types.ts`** — `VALID_TRANSITIONS` map (authoritative definition).
2. **`packages/gateway/src/ws/turn-machine.ts`** — `TurnMachine` class wrapping `VALID_TRANSITIONS` with EventEmitter, auto-send timer, and turnId management. **Never imported by handler.ts.**
3. **`packages/gateway/src/ws/handler.ts`** — `transitionState()` function (lines 75-92) that validates via `VALID_TRANSITIONS`, but 4 places bypass it entirely with direct `conn.turnState = '...'` assignments:
   - Line 343: `conn.turnState = 'thinking'` (text-input sends from idle/listening/transcribing)
   - Lines 382-385: `conn.turnState = 'idle'` after TTS finish (stale-turn guard in `onLlmDone`)
   - Lines 397-399: `conn.turnState = 'idle'` on LLM error (stale-turn guard in `onLlmError`)
   - Lines 574-575: `conn.turnState = 'idle'` on barge-in
   - Lines 594-595: `conn.turnState = 'idle'` on cancel
4. **`packages/client/stores/turnStore.ts`** — Zustand store with its own `transition()` and `reconcile()`, importing a **copy** of `VALID_TRANSITIONS` from `packages/client/lib/types.ts`.
5. **`packages/client/lib/types.ts`** — A manually synchronized copy of the gateway types. Currently identical, but will diverge with any edit to either side.

The direct-assignment bypasses in handler.ts exist for legitimate reasons (barge-in and cancel need to force-reset to idle from any state; text-input sends need to skip the voice pipeline states). But they circumvent validation, which means:
- No `turn_state` messages are sent for some transitions (barge-in/cancel do send manually, but the pattern is ad-hoc)
- The TurnMachine class — purpose-built for this — is unused
- Any new state added to the machine requires updating 4+ files

## Solution

### Create a shared, pure-function state machine

Replace the three implementations with one canonical module that both gateway and client import. The machine is a pure function: `(currentState, event) => nextState | null`. No classes, no side effects, no EventEmitter. Each consumer wraps it with their own side effects.

### Key design decisions

1. **Event-driven, not state-targeted.** Current code uses `transition(toState)` which means callers must know valid targets. Instead, use semantic events: `AUDIO_START`, `SILENCE_DETECTED`, `STT_DONE`, `SEND`, `LLM_FIRST_CHUNK`, `LLM_DONE`, `TTS_DONE`, `BARGE_IN`, `CANCEL`, `ERROR`. The machine maps `(state, event) -> nextState`. This eliminates the "bypass validation for special cases" pattern — barge-in and cancel are just events that have transitions from multiple states.

2. **Location: `packages/gateway/src/shared/turn-fsm.ts`.** The gateway is the source of truth. The client will import it at build time. This eliminates the manual copy in `packages/client/lib/types.ts` for the state machine portion. (Other client types like `ServerMessage` remain copied for now — that's a separate concern.)

3. **The `TurnMachine` class (`turn-machine.ts`) is deleted.** Its responsibilities (turnId management, auto-send timer) move into the Turn object (Plan 03) or into handler.ts directly during the interim migration.

## Detailed Design

### File: `packages/gateway/src/shared/turn-fsm.ts`

```typescript
// Pure state machine — no side effects, no I/O, no EventEmitter.
// Shared between gateway and client.

export type TurnState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'pending_send'
  | 'thinking'
  | 'speaking';

export type TurnEvent =
  | 'AUDIO_START'       // VAD detected speech / first audio frame
  | 'SILENCE_DETECTED'  // VAD silence timeout triggered
  | 'STT_DONE'          // Transcription complete with text
  | 'STT_EMPTY'         // Transcription complete but empty/noise
  | 'AUDIO_RESUME'      // Audio arrived during transcribing or pending_send
  | 'SEND'              // User confirmed transcript (auto-send or manual)
  | 'TEXT_SEND'          // Text-input send (skip voice pipeline, go straight to thinking)
  | 'LLM_FIRST_CHUNK'   // First TTS phrase ready (thinking -> speaking)
  | 'LLM_DONE'          // LLM + TTS pipeline finished
  | 'BARGE_IN'          // User interrupted during speaking/thinking
  | 'CANCEL'            // User cancelled from any active state
  | 'ERROR';            // Recoverable error, return to idle

/**
 * Transition table: [currentState][event] -> nextState.
 * Missing entries mean the event is ignored in that state.
 */
const TRANSITIONS: Partial<Record<TurnState, Partial<Record<TurnEvent, TurnState>>>> = {
  idle: {
    AUDIO_START:  'listening',
    TEXT_SEND:    'thinking',
  },
  listening: {
    SILENCE_DETECTED: 'transcribing',
    CANCEL:           'idle',
    ERROR:            'idle',
    // Note: BARGE_IN is intentionally absent from listening. Barge-in means
    // "user interrupted the assistant" — during listening, the user is speaking,
    // not the assistant. Use CANCEL to abort the user's own speech.
  },
  transcribing: {
    STT_DONE:     'pending_send',
    STT_EMPTY:    'idle',
    AUDIO_RESUME: 'listening',
    CANCEL:       'idle',
    ERROR:        'idle',
  },
  pending_send: {
    SEND:         'thinking',
    AUDIO_RESUME: 'listening',
    CANCEL:       'idle',
    TEXT_SEND:    'thinking',
  },
  thinking: {
    LLM_FIRST_CHUNK: 'speaking',
    LLM_DONE:        'idle',       // LLM finished without producing TTS chunks
    CANCEL:          'idle',
    BARGE_IN:        'idle',
    ERROR:           'idle',
  },
  speaking: {
    LLM_DONE:  'idle',
    BARGE_IN:  'idle',
    CANCEL:    'idle',
    ERROR:     'idle',
  },
};

/**
 * Pure transition function. Returns the next state, or null if the event
 * is not valid in the current state (caller decides whether to ignore or log).
 */
export function transition(current: TurnState, event: TurnEvent): TurnState | null {
  return TRANSITIONS[current]?.[event] ?? null;
}

/**
 * Legacy compatibility: the old VALID_TRANSITIONS map for code that still
 * uses state-targeted transitions. Will be removed after full migration.
 */
export const VALID_TRANSITIONS: Record<TurnState, TurnState[]> = {
  idle:          ['listening', 'thinking'],
  listening:     ['transcribing', 'idle'],
  transcribing:  ['pending_send', 'listening', 'idle'],
  pending_send:  ['thinking', 'listening', 'idle'],
  thinking:      ['speaking', 'idle'],
  speaking:      ['idle'],
};
```

### Changes to `packages/gateway/src/types.ts`

- Remove `TurnState` type definition (moved to `shared/turn-fsm.ts`)
- Remove `VALID_TRANSITIONS` constant (moved to `shared/turn-fsm.ts`)
- Add re-exports for backwards compatibility during migration:
  ```typescript
  export { TurnState, TurnEvent, transition, VALID_TRANSITIONS } from './shared/turn-fsm.js';
  ```
- All other types (`SessionConfig`, `ClientMessage`, `ServerMessage`, etc.) remain in `types.ts`

### Changes to `packages/gateway/src/ws/handler.ts`

Replace the current `transitionState()` function and all direct assignments:

```typescript
import { transition as fsmTransition, TurnEvent } from '../shared/turn-fsm.js';

function transitionByEvent(
  conn: ConnectionState,
  event: TurnEvent,
  app: FastifyInstance,
): boolean {
  const next = fsmTransition(conn.turnState, event);
  if (next === null) {
    app.log.warn({ connId: conn.id, state: conn.turnState, event }, 'Ignored event');
    return false;
  }
  app.log.info({ connId: conn.id, from: conn.turnState, to: next, event }, 'State transition');
  conn.turnState = next;
  sendMessage(conn, { type: 'turn_state', state: next, turnId: conn.turnId ?? undefined });
  return true;
}
```

Specific handler.ts changes:

| Current code | New code |
|---|---|
| `transitionState(conn, 'listening', app)` | `transitionByEvent(conn, 'AUDIO_START', app)` |
| `transitionState(conn, 'transcribing', app)` | `transitionByEvent(conn, 'SILENCE_DETECTED', app)` |
| `transitionState(conn, 'pending_send', app)` | `transitionByEvent(conn, 'STT_DONE', app)` |
| Empty transcript -> `transitionState(conn, 'idle', app)` | `transitionByEvent(conn, 'STT_EMPTY', app)` |
| `transitionState(conn, 'thinking', app)` | `transitionByEvent(conn, 'SEND', app)` |
| `transitionState(conn, 'speaking', app)` | `transitionByEvent(conn, 'LLM_FIRST_CHUNK', app)` |
| Direct `conn.turnState = 'thinking'` (text-input) | `transitionByEvent(conn, 'TEXT_SEND', app)` |
| Direct `conn.turnState = 'idle'` (barge-in) | `transitionByEvent(conn, 'BARGE_IN', app)` |
| Direct `conn.turnState = 'idle'` (cancel) | `transitionByEvent(conn, 'CANCEL', app)` |
| Direct `conn.turnState = 'idle'` (LLM done/error) | `transitionByEvent(conn, 'LLM_DONE', app)` or `transitionByEvent(conn, 'ERROR', app)` |
| `transitionState(conn, 'listening', app)` (audio during pending_send) | `transitionByEvent(conn, 'AUDIO_RESUME', app)` |

This eliminates every direct `conn.turnState = '...'` assignment. All state changes go through `transitionByEvent()`, which means every transition is validated and emits a `turn_state` message.

### Changes to `packages/client/stores/turnStore.ts`

```typescript
import { transition as fsmTransition, TurnEvent, TurnState } from '../../gateway-shared/turn-fsm';

// In the store:
transitionByEvent: (event: TurnEvent) => {
  const { state } = get();
  const next = fsmTransition(state, event);
  if (next === null) return false;
  set({ state: next });
  return true;
},
// Keep reconcile() unchanged — server is authoritative
reconcile: (serverState: TurnState, turnId?: string) => {
  set({ state: serverState, ...(turnId ? { turnId } : {}) });
},
```

### Client import strategy

The client needs to import `turn-fsm.ts` from the gateway. Options:

**Option A (recommended): Symlink or path alias.**
Add a `paths` alias in the client's `tsconfig.json`:
```json
{
  "compilerOptions": {
    "paths": {
      "@voice-chat/shared/*": ["../gateway/src/shared/*"]
    }
  }
}
```
And configure Metro/Expo to resolve this alias. This is the simplest approach that works with Expo Web.

**Option B: npm workspace package.**
Create `packages/shared/` as a third workspace package. This is cleaner but adds build complexity and a new package to maintain.

**Option C (interim): Continue copying, but just `turn-fsm.ts`.**
Copy `turn-fsm.ts` into `packages/client/lib/turn-fsm.ts` with a header comment pointing to the source. This is the fastest path and avoids any build tooling changes. We accept the copy-divergence risk for this single small file.

**Recommendation:** Start with Option C for the implementation phase (minimal risk), then migrate to Option A as a follow-up. The file is small (~80 lines) and changes infrequently.

### Delete `packages/gateway/src/ws/turn-machine.ts`

The `TurnMachine` class is unused by handler.ts today. Its responsibilities are:
- **Transition validation** — absorbed by `turn-fsm.ts`
- **turnId management** — moves to the Turn object (Plan 03) or stays in ConnectionState
- **Auto-send timer** — moves to the Turn object (Plan 03) or stays in handler.ts

Delete `turn-machine.ts` and its test file `turn-machine.test.ts`. The test coverage for the state machine logic moves to a new test for `turn-fsm.ts`.

## File Changes Summary

| Action | File | Description |
|--------|------|-------------|
| **Create** | `packages/gateway/src/shared/turn-fsm.ts` | Pure-function state machine with event-driven transitions |
| **Create** | `packages/gateway/src/shared/__tests__/turn-fsm.test.ts` | Unit tests for the transition function |
| **Create** | `packages/client/lib/turn-fsm.ts` | Copy of `turn-fsm.ts` (interim, Option C) |
| **Modify** | `packages/gateway/src/types.ts` | Remove `TurnState` + `VALID_TRANSITIONS`, add re-exports from `shared/turn-fsm.ts` |
| **Modify** | `packages/gateway/src/ws/handler.ts` | Replace `transitionState()` + all direct assignments with `transitionByEvent()` |
| **Modify** | `packages/client/stores/turnStore.ts` | Use `fsmTransition()` instead of inline `VALID_TRANSITIONS` check |
| **Delete** | `packages/gateway/src/ws/turn-machine.ts` | Replaced by `shared/turn-fsm.ts` |
| **Delete** | `packages/gateway/src/ws/__tests__/turn-machine.test.ts` | Replaced by `shared/__tests__/turn-fsm.test.ts` |

## Testing Strategy

### New test: `packages/gateway/src/shared/__tests__/turn-fsm.test.ts`

Ported from `turn-machine.test.ts` but testing the pure function directly:

```typescript
describe('transition()', () => {
  // Happy path
  it('idle + AUDIO_START -> listening', () => {
    expect(transition('idle', 'AUDIO_START')).toBe('listening');
  });
  // ... all valid transitions

  // Invalid / ignored
  it('idle + SEND -> null', () => {
    expect(transition('idle', 'SEND')).toBeNull();
  });
  // ... all invalid combinations

  // Special: events that work from multiple states
  it('CANCEL returns idle from every non-idle state', () => {
    for (const state of ['listening', 'transcribing', 'pending_send', 'thinking', 'speaking']) {
      expect(transition(state as TurnState, 'CANCEL')).toBe('idle');
    }
  });

  it('BARGE_IN returns idle from thinking and speaking', () => {
    expect(transition('thinking', 'BARGE_IN')).toBe('idle');
    expect(transition('speaking', 'BARGE_IN')).toBe('idle');
  });

  it('BARGE_IN is ignored during listening (user is speaking, not assistant)', () => {
    expect(transition('listening', 'BARGE_IN')).toBeNull();
  });

  // Text-input path
  it('idle + TEXT_SEND -> thinking (bypasses voice pipeline)', () => {
    expect(transition('idle', 'TEXT_SEND')).toBe('thinking');
  });
});
```

No fake timers needed. No EventEmitter mocking. Pure input/output tests.

### Existing handler-pipeline tests

The integration tests in `handler-pipeline.test.ts` should continue to pass without changes — they test the observable behavior (WebSocket messages), not the internal transition mechanism. The same sequence of `turn_state` messages should appear.

Run the full test suite after changes:
```bash
cd packages/gateway && npm test
```

## Migration Steps

1. **Create `shared/turn-fsm.ts`** with the event-driven transition table and the `VALID_TRANSITIONS` re-export for backwards compat.
2. **Create `shared/__tests__/turn-fsm.test.ts`** and verify all transitions.
3. **Modify `types.ts`** to re-export from `shared/turn-fsm.ts`.
   - At this point, all existing imports of `VALID_TRANSITIONS` from `types.ts` still work.
4. **Modify `handler.ts`** to use `transitionByEvent()`.
   - Replace one section at a time: audio handling, processAudioBuffer, runLlmTtsPipeline, barge-in/cancel.
   - Run tests after each section.
5. **Delete `turn-machine.ts`** and `turn-machine.test.ts`.
6. **Copy `turn-fsm.ts` to client** and update `turnStore.ts`.
7. **Run full test suite** from both packages.

Each step is a separate commit.

## Risks

1. **Client build tooling.** Expo/Metro may not resolve path aliases smoothly. Mitigated by using Option C (copy) initially.
2. **Event semantics vs. state semantics.** Existing code thinks in "transition to state X"; the new API thinks in "event Y happened." Callers need to be updated to emit the right event. The mapping table above covers every case.
3. **Missing transitions.** The new TRANSITIONS table might miss a valid edge case that the old bypass-style code handled. Mitigated by comprehensive tests and the fact that handler-pipeline integration tests cover the observable behavior.
4. **Interaction with Plan 03 (Turn-as-object).** The Turn object will also call `transitionByEvent()`. The two plans are designed to compose: Plan 02 provides the pure function, Plan 03 wraps it in a lifecycle object. Plan 02 can land independently.
5. **Interaction with Plan 04 (Streaming STT).** Streaming STT will add new events (e.g., `PARTIAL_TRANSCRIPT`) and potentially new states. The event-driven table is easy to extend — just add rows. No structural conflict.
6. **Cross-review refinement (client-refactor).** Removed `BARGE_IN` from `listening` state. Barge-in is semantically "user interrupted the assistant" — only valid from `thinking` and `speaking`. During `listening`, the user is speaking; use `CANCEL` to abort. Client handles barge-in as two transitions: `BARGE_IN` (speaking->idle) then `AUDIO_START` (idle->listening). Client will NOT optimistically transition on local playback end — waits for server's `turn_state: idle` driven by `LLM_DONE`.
