import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordMCPLatency, sloMonitor } from '../src/observability/slo.js';

describe('SLO latency alert lifecycle', () => {
  beforeEach(() => {
    sloMonitor.reset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    sloMonitor.reset();
    vi.restoreAllMocks();
  });

  it('clears p95 warning and p99 critical alerts after latency recovers', () => {
    for (let sample = 0; sample < 10; sample += 1) {
      recordMCPLatency(700);
    }

    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'warning' }),
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'critical' }),
      ]),
    );
    expect(sloMonitor.getActiveAlerts()).toHaveLength(2);

    for (let sample = 0; sample < 1000; sample += 1) {
      recordMCPLatency(100);
    }

    sloMonitor.checkAllSLOs();

    expect(sloMonitor.getActiveAlerts()).toEqual([]);
    expect(sloMonitor.getAlertHistory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'warning', resolved: true }),
        expect.objectContaining({ sloName: 'mcp_latency', severity: 'critical', resolved: true }),
      ]),
    );
  });
});
