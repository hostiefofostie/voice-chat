// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistogramData {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[];
}

export interface MetricsSnapshot {
  timestamp: string;
  uptime_s: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, {
    count: number;
    sum: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  }>;
}

// ---------------------------------------------------------------------------
// MetricsRegistry
// ---------------------------------------------------------------------------

const MAX_HISTOGRAM_VALUES = 1000;

function labelKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${name}{${parts}}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, HistogramData>();
  private startedAt = Date.now();

  /** Increment a counter by delta (default 1). */
  increment(name: string, labels?: Record<string, string>, delta: number = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = labelKey(name, labels);
    this.gauges.set(key, value);
  }

  /** Record a histogram observation. */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = labelKey(name, labels);
    let h = this.histograms.get(key);
    if (!h) {
      h = { count: 0, sum: 0, min: Infinity, max: -Infinity, values: [] };
      this.histograms.set(key, h);
    }
    h.count++;
    h.sum += value;
    if (value < h.min) h.min = value;
    if (value > h.max) h.max = value;
    h.values.push(value);
    // Evict oldest values when buffer is full
    if (h.values.length > MAX_HISTOGRAM_VALUES) {
      h.values.shift();
    }
  }

  /** Get a snapshot of all metrics. */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;

    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;

    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [k, h] of this.histograms) {
      const sorted = [...h.values].sort((a, b) => a - b);
      histograms[k] = {
        count: h.count,
        sum: h.sum,
        min: h.min === Infinity ? 0 : h.min,
        max: h.max === -Infinity ? 0 : h.max,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      };
    }

    return {
      timestamp: new Date().toISOString(),
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      counters,
      gauges,
      histograms,
    };
  }

  /** Reset all metrics. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.startedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// No-op stub for optional injection
// ---------------------------------------------------------------------------

export const NOOP_METRICS: MetricsRegistry = {
  increment() {},
  gauge() {},
  observe() {},
  snapshot() {
    return { timestamp: '', uptime_s: 0, counters: {}, gauges: {}, histograms: {} };
  },
  reset() {},
} as unknown as MetricsRegistry;
