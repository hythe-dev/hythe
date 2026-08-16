import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordMCPLatency, sloMonitor } from '../src/observability/slo.js';

describe('SLO latency alert lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
    sloMonitor.reset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    sloMonitor.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('expires latency evidence after the configured five-minute window', () => {
    for (let sample = 0; sample < 100; sample += 1) {
      recordMCPLatency(700);
    }

    sloMonitor.checkAllSLOs();
    expect(sloMonitor.getActiveAlerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'warning' }),
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'critical' }),
      ]),
    );

    vi.advanceTimersByTime(300_001);
    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual([]);
    expect(sloMonitor.getAlertHistory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sloName: 'mcp_latency',
          severity: 'critical',
          resolved: true,
          resolutionReason: 'insufficient_current_samples',
        }),
      ]),
    );
    expect(sloMonitor.getSLOStatus().mcp_latency).toMatchObject({
      healthy: true,
      sampleCount: 0,
      evidenceState: 'insufficient_data',
      windowSeconds: 300,
    });
  });

  it('does not claim a p99 result below its minimum sample count', () => {
    for (let sample = 0; sample < 20; sample += 1) {
      recordMCPLatency(700);
    }

    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual([
      expect.objectContaining({ sloName: 'mcp_latency', severity: 'warning' }),
    ]);
    expect(sloMonitor.getSLOStatus().mcp_latency).toMatchObject({
      evidenceState: 'current',
      sampleCount: 20,
      p95Ms: 700,
      p99Ms: undefined,
    });
  });

  it('uses nearest-rank p99 so one outlier among 100 samples is tolerated', () => {
    for (let sample = 0; sample < 99; sample += 1) {
      recordMCPLatency(100);
    }
    recordMCPLatency(700);

    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual([]);
    expect(sloMonitor.getSLOStatus().mcp_latency).toMatchObject({
      p95Ms: 100,
      p99Ms: 100,
      sampleCount: 100,
    });
  });

  it('raises p99 when more than one percent of a 100-sample window breaches', () => {
    for (let sample = 0; sample < 98; sample += 1) {
      recordMCPLatency(100);
    }
    recordMCPLatency(700);
    recordMCPLatency(900);

    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual([
      expect.objectContaining({
        sloName: 'mcp_latency',
        severity: 'critical',
        currentValue: 700,
        sampleCount: 100,
      }),
    ]);
  });

  it('retains at most 1,000 current samples as a safety bound', () => {
    for (let sample = 0; sample < 1_100; sample += 1) {
      recordMCPLatency(100);
    }

    expect(sloMonitor.getSLOStatus().mcp_latency).toMatchObject({
      sampleCount: 1_000,
      evidenceState: 'current',
    });
  });

  it('refreshes current alert evidence without reopening the alert', () => {
    for (let sample = 0; sample < 100; sample += 1) {
      recordMCPLatency(700);
    }
    sloMonitor.checkAllSLOs();
    const opened = sloMonitor.getActiveAlerts().find(alert => alert.severity === 'critical');

    vi.advanceTimersByTime(60_000);
    for (let sample = 0; sample < 100; sample += 1) {
      recordMCPLatency(900);
    }
    sloMonitor.checkAllSLOs();
    const refreshed = sloMonitor.getActiveAlerts().find(alert => alert.severity === 'critical');

    expect(opened).toBeDefined();
    expect(refreshed).toMatchObject({
      id: opened?.id,
      value: 700,
      currentValue: 900,
      sampleCount: 200,
    });
    expect(refreshed!.lastEvaluatedAt.getTime()).toBeGreaterThan(opened!.timestamp.getTime());
  });
});
