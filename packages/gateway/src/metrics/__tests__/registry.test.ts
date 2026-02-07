import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsRegistry, NOOP_METRICS } from '../registry.js';

describe('MetricsRegistry', () => {
  let metrics: MetricsRegistry;

  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  // -----------------------------------------------------------------------
  // Counters
  // -----------------------------------------------------------------------

  describe('counters', () => {
    it('increments by 1 by default', () => {
      metrics.increment('requests_total');
      metrics.increment('requests_total');
      const snap = metrics.snapshot();
      expect(snap.counters['requests_total']).toBe(2);
    });

    it('increments by custom delta', () => {
      metrics.increment('bytes_total', undefined, 1024);
      const snap = metrics.snapshot();
      expect(snap.counters['bytes_total']).toBe(1024);
    });

    it('supports labels', () => {
      metrics.increment('requests_total', { provider: 'kokoro', outcome: 'success' });
      metrics.increment('requests_total', { provider: 'kokoro', outcome: 'failure' });
      metrics.increment('requests_total', { provider: 'kokoro', outcome: 'success' });
      const snap = metrics.snapshot();
      expect(snap.counters['requests_total{outcome=success,provider=kokoro}']).toBe(2);
      expect(snap.counters['requests_total{outcome=failure,provider=kokoro}']).toBe(1);
    });

    it('sorts label keys alphabetically', () => {
      metrics.increment('test', { z: '1', a: '2' });
      const snap = metrics.snapshot();
      expect(snap.counters['test{a=2,z=1}']).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Gauges
  // -----------------------------------------------------------------------

  describe('gauges', () => {
    it('sets absolute value', () => {
      metrics.gauge('connections_active', 5);
      const snap = metrics.snapshot();
      expect(snap.gauges['connections_active']).toBe(5);
    });

    it('overwrites previous value', () => {
      metrics.gauge('connections_active', 5);
      metrics.gauge('connections_active', 3);
      const snap = metrics.snapshot();
      expect(snap.gauges['connections_active']).toBe(3);
    });

    it('supports labels', () => {
      metrics.gauge('circuit_state', 0, { provider: 'kokoro' });
      metrics.gauge('circuit_state', 1, { provider: 'openai' });
      const snap = metrics.snapshot();
      expect(snap.gauges['circuit_state{provider=kokoro}']).toBe(0);
      expect(snap.gauges['circuit_state{provider=openai}']).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Histograms
  // -----------------------------------------------------------------------

  describe('histograms', () => {
    it('tracks count, sum, min, max', () => {
      metrics.observe('latency_ms', 100);
      metrics.observe('latency_ms', 200);
      metrics.observe('latency_ms', 300);
      const snap = metrics.snapshot();
      const h = snap.histograms['latency_ms'];
      expect(h.count).toBe(3);
      expect(h.sum).toBe(600);
      expect(h.min).toBe(100);
      expect(h.max).toBe(300);
    });

    it('computes percentiles', () => {
      // Add 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        metrics.observe('latency_ms', i);
      }
      const snap = metrics.snapshot();
      const h = snap.histograms['latency_ms'];
      expect(h.p50).toBe(50);
      expect(h.p95).toBe(95);
      expect(h.p99).toBe(99);
    });

    it('handles single observation', () => {
      metrics.observe('latency_ms', 42);
      const snap = metrics.snapshot();
      const h = snap.histograms['latency_ms'];
      expect(h.count).toBe(1);
      expect(h.p50).toBe(42);
      expect(h.p95).toBe(42);
      expect(h.p99).toBe(42);
    });

    it('supports labels', () => {
      metrics.observe('request_ms', 50, { provider: 'kokoro' });
      metrics.observe('request_ms', 100, { provider: 'openai' });
      const snap = metrics.snapshot();
      expect(snap.histograms['request_ms{provider=kokoro}'].count).toBe(1);
      expect(snap.histograms['request_ms{provider=openai}'].count).toBe(1);
    });

    it('handles empty histogram gracefully', () => {
      const snap = metrics.snapshot();
      expect(Object.keys(snap.histograms)).toHaveLength(0);
    });

    it('evicts old values when buffer exceeds max', () => {
      for (let i = 0; i < 1100; i++) {
        metrics.observe('latency_ms', i);
      }
      const snap = metrics.snapshot();
      const h = snap.histograms['latency_ms'];
      expect(h.count).toBe(1100); // Total count preserved
      // But percentiles are computed from last 1000 values
      expect(h.min).toBe(0); // Global min preserved
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot format
  // -----------------------------------------------------------------------

  describe('snapshot', () => {
    it('includes timestamp and uptime', () => {
      const snap = metrics.snapshot();
      expect(snap.timestamp).toBeTruthy();
      expect(typeof snap.uptime_s).toBe('number');
    });

    it('returns empty collections when no metrics recorded', () => {
      const snap = metrics.snapshot();
      expect(snap.counters).toEqual({});
      expect(snap.gauges).toEqual({});
      expect(snap.histograms).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('clears all metrics', () => {
      metrics.increment('counter');
      metrics.gauge('gauge', 1);
      metrics.observe('hist', 100);
      metrics.reset();
      const snap = metrics.snapshot();
      expect(snap.counters).toEqual({});
      expect(snap.gauges).toEqual({});
      expect(snap.histograms).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // NOOP_METRICS
  // -----------------------------------------------------------------------

  describe('NOOP_METRICS', () => {
    it('accepts all calls without error', () => {
      NOOP_METRICS.increment('test');
      NOOP_METRICS.gauge('test', 1);
      NOOP_METRICS.observe('test', 100);
      const snap = NOOP_METRICS.snapshot();
      expect(snap.counters).toEqual({});
    });
  });
});
