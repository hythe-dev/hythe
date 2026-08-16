/**
 * SLO (Service Level Objectives) Configuration and Alerting
 * Phase 4: Encode SLOs and wire alert thresholds
 *
 * SLOs defined:
 * - MCP: p95 <300ms, p99 <600ms
 * - WebSocket fan-out: p95 <200ms
 * - Memory read: p95 <250ms
 * - Memory write: p95 <400ms
 * - Availability: 99.9%
 * - Vector availability: alert while sqlite-vec is unavailable
 */

import { metrics, MetricNames } from './metrics.js';

// ============================================================================
// SLO CONFIGURATION
// ============================================================================

export interface SLOThreshold {
  name: string;
  description: string;
  p95Ms?: number;
  p99Ms?: number;
  minP95Samples?: number;
  minP99Samples?: number;
  maxCount?: number;  // For error/fallback counts
  windowSeconds: number;
}

export const SLOConfig: Record<string, SLOThreshold> = {
  MCP_LATENCY: {
    name: 'mcp_latency',
    description: 'MCP request latency',
    p95Ms: 300,
    p99Ms: 600,
    minP95Samples: 20,
    minP99Samples: 100,
    windowSeconds: 300  // 5-minute window
  },
  WS_FANOUT_LATENCY: {
    name: 'ws_fanout_latency',
    description: 'WebSocket fan-out latency',
    p95Ms: 200,
    minP95Samples: 20,
    windowSeconds: 300
  },
  MEMORY_READ_LATENCY: {
    name: 'memory_read_latency',
    description: 'Memory read operation latency',
    p95Ms: 250,
    minP95Samples: 20,
    windowSeconds: 300
  },
  MEMORY_WRITE_LATENCY: {
    name: 'memory_write_latency',
    description: 'Memory write operation latency',
    p95Ms: 400,
    minP95Samples: 20,
    windowSeconds: 300
  },
  VECTOR_FALLBACK: {
    name: 'vector_fallback',
    description: 'sqlite-vec availability',
    maxCount: 0,
    windowSeconds: 60
  },
  AVAILABILITY: {
    name: 'availability',
    description: 'Service availability target 99.9%',
    windowSeconds: 86400  // Daily window
  }
};

// ============================================================================
// ALERT TYPES
// ============================================================================

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  sloName: string;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
  currentValue: number;
  lastEvaluatedAt: Date;
  sampleCount: number;
  windowStartedAt?: Date;
  resolved: boolean;
  resolvedAt?: Date;
  resolutionReason?: string;
}

interface LatencySample {
  value: number;
  observedAtMs: number;
}

interface AlertEvaluation {
  currentValue: number;
  evaluatedAt: Date;
  sampleCount: number;
  windowStartedAt?: Date;
}

export interface SLOStatus {
  healthy: boolean;
  value?: number;
  threshold?: number;
  p95Ms?: number;
  p99Ms?: number;
  p95ThresholdMs?: number;
  p99ThresholdMs?: number;
  sampleCount?: number;
  windowSeconds?: number;
  evidenceState?: 'current' | 'insufficient_data';
  oldestSampleAt?: Date;
  newestSampleAt?: Date;
}

// ============================================================================
// SLO MONITOR
// ============================================================================

class SLOMonitor {
  private alerts: Map<string, Alert> = new Map();
  private alertCallbacks: Array<(alert: Alert) => void> = [];
  private latencyBuffers: Map<string, LatencySample[]> = new Map();
  private readonly maxBufferSize = 1000;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize latency buffers
    for (const key of Object.keys(SLOConfig)) {
      if (SLOConfig[key].p95Ms || SLOConfig[key].p99Ms) {
        this.latencyBuffers.set(SLOConfig[key].name, []);
      }
    }
  }

  /**
   * Start periodic SLO checking
   */
  start(intervalMs: number = 60000): void {
    if (this.checkInterval) return;

    console.log('📊 Starting SLO monitor with interval:', intervalMs, 'ms');
    this.checkInterval = setInterval(() => this.checkAllSLOs(), intervalMs);
  }

  /**
   * Stop periodic SLO checking
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('📊 SLO monitor stopped');
    }
  }

  /**
   * Register alert callback
   */
  onAlert(callback: (alert: Alert) => void): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Record a latency observation for SLO tracking
   */
  recordLatency(sloName: string, latencyMs: number): void {
    const buffer = this.latencyBuffers.get(sloName);
    if (buffer) {
      const nowMs = Date.now();
      buffer.push({ value: latencyMs, observedAtMs: nowMs });
      const config = Object.values(SLOConfig).find(candidate => candidate.name === sloName);
      if (config) {
        this.pruneLatencyBuffer(buffer, config, nowMs);
      }
      // Keep buffer bounded
      if (buffer.length > this.maxBufferSize) {
        buffer.splice(0, buffer.length - this.maxBufferSize);
      }
    }

    // Also record in metrics histogram
    const metricName = this.getMetricName(sloName);
    if (metricName) {
      metrics.observe(metricName, latencyMs);
    }
  }

  /**
   * Check all SLOs and fire alerts as needed
   */
  checkAllSLOs(): void {
    // Check latency SLOs
    for (const [key, config] of Object.entries(SLOConfig)) {
      if (config.p95Ms || config.p99Ms) {
        this.checkLatencySLO(config);
      }
    }

    // Check current backend availability and cumulative Redis fallback events.
    this.checkFallbackSLO();

    // Check availability
    this.checkAvailabilitySLO();
  }

  /**
   * Check a latency-based SLO
   */
  private checkLatencySLO(config: SLOThreshold): void {
    const buffer = this.latencyBuffers.get(config.name);
    if (!buffer) return;

    const nowMs = Date.now();
    this.pruneLatencyBuffer(buffer, config, nowMs);
    const sorted = buffer.map(sample => sample.value).sort((a, b) => a - b);
    const evaluatedAt = new Date(nowMs);
    const windowStartedAt = buffer[0] ? new Date(buffer[0].observedAtMs) : undefined;

    // Check p95
    const minP95Samples = config.minP95Samples ?? 20;
    if (config.p95Ms && sorted.length >= minP95Samples) {
      const p95 = this.nearestRank(sorted, 0.95);
      if (p95 > config.p95Ms) {
        this.fireAlert({
          sloName: config.name,
          severity: 'warning',
          message: `${config.description} p95 (${p95.toFixed(0)}ms) exceeds threshold (${config.p95Ms}ms)`,
          value: p95,
          threshold: config.p95Ms
        }, {
          currentValue: p95,
          evaluatedAt,
          sampleCount: sorted.length,
          windowStartedAt,
        });
      } else {
        this.resolveAlert(`${config.name}_warning`, 'current_window_recovered');
      }
    } else if (config.p95Ms) {
      this.resolveAlert(`${config.name}_warning`, 'insufficient_current_samples');
    }

    // Check p99
    const minP99Samples = config.minP99Samples ?? 100;
    if (config.p99Ms && sorted.length >= minP99Samples) {
      const p99 = this.nearestRank(sorted, 0.99);
      if (p99 > config.p99Ms) {
        this.fireAlert({
          sloName: config.name,
          severity: 'critical',
          message: `${config.description} p99 (${p99.toFixed(0)}ms) exceeds threshold (${config.p99Ms}ms)`,
          value: p99,
          threshold: config.p99Ms
        }, {
          currentValue: p99,
          evaluatedAt,
          sampleCount: sorted.length,
          windowStartedAt,
        });
      } else {
        this.resolveAlert(`${config.name}_critical`, 'current_window_recovered');
      }
    } else if (config.p99Ms) {
      this.resolveAlert(`${config.name}_critical`, 'insufficient_current_samples');
    }
  }

  private pruneLatencyBuffer(
    buffer: LatencySample[],
    config: SLOThreshold,
    nowMs: number,
  ): void {
    const cutoffMs = nowMs - config.windowSeconds * 1000;
    let firstCurrentIndex = 0;
    while (
      firstCurrentIndex < buffer.length
      && buffer[firstCurrentIndex].observedAtMs < cutoffMs
    ) {
      firstCurrentIndex += 1;
    }
    if (firstCurrentIndex > 0) {
      buffer.splice(0, firstCurrentIndex);
    }
  }

  private nearestRank(sorted: number[], percentile: number): number {
    const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
    return sorted[index];
  }

  /** Check current backend availability. Cumulative counters are telemetry only. */
  private checkFallbackSLO(): void {
    const vectorConnected = metrics.getGauge(MetricNames.VECTOR_CONNECTED);
    const fallbackCount = metrics.getCounter(MetricNames.VECTOR_FALLBACK_TOTAL);

    if (vectorConnected !== 1) {
      this.fireAlert({
        sloName: 'vector_fallback',
        severity: 'critical',
        message: `sqlite-vec unavailable; running in SQLite-only mode (${fallbackCount} fallback events).`,
        value: vectorConnected,
        threshold: 1
      });
    } else {
      this.resolveAlert('vector_fallback_critical', 'vector_backend_recovered');
    }

    const redisFallback = metrics.getCounter(MetricNames.REDIS_FALLBACK_TOTAL);

    if (redisFallback > 0) {
      this.fireAlert({
        sloName: 'redis_fallback',
        severity: 'warning',
        message: `Redis fallback detected (${redisFallback} events)`,
        value: redisFallback,
        threshold: 0
      });
    }

  }

  /**
   * Check availability SLO (99.9%)
   */
  private checkAvailabilitySLO(): void {
    const totalRequests = metrics.getCounter(MetricNames.API_REQUESTS_TOTAL);
    const totalErrors = metrics.getCounter(MetricNames.API_ERRORS_TOTAL);

    if (totalRequests < 100) return; // Need minimum samples

    const errorRate = totalErrors / totalRequests;
    const availability = (1 - errorRate) * 100;

    if (availability < 99.9) {
      this.fireAlert({
        sloName: 'availability',
        severity: availability < 99 ? 'critical' : 'warning',
        message: `Availability (${availability.toFixed(2)}%) below target (99.9%)`,
        value: availability,
        threshold: 99.9
      });
    } else {
      this.resolveAlert('availability');
    }
  }

  /**
   * Fire an alert
   */
  private fireAlert(
    params: Omit<Alert, 'id' | 'timestamp' | 'currentValue' | 'lastEvaluatedAt' | 'sampleCount' | 'windowStartedAt' | 'resolved' | 'resolvedAt' | 'resolutionReason'>,
    evaluation?: AlertEvaluation,
  ): void {
    const alertKey = `${params.sloName}_${params.severity}`;
    const existing = this.alerts.get(alertKey);

    // Don't re-fire if already active
    if (existing && !existing.resolved) {
      existing.currentValue = evaluation?.currentValue ?? params.value;
      existing.lastEvaluatedAt = evaluation?.evaluatedAt ?? new Date();
      existing.sampleCount = evaluation?.sampleCount ?? existing.sampleCount;
      existing.windowStartedAt = evaluation?.windowStartedAt;
      return;
    }

    const evaluatedAt = evaluation?.evaluatedAt ?? new Date();

    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      ...params,
      timestamp: evaluatedAt,
      currentValue: evaluation?.currentValue ?? params.value,
      lastEvaluatedAt: evaluatedAt,
      sampleCount: evaluation?.sampleCount ?? 0,
      windowStartedAt: evaluation?.windowStartedAt,
      resolved: false
    };

    this.alerts.set(alertKey, alert);

    // Log the alert
    metrics.logEvent(
      params.severity === 'critical' ? 'error' : 'warn',
      'slo',
      params.message,
      { sloName: params.sloName, value: params.value, threshold: params.threshold }
    );

    // Notify callbacks
    for (const callback of this.alertCallbacks) {
      try {
        callback(alert);
      } catch (error) {
        console.error('Alert callback error:', error);
      }
    }

    console.log(`🚨 [SLO ALERT] ${params.severity.toUpperCase()}: ${params.message}`);
  }

  /**
   * Resolve an alert
   */
  private resolveAlert(alertKey: string, reason: string = 'recovered'): void {
    for (const [key, alert] of this.alerts) {
      if (key.startsWith(alertKey) && !alert.resolved) {
        alert.resolved = true;
        alert.resolvedAt = new Date();
        alert.lastEvaluatedAt = alert.resolvedAt;
        alert.resolutionReason = reason;
        console.log(`✅ [SLO RESOLVED] ${alert.sloName}: ${alert.message}`);
        metrics.logEvent('info', 'slo', `Alert resolved: ${alert.sloName}`);
      }
    }
  }

  /**
   * Get all active alerts
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(a => !a.resolved);
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit: number = 100): Alert[] {
    return Array.from(this.alerts.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get SLO status summary
   */
  getSLOStatus(): Record<string, SLOStatus> {
    const status: Record<string, SLOStatus> = {};

    for (const [key, config] of Object.entries(SLOConfig)) {
      const buffer = this.latencyBuffers.get(config.name);
      const activeAlert = this.getActiveAlerts().find(a => a.sloName === config.name);

      if (buffer) {
        this.pruneLatencyBuffer(buffer, config, Date.now());
        const sorted = buffer.map(sample => sample.value).sort((a, b) => a - b);
        const hasCurrentEvidence = (
          (config.p99Ms !== undefined && sorted.length >= (config.minP99Samples ?? 100))
          || (config.p95Ms !== undefined && sorted.length >= (config.minP95Samples ?? 20))
        );
        const p95 = config.p95Ms !== undefined && sorted.length >= (config.minP95Samples ?? 20)
          ? this.nearestRank(sorted, 0.95)
          : undefined;
        const p99 = config.p99Ms !== undefined && sorted.length >= (config.minP99Samples ?? 100)
          ? this.nearestRank(sorted, 0.99)
          : undefined;

        status[config.name] = {
          healthy: !activeAlert,
          value: p95,
          threshold: config.p95Ms,
          p95Ms: p95,
          p99Ms: p99,
          p95ThresholdMs: config.p95Ms,
          p99ThresholdMs: config.p99Ms,
          sampleCount: sorted.length,
          windowSeconds: config.windowSeconds,
          evidenceState: hasCurrentEvidence ? 'current' : 'insufficient_data',
          oldestSampleAt: buffer[0] ? new Date(buffer[0].observedAtMs) : undefined,
          newestSampleAt: buffer[buffer.length - 1]
            ? new Date(buffer[buffer.length - 1].observedAtMs)
            : undefined,
        };
      } else {
        status[config.name] = {
          healthy: !activeAlert
        };
      }
    }

    return status;
  }

  /**
   * Map SLO name to metric name
   */
  private getMetricName(sloName: string): string | null {
    switch (sloName) {
      case 'mcp_latency':
        return MetricNames.API_LATENCY_MS;
      case 'memory_read_latency':
      case 'memory_write_latency':
        return MetricNames.API_LATENCY_MS; // Use same histogram for now
      default:
        return null;
    }
  }

  /**
   * Clear latency buffers (for testing)
   */
  reset(): void {
    for (const buffer of this.latencyBuffers.values()) {
      buffer.length = 0;
    }
    this.alerts.clear();
  }
}

// Singleton instance
export const sloMonitor = new SLOMonitor();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Record MCP request latency
 */
export function recordMCPLatency(latencyMs: number): void {
  sloMonitor.recordLatency('mcp_latency', latencyMs);
}

/**
 * Record WebSocket fan-out latency
 */
export function recordWSFanoutLatency(latencyMs: number): void {
  sloMonitor.recordLatency('ws_fanout_latency', latencyMs);
}

/**
 * Record memory read latency
 */
export function recordMemoryReadLatency(latencyMs: number): void {
  sloMonitor.recordLatency('memory_read_latency', latencyMs);
}

/**
 * Record memory write latency
 */
export function recordMemoryWriteLatency(latencyMs: number): void {
  sloMonitor.recordLatency('memory_write_latency', latencyMs);
}

/**
 * Start SLO monitoring
 */
export function startSLOMonitoring(intervalMs: number = 60000): void {
  sloMonitor.start(intervalMs);
}

/**
 * Stop SLO monitoring
 */
export function stopSLOMonitoring(): void {
  sloMonitor.stop();
}

/**
 * Register alert handler
 */
export function onSLOAlert(callback: (alert: Alert) => void): void {
  sloMonitor.onAlert(callback);
}
