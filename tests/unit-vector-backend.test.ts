import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from '../src/unified-server/memory/index.js';
import { SqliteVecClient } from '../src/memory/sqlite-vec-client.js';
import { MetricNames, metrics } from '../src/observability/metrics.js';
import { sloMonitor } from '../src/observability/slo.js';

const originalAdvancedMemory = process.env.ENABLE_ADVANCED_MEMORY;

describe('sqlite-vec backend truth and degradation lifecycle', () => {
  beforeEach(() => {
    metrics.reset();
    sloMonitor.reset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    metrics.reset();
    sloMonitor.reset();
    if (originalAdvancedMemory === undefined) {
      delete process.env.ENABLE_ADVANCED_MEMORY;
    } else {
      process.env.ENABLE_ADVANCED_MEMORY = originalAdvancedMemory;
    }
  });

  it('reports the established SQLite-only state when advanced memory is disabled', async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const manager = new MemoryManager(':memory:');

    try {
      const status = await manager.getSystemStatus();
      expect(status.advancedSystemsEnabled).toBe(false);
      expect(status.vector.connected).toBe(false);
      expect(status.weaviate.connected).toBe(status.vector.connected);
      expect(metrics.getCounter(MetricNames.VECTOR_FALLBACK_TOTAL)).toBe(1);
      expect(metrics.getGauge(MetricNames.VECTOR_CONNECTED)).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it('records one truthful fallback when sqlite-vec initialization fails', async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const manager = new MemoryManager(':memory:');
    metrics.reset();

    vi.spyOn(SqliteVecClient.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('injected sqlite-vec failure'));
    process.env.ENABLE_ADVANCED_MEMORY = 'true';

    try {
      await (manager as any).initializeAdvancedSystems();
      expect(metrics.getCounter(MetricNames.VECTOR_FALLBACK_TOTAL)).toBe(1);
      expect(metrics.getGauge(MetricNames.VECTOR_CONNECTED)).toBe(0);

      const fallbackEvents = metrics
        .getRecentEvents(20, 'systems', 'warn')
        .filter((event) => event.message === 'sqlite-vec unavailable - using SQLite-only mode');
      expect(fallbackEvents).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  it('resolves degradation after recovery while retaining the cumulative fallback count', async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const manager = new MemoryManager(':memory:');
    metrics.reset();

    const initialize = vi.spyOn(SqliteVecClient.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('injected sqlite-vec failure'))
      .mockResolvedValueOnce(undefined);
    process.env.ENABLE_ADVANCED_MEMORY = 'true';

    try {
      await (manager as any).initializeAdvancedSystems();
      sloMonitor.checkAllSLOs();
      expect(sloMonitor.getActiveAlerts()).toEqual([
        expect.objectContaining({ sloName: 'vector_fallback', severity: 'critical' }),
      ]);

      await (manager as any).initializeAdvancedSystems();
      sloMonitor.checkAllSLOs();

      expect(initialize).toHaveBeenCalledTimes(2);
      expect(metrics.getGauge(MetricNames.VECTOR_CONNECTED)).toBe(1);
      expect(metrics.getCounter(MetricNames.VECTOR_FALLBACK_TOTAL)).toBe(1);
      expect(sloMonitor.getActiveAlerts()).toEqual([]);
      expect(sloMonitor.getAlertHistory()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sloName: 'vector_fallback',
            resolved: true,
            resolutionReason: 'vector_backend_recovered',
          }),
        ]),
      );
    } finally {
      await manager.close();
    }
  });

  it('exports truthful vector metrics without ghost backend metrics', () => {
    const output = metrics.toPrometheusFormat();
    expect(output).toContain('vector_connected_info');
    expect(output).toContain('vector_fallback_total');
    expect(output).not.toContain('weaviate_');
    expect(output).not.toContain('neo4j_');
  });
});
