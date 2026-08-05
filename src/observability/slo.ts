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
 * - Fallback events: alert on any SQLite fallback
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
  maxCount?: number;  // For error/fallback counts
  windowSeconds: number;
}

export const SLOConfig: Record<string, SLOThreshold> = {
  MCP_LATENCY: {
    name: 'mcp_latency',
    description: 'MCP request latency',
    p95Ms: 300,
    p99Ms: 600,
    windowSeconds: 300  // 5-minute window
  },
  WS_FANOUT_LATENCY: {
    name: 'ws_fanout_latency',
    description: 'WebSocket fan-out latency',
    p95Ms: 200,
    windowSeconds: 300
  },
  MEMORY_READ_LATENCY: {
    name: 'memory_read_latency',
    description: 'Memory read operation latency',
    p95Ms: 250,
    windowSeconds: 300
  },
  MEMORY_WRITE_LATENCY: {
    name: 'memory_write_latency',
    description: 'Memory write operation latency',
    p95Ms: 400,
    windowSeconds: 300
  },
  SQLITE_FALLBACK: {
    name: 'sqlite_fallback',
    description: 'SQLite fallback events (should be 0)',
    maxCount: 0,  // Any fallback is an alert
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
  resolved: boolean;
  resolvedAt?: Date;
}

// ============================================================================
// SLO MONITOR
// ============================================================================

class SLOMonitor {
  private alerts: Map<string, Alert> = new Map();
  private alertCallbacks: Array<(alert: Alert) => void> = [];
  private latencyBuffers: Map<string, number[]> = new Map();
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
      buffer.push(latencyMs);
      // Keep buffer bounded
      if (buffer.length > this.maxBufferSize) {
        buffer.shift();
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

    // Check SQLite fallback
    this.checkFallbackSLO();

    // Check availability
    this.checkAvailabilitySLO();
  }

  /**
   * Check a latency-based SLO
   */
  private checkLatencySLO(config: SLOThreshold): void {
    const buffer = this.latencyBuffers.get(config.name);
    if (!buffer || buffer.length < 10) return; // Need minimum samples

    const sorted = [...buffer].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);
    const p95 = sorted[p95Index];
    const p99 = sorted[p99Index];

    // Check p95
    if (config.p95Ms && p95 > config.p95Ms) {
      this.fireAlert({
        sloName: config.name,
        severity: 'warning',
        message: `${config.description} p95 (${p95.toFixed(0)}ms) exceeds threshold (${config.p95Ms}ms)`,
        value: p95,
        threshold: config.p95Ms
      });
    } else {
      this.resolveAlert(`${config.name}_p95`);
    }

    // Check p99
    if (config.p99Ms && p99 > config.p99Ms) {
      this.fireAlert({
        sloName: config.name,
        severity: 'critical',
        message: `${config.description} p99 (${p99.toFixed(0)}ms) exceeds threshold (${config.p99Ms}ms)`,
        value: p99,
        threshold: config.p99Ms
      });
    } else {
      this.resolveAlert(`${config.name}_p99`);
    }
  }

  /**
   * Check SQLite fallback SLO
   */
  private checkFallbackSLO(): void {
    const fallbackCount = metrics.getCounter(MetricNames.SQLITE_FALLBACK_TOTAL);

    if (fallbackCount > 0) {
      this.fireAlert({
        sloName: 'sqlite_fallback',
        severity: 'critical',
        message: `SQLite fallback detected (${fallbackCount} events). Advanced systems unavailable.`,
        value: fallbackCount,
        threshold: 0
      });
    }

    // Also check individual system fallbacks
    const redisFallback = metrics.getCounter(MetricNames.REDIS_FALLBACK_TOTAL);
    const neo4jFallback = metrics.getCounter(MetricNames.NEO4J_FALLBACK_TOTAL);
    const weaviateFallback = metrics.getCounter(MetricNames.WEAVIATE_FALLBACK_TOTAL);

    if (redisFallback > 0) {
      this.fireAlert({
        sloName: 'redis_fallback',
        severity: 'warning',
        message: `Redis fallback detected (${redisFallback} events)`,
        value: redisFallback,
        threshold: 0
      });
    }

    if (neo4jFallback > 0) {
      this.fireAlert({
        sloName: 'neo4j_fallback',
        severity: 'warning',
        message: `Neo4j fallback detected (${neo4jFallback} events)`,
        value: neo4jFallback,
        threshold: 0
      });
    }

    if (weaviateFallback > 0) {
      this.fireAlert({
        sloName: 'weaviate_fallback',
        severity: 'warning',
        message: `Weaviate fallback detected (${weaviateFallback} events)`,
        value: weaviateFallback,
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
  private fireAlert(params: Omit<Alert, 'id' | 'timestamp' | 'resolved'>): void {
    const alertKey = `${params.sloName}_${params.severity}`;
    const existing = this.alerts.get(alertKey);

    // Don't re-fire if already active
    if (existing && !existing.resolved) {
      return;
    }

    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      ...params,
      timestamp: new Date(),
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
  private resolveAlert(alertKey: string): void {
    for (const [key, alert] of this.alerts) {
      if (key.startsWith(alertKey) && !alert.resolved) {
        alert.resolved = true;
        alert.resolvedAt = new Date();
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
  getSLOStatus(): Record<string, { healthy: boolean; value?: number; threshold?: number }> {
    const status: Record<string, { healthy: boolean; value?: number; threshold?: number }> = {};

    for (const [key, config] of Object.entries(SLOConfig)) {
      const buffer = this.latencyBuffers.get(config.name);
      const activeAlert = this.getActiveAlerts().find(a => a.sloName === config.name);

      if (buffer && buffer.length > 0) {
        const sorted = [...buffer].sort((a, b) => a - b);
        const p95Index = Math.floor(sorted.length * 0.95);
        const p95 = sorted[p95Index];

        status[config.name] = {
          healthy: !activeAlert,
          value: p95,
          threshold: config.p95Ms
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
