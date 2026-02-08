# Plan 07: Provider Failover — Circuit Breaker Pattern

**Date:** 2026-02-07
**Improvement:** #7 from audit report
**Author:** resilience agent

---

## Problem Statement

The current provider failover has several critical flaws:

1. **One-directional failover.** `SttRouter` switches from Parakeet to a cloud stub after 3 consecutive failures, but the cloud "fallback" returns a hardcoded `[STT unavailable]` string — it is not a real provider. `TtsRouter` switches between Kokoro and OpenAI, but only in one direction per trigger (it toggles, but has no structured recovery).

2. **Fake health checks.** `TtsRouter.healthCheck()` returns `Promise.resolve(true)` for OpenAI — it never actually verifies the endpoint. `SttRouter` has a real Parakeet health check but runs it on a fixed 15-second interval with no backoff.

3. **No exponential backoff.** Both routers retry immediately on failure. There is no delay, jitter, or backoff between failures. A flaky provider gets hammered with requests.

4. **No per-request fallback.** `TtsPipeline.synthesizeAndQueue()` calls `ttsRouter.synthesize()` once. If it fails, the chunk is dropped and an error event is emitted. There is no attempt to retry with the alternate provider for that specific chunk.

5. **Stub cloud STT.** The `cloudFallback()` method in `SttRouter` returns a hardcoded string. The spec calls for Deepgram integration, but it was never built. While building a full Deepgram client is out of scope here, the architecture should make adding one trivial.

## Solution: Generic Circuit Breaker

Replace the ad-hoc failure counting in both routers with a proper circuit breaker pattern. This gives us structured state management, automatic recovery probing, and configurable thresholds — all in one reusable class.

### Circuit Breaker State Machine

```
             success / below threshold
            ┌───────────────────────┐
            │                       │
            ▼        failure >= N   │
        ┌────────┐ ──────────────► ┌──────┐
        │ CLOSED │                 │ OPEN │
        └────────┘ ◄────────────── └──────┘
            ▲      probe succeeds     │
            │                         │ after cooldown
            │      probe fails    ┌───────────┐
            └──────────────────── │ HALF_OPEN │
                                  └───────────┘
```

**States:**
- **CLOSED** — Normal operation. Requests pass through. Failures are counted within a sliding time window. When failures reach the threshold within the window, transition to OPEN.
- **OPEN** — Provider is considered down. All requests fail immediately (fast-fail) without hitting the provider. After a cooldown period, transition to HALF_OPEN.
- **HALF_OPEN** — One probe request is allowed through. If it succeeds, transition to CLOSED. If it fails, transition back to OPEN with an increased cooldown (exponential backoff).

### Generic CircuitBreaker Class

```
File: packages/gateway/src/common/circuit-breaker.ts
```

```typescript
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Name for logging/metrics. */
  name: string;
  /** Number of failures within `windowMs` to trip the breaker. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). */
  windowMs: number;
  /** Initial cooldown before entering half_open (ms). */
  cooldownMs: number;
  /** Maximum cooldown after repeated probe failures (ms). */
  maxCooldownMs: number;
  /** Backoff multiplier for cooldown on repeated probe failures. */
  backoffMultiplier: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  name: 'unnamed',
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 5_000,
  maxCooldownMs: 120_000,
  backoffMultiplier: 2,
};
```

**Public API:**
- `state: CircuitState` — Current state (read-only).
- `recordSuccess(): void` — Record a successful call. Resets failure count in CLOSED. Transitions HALF_OPEN to CLOSED.
- `recordFailure(): void` — Record a failed call. Increments failure count. May transition CLOSED to OPEN or HALF_OPEN back to OPEN.
- `canRequest(): boolean` — Returns true if a request should be allowed (CLOSED always, HALF_OPEN for one probe, OPEN never).
- `onStateChange(listener): void` — Subscribe to state transitions for logging/metrics.
- `destroy(): void` — Clear internal timers.

**Internal mechanics:**
- Failures stored as timestamps in an array, pruned to `windowMs` on each `recordFailure()`.
- OPEN state uses a `setTimeout` to transition to HALF_OPEN after `cooldownMs`.
- HALF_OPEN allows exactly one request (tracked with a `probeInFlight` boolean).
- Each time a probe fails, `currentCooldownMs` is multiplied by `backoffMultiplier`, capped at `maxCooldownMs`.
- On probe success, `currentCooldownMs` resets to the base `cooldownMs`.
- Jitter: cooldown timers add random jitter of +/-15% to avoid thundering herd.

### Updated SttRouter

```
File: packages/gateway/src/stt/router.ts
```

Replace the manual `consecutiveFailures` counter and `healthCheckInterval` with a `CircuitBreaker` instance:

```typescript
export class SttRouter extends EventEmitter {
  private primary: ParakeetClient;
  private breaker: CircuitBreaker;

  constructor(primary: ParakeetClient, config?: Partial<CircuitBreakerConfig>) {
    super();
    this.primary = primary;
    this.breaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'stt:parakeet',
      failureThreshold: 3,
      cooldownMs: 10_000,
      ...config,
    });
    this.breaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'parakeet', from, to });
    });
  }

  get activeProvider(): string {
    return this.breaker.state === 'open' ? 'cloud_stub' : 'parakeet';
  }

  get circuitState(): CircuitState {
    return this.breaker.state;
  }

  async transcribe(audio: Buffer): Promise<TranscribeResult> {
    // If breaker is open, fast-fail to fallback
    if (!this.breaker.canRequest()) {
      return this.cloudFallback(audio);
    }

    try {
      const result = await this.primary.transcribe(audio);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      // If breaker just tripped open, use fallback for this request
      if (!this.breaker.canRequest()) {
        return this.cloudFallback(audio);
      }
      throw err;
    }
  }

  // cloudFallback unchanged — still a stub for now.
  // The interface is ready for a real Deepgram client to be injected.

  destroy() {
    this.breaker.destroy();
  }
}
```

**Key changes from current code:**
- No more `consecutiveFailures` counter or `healthCheckInterval`.
- The circuit breaker handles cooldown timing, probe scheduling, and backoff internally.
- Health check probing happens automatically in HALF_OPEN state — when the breaker transitions to HALF_OPEN, the next `transcribe()` call is the probe. If it succeeds, the breaker closes. This means recovery is demand-driven (only probes when there is actual traffic), which is better than a blind `setInterval`.
- `activeProvider` is derived from breaker state, not a boolean flag.

### Updated TtsRouter

```
File: packages/gateway/src/tts/router.ts
```

Replace the manual `failures[]` array with two circuit breakers (one per provider):

```typescript
export class TtsRouter extends EventEmitter {
  private kokoro: KokoroClient;
  private openai: OpenAiTtsClient;
  private preferredProvider: 'kokoro' | 'openai';
  private kokoroBreaker: CircuitBreaker;
  private openaiBreaker: CircuitBreaker;

  constructor(
    kokoro: KokoroClient,
    openai: OpenAiTtsClient,
    defaultProvider: 'kokoro' | 'openai' = 'kokoro',
    config?: Partial<CircuitBreakerConfig>,
  ) {
    super();
    this.kokoro = kokoro;
    this.openai = openai;
    this.preferredProvider = defaultProvider;
    this.kokoroBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:kokoro',
      ...config,
    });
    this.openaiBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_CONFIG,
      name: 'tts:openai',
      cooldownMs: 15_000, // OpenAI is cloud, longer cooldown
      ...config,
    });
    // Forward state change events
    this.kokoroBreaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'kokoro', from, to });
    });
    this.openaiBreaker.onStateChange((from, to) => {
      this.emit('circuit_state', { provider: 'openai', from, to });
    });
  }

  get provider(): 'kokoro' | 'openai' {
    return this.preferredProvider;
  }

  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; provider: string }> {
    const primary = this.preferredProvider;
    const fallback = primary === 'kokoro' ? 'openai' : 'kokoro';

    // Try preferred provider
    const primaryResult = await this.tryProvider(primary, text, voice);
    if (primaryResult) return primaryResult;

    // Preferred provider failed or circuit is open — try fallback
    const fallbackResult = await this.tryProvider(fallback, text, voice);
    if (fallbackResult) return fallbackResult;

    // Both providers unavailable
    throw new Error(`All TTS providers unavailable (${primary} and ${fallback})`);
  }

  private async tryProvider(
    name: 'kokoro' | 'openai',
    text: string,
    voice?: string,
  ): Promise<{ audio: Buffer; provider: string } | null> {
    const breaker = name === 'kokoro' ? this.kokoroBreaker : this.openaiBreaker;
    const client = name === 'kokoro' ? this.kokoro : this.openai;
    const defaultVoice = name === 'kokoro' ? 'af_heart' : 'cedar';

    if (!breaker.canRequest()) return null;

    try {
      const audio = await client.synthesize(text, voice || defaultVoice);
      breaker.recordSuccess();
      return { audio, provider: name };
    } catch {
      breaker.recordFailure();
      return null;
    }
  }

  async healthCheck(): Promise<{ kokoro: boolean; openai: boolean }> {
    const [k, o] = await Promise.all([
      this.kokoro.healthCheck(),
      this.checkOpenAi(),
    ]);
    return { kokoro: k, openai: o };
  }

  /** Real health check for OpenAI — synthesize a short test phrase. */
  private async checkOpenAi(): Promise<boolean> {
    try {
      await this.openai.synthesize('.', 'cedar');
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this.kokoroBreaker.destroy();
    this.openaiBreaker.destroy();
  }
}
```

**Key changes from current code:**
- Per-provider circuit breakers instead of a shared `failures[]` array.
- `synthesize()` tries preferred first, then fallback — per-request fallback, not a global switch.
- `preferredProvider` is now a user preference (set via `/tts` command), not automatically flipped on failure. The circuit breaker handles availability; the preference handles intent.
- Real OpenAI health check via synthesizing a minimal string (this is optional and only called from `healthCheck()`, not on every request).
- Both breakers have independent state — if Kokoro is open but OpenAI is closed, requests go to OpenAI. If both are open, the error is immediate.

### Per-Chunk Retry in TtsPipeline

```
File: packages/gateway/src/tts/pipeline.ts
```

Currently, `synthesizeAndQueue()` calls `ttsRouter.synthesize()` once. With the updated TtsRouter doing per-request fallback internally, no changes are needed in TtsPipeline for basic fallback. However, we add a simple single retry for transient errors:

```typescript
private async synthesizeAndQueue(text: string, index: number) {
  const gen = this.generation;
  try {
    const { audio } = await this.ttsRouter.synthesize(text);
    if (gen !== this.generation) return;
    this.completedAudio.set(index, audio);
    this.inFlight--;
    this.sendInOrder();
    await this.dispatch();
  } catch (err) {
    if (gen !== this.generation) return;
    // The TtsRouter already tried the fallback provider internally.
    // If we get here, both providers failed for this chunk.
    this.inFlight--;
    this.emit('error', err);
  }
}
```

No retry loop here — the TtsRouter's `synthesize()` already tries both providers. If both fail, the chunk is dropped and an error is emitted. This keeps the pipeline simple.

### Configuration Defaults

| Parameter | STT (Parakeet) | TTS (Kokoro) | TTS (OpenAI) |
|---|---|---|---|
| `failureThreshold` | 3 | 3 | 3 |
| `windowMs` | 60,000 | 60,000 | 60,000 |
| `cooldownMs` | 10,000 | 5,000 | 15,000 |
| `maxCooldownMs` | 120,000 | 120,000 | 120,000 |
| `backoffMultiplier` | 2 | 2 | 2 |

Rationale: Kokoro is local (fast recovery expected), so shorter initial cooldown. OpenAI is remote with rate limits, so longer cooldown. STT is in between because Parakeet is local but heavier than Kokoro.

### Real Health Checks

| Provider | Current Health Check | New Health Check |
|---|---|---|
| Parakeet | `GET /health` (real) | `GET /health` (unchanged) |
| Kokoro | `GET /health` (real) | `GET /health` (unchanged) |
| OpenAI TTS | `Promise.resolve(true)` (fake) | Short synthesis call `.synthesize('.', 'cedar')` |

The OpenAI health check is only invoked from the explicit `healthCheck()` method (called by the `/health` route or diagnostics), not on every request. The circuit breaker's half-open probe uses actual `synthesize()` calls as the implicit health check.

## Testing Strategy

### Unit Tests for CircuitBreaker

```
File: packages/gateway/src/common/__tests__/circuit-breaker.test.ts
```

- **CLOSED state**: Stays closed when failures are below threshold. Resets on success.
- **CLOSED -> OPEN**: Transitions when failures reach threshold within window.
- **Failure window expiration**: Old failures age out, preventing false trips.
- **OPEN state**: `canRequest()` returns false. No requests pass through.
- **OPEN -> HALF_OPEN**: Transitions after cooldown timer fires.
- **HALF_OPEN probe success**: Transitions back to CLOSED.
- **HALF_OPEN probe failure**: Transitions back to OPEN with increased cooldown.
- **Exponential backoff**: Cooldown doubles on each probe failure, capped at max.
- **Jitter**: Cooldown timers are not exactly deterministic (test range).
- **destroy()**: Clears all timers.
- **onStateChange**: Listener is called on every transition.

### Updated Router Tests

Update existing tests in `stt-router.test.ts` and `tts-router.test.ts`:
- Verify circuit breaker state transitions through the router API.
- Verify per-request fallback in TtsRouter (preferred fails, fallback succeeds).
- Verify both-providers-down behavior.
- Verify `healthCheck()` calls real OpenAI check.
- Verify `destroy()` cleans up circuit breaker timers.

### Integration-Level Tests

- Simulate flaky Kokoro (fails intermittently) and verify chunks are routed to OpenAI for individual failures without globally switching.
- Simulate Parakeet going down and coming back: verify CLOSED -> OPEN -> HALF_OPEN -> CLOSED cycle.

## Migration Steps

1. **Create `packages/gateway/src/common/circuit-breaker.ts`** — The generic CircuitBreaker class. No dependencies on existing code.

2. **Add unit tests for CircuitBreaker** — `packages/gateway/src/common/__tests__/circuit-breaker.test.ts`. Run and verify.

3. **Update `SttRouter`** — Replace `consecutiveFailures` + `healthCheckInterval` with a CircuitBreaker instance. Update constructor signature to accept optional config. Preserve the `destroy()` method (now delegates to breaker). Preserve `activeProvider` getter semantics. Preserve `provider_switched`/`provider_recovered` events (map them from circuit state changes).

4. **Update `TtsRouter`** — Replace `failures[]` array with two CircuitBreaker instances. Change `synthesize()` to try preferred then fallback. Keep `setProvider()` for user preference. Replace fake OpenAI health check. Add `destroy()` method. Preserve event emissions.

5. **Update existing tests** — Adjust `stt-router.test.ts`, `tts-router.test.ts`, `tts-router-advanced.test.ts` for the new API. The external behavior (failover after N failures, recovery) should be similar, but the internal mechanism changes.

6. **Update handler.ts** — Minimal changes. The `SttRouter` and `TtsRouter` constructors change slightly (optional config parameter). Add `ttsRouter.destroy()` to the socket `close` handler (currently missing).

7. **Run full test suite** — `npm test` in `packages/gateway`. Verify all tests pass.

## Risks

- **Breaking existing tests.** The `SttRouter` and `TtsRouter` APIs change slightly (constructor parameters, event names). Mitigation: update tests in the same commit. Keep backward-compatible event aliases if needed.

- **Timer leaks.** The circuit breaker uses `setTimeout` for cooldown. If `destroy()` is not called, timers leak. Mitigation: ensure `destroy()` is called in the `close` handler for WebSocket connections.

- **OpenAI health check cost.** Synthesizing a test phrase costs money and adds latency. Mitigation: only used in the explicit `healthCheck()` method, not in hot paths. Consider caching the result for 60 seconds.

- **Behavioral change in TTS fallback.** Currently, TtsRouter globally switches providers after 3 failures. The new design tries both per-request. This is a behavioral improvement but could surprise existing tests. Mitigation: update tests to expect the new behavior.

- **No real cloud STT.** The circuit breaker improves the failover structure, but STT fallback is still a stub. Adding Deepgram is separate work. Mitigation: the architecture makes it easy — just inject a real client that implements `transcribe(audio: Buffer): Promise<TranscribeResult>`.
