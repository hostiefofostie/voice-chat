# Plan 08: Observability — Metrics & Structured Logging

**Date:** 2026-02-07
**Improvement:** #8 from audit report
**Author:** resilience agent

---

## Problem Statement

The gateway has zero metrics and zero tracing. Operators cannot answer basic questions:

- What is the end-to-end latency of a turn (user speaks -> assistant audio plays)?
- What is the STT processing time? LLM time-to-first-token? TTS synthesis time?
- How often do providers fail? How often does failover trigger?
- How many connections are active? What is the message throughput?
- What state is each circuit breaker in?

The only signals available are pino log lines, which are unstructured (no turn_id, no latency fields, no provider tags). Diagnosing issues requires grep-ing through logs and mentally reconstructing timelines.

## Solution: Lightweight In-Process Metrics + /metrics Endpoint

No external dependencies (no Prometheus, no StatsD, no OpenTelemetry SDK). A single `MetricsRegistry` class collects counters, gauges, and histograms in-process. A `/metrics` endpoint exposes the current snapshot as JSON. Structured logging is improved to include turn_id and latency fields.

### Architecture

```
                    ┌──────────────┐
  handler.ts ──────►│              │
  stt/router.ts ───►│   Metrics    │──── GET /metrics ───► JSON snapshot
  tts/router.ts ───►│   Registry   │
  tts/pipeline.ts ─►│              │
  llm/pipeline.ts ─►│  (singleton) │
                    └──────────────┘
```

Each module instruments itself by calling `metrics.increment()`, `metrics.observe()`, etc. The registry is a singleton created at server startup and passed to components via constructor injection (not a global import) to keep testability.

### Metric Types

**Counter** — Monotonically increasing value. Reset on process restart.
```typescript
interface Counter {
  name: string;
  labels: Record<string, string>;
  value: number;
}
```

**Gauge** — Point-in-time value. Can go up or down.
```typescript
interface Gauge {
  name: string;
  labels: Record<string, string>;
  value: number;
}
```

**Histogram** — Distribution of values. Tracks count, sum, min, max, p50, p95, p99.
```typescript
interface Histogram {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}
```

The histogram uses a simple sorted-insert approach on a bounded ring buffer (last 1000 observations). This is O(n) per insert but n is bounded and small. No external dependency needed.

### Metrics Catalog

#### Turn Latency (histograms, ms)

| Metric | Labels | Description |
|---|---|---|
| `turn_e2e_ms` | — | End-to-end: first audio frame received to last TTS chunk sent |
| `turn_stt_ms` | `provider` | Time from audio-complete to transcript available |
| `turn_llm_ttft_ms` | — | Time from transcript sent to first LLM token |
| `turn_llm_total_ms` | — | Time from transcript sent to LLM done |
| `turn_tts_first_chunk_ms` | `provider` | Time from first phrase ready to first TTS audio sent |
| `turn_tts_total_ms` | `provider` | Time from first phrase ready to TTS done |

#### Provider Health (counters + gauges)

| Metric | Labels | Description |
|---|---|---|
| `provider_requests_total` | `provider`, `outcome` | Total requests (outcome: success, failure) |
| `provider_request_ms` | `provider` | Request latency histogram |
| `provider_failover_total` | `from`, `to` | Number of failover events |
| `provider_circuit_state` | `provider` | Current circuit state (0=closed, 1=open, 2=half_open) |

#### Connection Stats (gauges + counters)

| Metric | Labels | Description |
|---|---|---|
| `ws_connections_active` | — | Current active WebSocket connections |
| `ws_connections_total` | — | Total connections since start |
| `ws_messages_total` | `direction`, `type` | Messages sent/received by type |
| `ws_audio_bytes_total` | `direction` | Audio bytes sent/received |

### MetricsRegistry Class

```
File: packages/gateway/src/metrics/registry.ts
```

```typescript
export class MetricsRegistry {
  private counters: Map<string, number>;
  private gauges: Map<string, number>;
  private histograms: Map<string, HistogramData>;

  /** Increment a counter. */
  increment(name: string, labels?: Record<string, string>, delta?: number): void;

  /** Set a gauge value. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;

  /** Record an observation in a histogram. */
  observe(name: string, value: number, labels?: Record<string, string>): void;

  /** Get a snapshot of all metrics. */
  snapshot(): MetricsSnapshot;

  /** Reset all metrics (for testing). */
  reset(): void;
}
```

**Label encoding:** Labels are encoded into the metric key as `name{label1=val1,label2=val2}`. This avoids nested maps while keeping the API simple. The snapshot output reconstructs the structured form.

**Snapshot format:**

```json
{
  "timestamp": "2026-02-07T14:30:00.000Z",
  "uptime_s": 3600,
  "counters": {
    "provider_requests_total{provider=kokoro,outcome=success}": 1234,
    "provider_requests_total{provider=kokoro,outcome=failure}": 5,
    "ws_connections_total": 42
  },
  "gauges": {
    "ws_connections_active": 3,
    "provider_circuit_state{provider=kokoro}": 0,
    "provider_circuit_state{provider=openai}": 0
  },
  "histograms": {
    "turn_e2e_ms": {
      "count": 100,
      "sum": 245000,
      "min": 1200,
      "max": 8500,
      "p50": 2100,
      "p95": 4200,
      "p99": 6800
    }
  }
}
```

### /metrics HTTP Endpoint

```
File: packages/gateway/src/server.ts (modification)
```

Add a `/metrics` route alongside the existing `/health` route:

```typescript
app.get('/metrics', async () => {
  return metrics.snapshot();
});
```

This returns JSON. No Prometheus exposition format in MVP. If Prometheus scraping is needed later, add a `/metrics/prometheus` endpoint that formats the same data.

### Instrumentation Points

The goal is to instrument existing code with minimal invasive changes. Each module receives a `MetricsRegistry` instance and calls it at key moments.

#### handler.ts — Connection & Turn Metrics

```typescript
// On WebSocket connect:
metrics.increment('ws_connections_total');
metrics.gauge('ws_connections_active', /* tracked via a module-level counter */);

// On WebSocket disconnect:
metrics.gauge('ws_connections_active', /* decrement */);

// On audio frame received:
metrics.increment('ws_audio_bytes_total', { direction: 'in' }, data.length);
metrics.increment('ws_messages_total', { direction: 'in', type: 'audio' });

// On JSON message received:
metrics.increment('ws_messages_total', { direction: 'in', type: msg.type });

// On JSON message sent:
metrics.increment('ws_messages_total', { direction: 'out', type: msg.type });

// On turn start (first audio in idle):
const turnStart = performance.now();

// On turn complete (idle transition after TTS done):
metrics.observe('turn_e2e_ms', performance.now() - turnStart);
```

**Implementation approach:** Wrap `sendMessage()` and `sendBinary()` to increment counters. Add a `turnStartedAt` field to `ConnectionState`. Compute and record stage latencies at each state transition.

#### stt/router.ts — Provider Metrics

```typescript
// In transcribe():
const start = performance.now();
try {
  const result = await this.primary.transcribe(audio);
  metrics.observe('provider_request_ms', performance.now() - start, { provider: 'parakeet' });
  metrics.increment('provider_requests_total', { provider: 'parakeet', outcome: 'success' });
  // ...
} catch {
  metrics.observe('provider_request_ms', performance.now() - start, { provider: 'parakeet' });
  metrics.increment('provider_requests_total', { provider: 'parakeet', outcome: 'failure' });
  // ...
}
```

#### tts/router.ts — Provider Metrics

Same pattern as STT. Additionally:
```typescript
// On provider switch:
metrics.increment('provider_failover_total', { from, to });
```

#### Circuit Breaker — State Gauge

```typescript
// On state change callback:
const stateToNum = { closed: 0, open: 1, half_open: 2 };
metrics.gauge('provider_circuit_state', stateToNum[newState], { provider: name });
```

#### llm/pipeline.ts — LLM Latency

```typescript
// On sendTranscript():
const llmStart = performance.now();

// On first token (onDelta first call):
if (firstToken) {
  metrics.observe('turn_llm_ttft_ms', performance.now() - llmStart);
}

// On llm_done:
metrics.observe('turn_llm_total_ms', performance.now() - llmStart);
```

#### tts/pipeline.ts — TTS Latency

```typescript
// On first processChunk():
const ttsStart = performance.now();

// On first audio sent to client:
if (firstChunkSent) {
  metrics.observe('turn_tts_first_chunk_ms', performance.now() - ttsStart);
}

// On finish():
metrics.observe('turn_tts_total_ms', performance.now() - ttsStart);
```

### Dependency Injection Strategy

The `MetricsRegistry` is created once in `server.ts` and passed down through constructors:

```
server.ts
  └─ creates MetricsRegistry
  └─ passes to registerWebSocket(app, metrics)
       └─ passes to new SttRouter(client, { metrics })
       └─ passes to new TtsRouter(kokoro, openai, 'kokoro', { metrics })
       └─ passes to new LlmPipeline(gateway, { metrics })
       └─ passes to new TtsPipeline({ ..., metrics })
```

Each module accepts an optional `metrics?: MetricsRegistry` parameter. If not provided, it uses a no-op stub. This means:
- Tests don't need to provide metrics (zero-cost in tests).
- No global singleton or import-time side effects.
- Easy to test metrics collection by providing a real registry and inspecting its snapshot.

### No-Op Stub

```typescript
export const NOOP_METRICS: MetricsRegistry = {
  increment: () => {},
  gauge: () => {},
  observe: () => {},
  snapshot: () => ({ timestamp: '', uptime_s: 0, counters: {}, gauges: {}, histograms: {} }),
  reset: () => {},
};
```

### Structured Logging Improvements

Currently, pino logs in handler.ts include `connId` but lack `turnId` and latency information. Add these fields:

```typescript
// Before:
app.log.info({ connId: conn.id }, 'Transcription complete');

// After:
app.log.info(
  { connId: conn.id, turnId, sttMs: elapsed, provider: conn.sttRouter.activeProvider },
  'Transcription complete',
);
```

Key logging improvements:
1. Add `turnId` to all log lines within a turn lifecycle.
2. Add `provider` to all STT/TTS log lines.
3. Add latency fields (`sttMs`, `llmTtftMs`, `ttsMs`) to completion log lines.
4. Add `circuitState` to provider error log lines.

These are pino-native structured fields — they appear in JSON output and can be queried with tools like `jq` or ingested by log aggregators.

## Testing Strategy

### Unit Tests for MetricsRegistry

```
File: packages/gateway/src/metrics/__tests__/registry.test.ts
```

- **Counter**: Increment, increment with labels, verify snapshot.
- **Gauge**: Set, update, verify snapshot.
- **Histogram**: Observe values, verify count/sum/min/max/percentiles.
- **Histogram percentiles**: Verify p50/p95/p99 with known distributions.
- **Label encoding**: Verify `name{k=v}` format in snapshot keys.
- **Reset**: Verify all metrics cleared.
- **Snapshot format**: Verify structure matches expected JSON shape.

### Integration Test for /metrics Endpoint

```
File: packages/gateway/src/__tests__/metrics-endpoint.test.ts
```

- Start Fastify with the metrics route registered.
- Make a few simulated requests.
- GET `/metrics` and verify the response shape and non-zero values.

### Metrics in Existing Tests

Since metrics are optional (no-op if not provided), existing tests continue to work without changes. New tests can provide a real `MetricsRegistry` and assert on specific metric values after operations.

Example pattern:
```typescript
it('records STT latency on successful transcription', async () => {
  const metrics = new MetricsRegistry();
  const router = new SttRouter(mockClient, { metrics });
  await router.transcribe(Buffer.alloc(100));

  const snap = metrics.snapshot();
  expect(snap.counters['provider_requests_total{provider=parakeet,outcome=success}']).toBe(1);
  expect(snap.histograms['provider_request_ms{provider=parakeet}'].count).toBe(1);
});
```

## Migration Steps

1. **Create `packages/gateway/src/metrics/registry.ts`** — The MetricsRegistry class with Counter, Gauge, Histogram support. No external dependencies.

2. **Create `packages/gateway/src/metrics/index.ts`** — Re-export the registry and NOOP_METRICS stub.

3. **Add unit tests** — `packages/gateway/src/metrics/__tests__/registry.test.ts`. Run and verify.

4. **Update `server.ts`** — Create a MetricsRegistry instance. Register the `/metrics` route. Pass metrics to `registerWebSocket()`.

5. **Update `handler.ts`** — Accept metrics parameter. Add connection counters. Add turn timing. Wrap `sendMessage`/`sendBinary` for message counters. Add turnId/latency to log lines.

6. **Update `stt/router.ts`** — Accept optional metrics. Record request counts and latencies.

7. **Update `tts/router.ts`** — Accept optional metrics. Record request counts, latencies, and failover events.

8. **Update `llm/pipeline.ts`** — Accept optional metrics. Record TTFT and total latency.

9. **Update `tts/pipeline.ts`** — Accept optional metrics. Record TTS first-chunk and total latency.

10. **Update circuit breakers** (from Plan 07) — Report state gauge on transitions.

11. **Add integration test** — Verify `/metrics` endpoint returns expected shape.

12. **Run full test suite** — `npm test` in `packages/gateway`. Verify all tests pass.

## Coordination with Plan 07 (Provider Failover)

Plan 07 introduces the CircuitBreaker class. This plan instruments it:
- Circuit state changes are reported as gauge metrics.
- Failover events are counted.
- Provider request latencies flow through the same metric paths regardless of which circuit breaker state triggered them.

The two plans should be implemented in order: Plan 07 first (CircuitBreaker), then Plan 08 (Metrics). Plan 08's instrumentation of circuit breakers depends on the `onStateChange` callback from Plan 07.

## Risks

- **Performance overhead.** Every request records several metrics. Mitigation: operations are O(1) for counters/gauges and O(n) for histogram inserts where n is bounded at 1000. In benchmarks of similar approaches, overhead is <0.1ms per operation.

- **Memory growth.** Histograms store up to 1000 values per metric. With ~20 histogram metrics, that is ~20K numbers. Negligible.

- **Constructor signature changes.** Every module's constructor gains an optional `metrics` parameter. Mitigation: parameter is optional with a no-op default. Existing call sites work without changes. Only `handler.ts` and `server.ts` need updates to pass the real registry.

- **Percentile accuracy.** The simple sorted-array approach gives exact percentiles for the last 1000 observations, but not true streaming percentiles. For an MVP with low traffic, this is fine. If traffic grows, switch to a t-digest or HDR histogram library.

- **Snapshot cost.** Computing percentiles requires sorting the histogram buffer. With 1000 elements, this is ~0.1ms. If `/metrics` is polled frequently (>1/sec), consider caching the snapshot for 1 second.

- **Log verbosity.** Adding fields to log lines increases log volume slightly. Mitigation: fields are structured (no extra text), so log size increase is proportional to field count, not message length.
