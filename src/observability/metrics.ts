/**
 * Observability Metrics Module for Neural AI Collaboration Platform
 * Phase 3: Centralized metrics collection and export
 * Phase 4: Event retention and compaction
 * Phase 4.7: PII redaction
 *
 * Tracks:
 * - Migration/reconciliation statistics
 * - Authentication events (rate limits, invalid keys)
 * - Advanced systems health (Redis, Neo4j, Weaviate fallbacks)
 * - API request metrics
 */

// ============================================================================
// PII REDACTION
// ============================================================================

// Fields that should be redacted from event logs
const SENSITIVE_FIELDS = new Set([
  'password', 'apiKey', 'api_key', 'apikey', 'token', 'accessToken',
  'access_token', 'refreshToken', 'refresh_token', 'secret', 'secretKey',
  'secret_key', 'authorization', 'auth', 'credentials', 'credit_card',
  'creditCard', 'ssn', 'social_security', 'email', 'phone', 'phoneNumber',
  'phone_number', 'address', 'dob', 'date_of_birth', 'dateOfBirth'
]);

// Patterns that indicate sensitive content
const SENSITIVE_PATTERNS = [
  /^nac_[a-f0-9]{64}$/i,           // API key format
  /^bearer\s+.+$/i,                 // Bearer tokens
  /^basic\s+.+$/i,                  // Basic auth
];

const REDACTED = '[REDACTED]';

/**
 * Recursively redact sensitive fields from an object
 */
function redactSensitiveData(obj: any, depth: number = 0): any {
  if (depth > 10 || obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(obj)) return REDACTED;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitiveData(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.has(key) || SENSITIVE_FIELDS.has(lowerKey)) {
        redacted[key] = REDACTED;
      } else {
        redacted[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return redacted;
  }

  return obj;
}

// ============================================================================
// EVENT RETENTION CONFIGURATION
// ============================================================================

export interface EventRetentionConfig {
  maxEventLogSize: number;      // Maximum events in memory (default: 1000)
  retentionHours: number;       // Hours to keep events (default: 24)
  compactionIntervalMs: number; // How often to run compaction (default: 300000 = 5 min)
  archiveEnabled: boolean;      // Whether to archive before deletion (default: false)
  archiveCallback?: (events: LogEvent[]) => Promise<void>; // Archive handler
}

export interface LogEvent {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: any;
}

export interface CompactionStats {
  lastCompactionTime: Date | null;
  eventsCompacted: number;
  eventsArchived: number;
  compactionRuns: number;
}

export interface MetricValue {
  value: number;
  timestamp: Date;
  labels?: Record<string, string>;
}

export interface Counter {
  name: string;
  description: string;
  value: number;
  labels?: Record<string, string>;
}

export interface Gauge {
  name: string;
  description: string;
  value: number;
  labels?: Record<string, string>;
}

export interface Histogram {
  name: string;
  description: string;
  count: number;
  sum: number;
  buckets: Map<number, number>; // threshold -> count
}

// Metric names as constants for consistency
export const MetricNames = {
  // Migration metrics
  MIGRATION_TASKS_MIGRATED: 'migration_tasks_migrated_total',
  MIGRATION_TASKS_SKIPPED: 'migration_tasks_skipped_total',
  MIGRATION_TASKS_ERRORS: 'migration_tasks_errors_total',
  MIGRATION_KNOWLEDGE_MIGRATED: 'migration_knowledge_migrated_total',
  MIGRATION_KNOWLEDGE_SKIPPED: 'migration_knowledge_skipped_total',
  MIGRATION_KNOWLEDGE_ERRORS: 'migration_knowledge_errors_total',
  MIGRATION_RUNS_TOTAL: 'migration_runs_total',
  MIGRATION_DURATION_MS: 'migration_duration_ms',

  // Reconciliation metrics
  RECONCILIATION_RUNS_TOTAL: 'reconciliation_runs_total',
  RECONCILIATION_DRIFTS_DETECTED: 'reconciliation_drifts_detected_total',
  RECONCILIATION_SYNCED: 'reconciliation_synced_total',
  RECONCILIATION_DURATION_MS: 'reconciliation_duration_ms',

  // Auth metrics
  AUTH_SUCCESS_TOTAL: 'auth_success_total',
  AUTH_FAILURE_TOTAL: 'auth_failure_total',
  AUTH_RATE_LIMITED_TOTAL: 'auth_rate_limited_total',
  AUTH_MISSING_KEY_TOTAL: 'auth_missing_key_total',
  AUTH_INVALID_KEY_TOTAL: 'auth_invalid_key_total',
  AUTH_MALFORMED_KEY_TOTAL: 'auth_malformed_key_total',

  // Rate limiting metrics
  RATE_LIMIT_GENERAL_EXCEEDED: 'rate_limit_general_exceeded_total',
  RATE_LIMIT_MESSAGE_EXCEEDED: 'rate_limit_message_exceeded_total',
  RATE_LIMIT_PREAUTH_EXCEEDED: 'rate_limit_preauth_exceeded_total',
  RATE_LIMIT_TENANT_EXCEEDED: 'rate_limit_tenant_exceeded_total',
  RATE_LIMIT_TENANT_QUOTA_EXCEEDED: 'rate_limit_tenant_quota_exceeded_total',
  RATE_LIMIT_TENANT_MESSAGE_EXCEEDED: 'rate_limit_tenant_message_exceeded_total',
  RATE_LIMIT_TENANT_MESSAGE_QUOTA_EXCEEDED: 'rate_limit_tenant_message_quota_exceeded_total',
  RATE_LIMITER_BACKEND: 'rate_limiter_backend_info',
  RATE_LIMITER_FALLBACK_TOTAL: 'rate_limiter_fallback_total',

  // Advanced systems metrics
  REDIS_CONNECTED: 'redis_connected_info',
  REDIS_FALLBACK_TOTAL: 'redis_fallback_total',
  NEO4J_CONNECTED: 'neo4j_connected_info',
  NEO4J_FALLBACK_TOTAL: 'neo4j_fallback_total',
  WEAVIATE_CONNECTED: 'weaviate_connected_info',
  WEAVIATE_FALLBACK_TOTAL: 'weaviate_fallback_total',
  SQLITE_FALLBACK_TOTAL: 'sqlite_fallback_total',

  // Dual-write metrics
  DUAL_WRITE_ENABLED: 'dual_write_enabled_info',
  DUAL_WRITE_SUCCESS_TOTAL: 'dual_write_success_total',
  DUAL_WRITE_FAILURE_TOTAL: 'dual_write_failure_total',

  // API metrics
  API_REQUESTS_TOTAL: 'api_requests_total',
  API_ERRORS_TOTAL: 'api_errors_total',
  API_LATENCY_MS: 'api_latency_ms'
};

// Default retention configuration
const DEFAULT_RETENTION_CONFIG: EventRetentionConfig = {
  maxEventLogSize: 10000,        // Increased for longer retention
  retentionHours: 720,           // 30 days (per PM guidance: 30-90 days)
  compactionIntervalMs: 3600000, // 1 hour (less frequent for longer retention)
  archiveEnabled: false
};

class MetricsCollector {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private eventLog: LogEvent[] = [];
  private retentionConfig: EventRetentionConfig = { ...DEFAULT_RETENTION_CONFIG };
  private compactionStats: CompactionStats = {
    lastCompactionTime: null,
    eventsCompacted: 0,
    eventsArchived: 0,
    compactionRuns: 0
  };
  private compactionInterval: NodeJS.Timeout | null = null;
  private eventIdCounter = 0;

  constructor() {
    this.initializeMetrics();
  }

  // ============================================================================
  // RETENTION CONFIGURATION
  // ============================================================================

  /**
   * Configure event retention policy
   */
  configureRetention(config: Partial<EventRetentionConfig>): void {
    this.retentionConfig = { ...this.retentionConfig, ...config };
    console.log('📊 Event retention configured:', {
      maxEvents: this.retentionConfig.maxEventLogSize,
      retentionHours: this.retentionConfig.retentionHours,
      compactionIntervalMs: this.retentionConfig.compactionIntervalMs,
      archiveEnabled: this.retentionConfig.archiveEnabled
    });
  }

  /**
   * Start automatic event compaction
   */
  startCompaction(): void {
    if (this.compactionInterval) {
      console.log('📊 Event compaction already running');
      return;
    }

    console.log(`📊 Starting event compaction (every ${this.retentionConfig.compactionIntervalMs}ms, ${this.retentionConfig.retentionHours}h retention)`);

    // Run compaction async in setInterval (non-blocking)
    this.compactionInterval = setInterval(() => {
      // Fire and forget - don't await to avoid blocking
      this.runCompaction().catch(err => {
        console.error('❌ Compaction error:', err);
      });
    }, this.retentionConfig.compactionIntervalMs);

    // Run initial compaction async (non-blocking)
    setImmediate(() => {
      this.runCompaction().catch(err => {
        console.error('❌ Initial compaction error:', err);
      });
    });
  }

  /**
   * Stop automatic event compaction
   */
  stopCompaction(): void {
    if (this.compactionInterval) {
      clearInterval(this.compactionInterval);
      this.compactionInterval = null;
      console.log('📊 Event compaction stopped');
    }
  }

  /**
   * Run event compaction manually
   */
  async runCompaction(): Promise<CompactionStats> {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - (this.retentionConfig.retentionHours * 60 * 60 * 1000));

    // Find events to compact (older than retention period)
    const eventsToCompact = this.eventLog.filter(e => e.timestamp < cutoffTime);
    const eventsToKeep = this.eventLog.filter(e => e.timestamp >= cutoffTime);

    // Additional size-based compaction if still over limit
    let finalEventsToKeep = eventsToKeep;
    let sizeBasedCompaction: LogEvent[] = [];
    if (eventsToKeep.length > this.retentionConfig.maxEventLogSize) {
      sizeBasedCompaction = eventsToKeep.slice(0, eventsToKeep.length - this.retentionConfig.maxEventLogSize);
      finalEventsToKeep = eventsToKeep.slice(-this.retentionConfig.maxEventLogSize);
    }

    const allCompacted = [...eventsToCompact, ...sizeBasedCompaction];

    // Archive if enabled and there are events to archive
    let archivedCount = 0;
    if (this.retentionConfig.archiveEnabled && this.retentionConfig.archiveCallback && allCompacted.length > 0) {
      try {
        await this.retentionConfig.archiveCallback(allCompacted);
        archivedCount = allCompacted.length;
      } catch (error) {
        console.error('❌ Event archive failed:', error);
      }
    }

    // Update event log
    this.eventLog = finalEventsToKeep;

    // Update stats
    this.compactionStats.lastCompactionTime = now;
    this.compactionStats.eventsCompacted += allCompacted.length;
    this.compactionStats.eventsArchived += archivedCount;
    this.compactionStats.compactionRuns++;

    if (allCompacted.length > 0) {
      console.log(`📊 Compaction: removed ${allCompacted.length} events (${archivedCount} archived), ${this.eventLog.length} remaining`);
    }

    return { ...this.compactionStats };
  }

  /**
   * Get compaction statistics
   */
  getCompactionStats(): CompactionStats {
    return { ...this.compactionStats };
  }

  /**
   * Get retention configuration
   */
  getRetentionConfig(): EventRetentionConfig {
    return { ...this.retentionConfig };
  }

  private initializeMetrics(): void {
    // Initialize counters
    const counterDefs: Array<{ name: string; description: string }> = [
      { name: MetricNames.MIGRATION_TASKS_MIGRATED, description: 'Total tasks migrated' },
      { name: MetricNames.MIGRATION_TASKS_SKIPPED, description: 'Total tasks skipped during migration' },
      { name: MetricNames.MIGRATION_TASKS_ERRORS, description: 'Total task migration errors' },
      { name: MetricNames.MIGRATION_KNOWLEDGE_MIGRATED, description: 'Total knowledge entries migrated' },
      { name: MetricNames.MIGRATION_KNOWLEDGE_SKIPPED, description: 'Total knowledge entries skipped' },
      { name: MetricNames.MIGRATION_KNOWLEDGE_ERRORS, description: 'Total knowledge migration errors' },
      { name: MetricNames.MIGRATION_RUNS_TOTAL, description: 'Total migration runs' },
      { name: MetricNames.RECONCILIATION_RUNS_TOTAL, description: 'Total reconciliation runs' },
      { name: MetricNames.RECONCILIATION_DRIFTS_DETECTED, description: 'Total drifts detected' },
      { name: MetricNames.RECONCILIATION_SYNCED, description: 'Total items synced during reconciliation' },
      { name: MetricNames.AUTH_SUCCESS_TOTAL, description: 'Total successful authentications' },
      { name: MetricNames.AUTH_FAILURE_TOTAL, description: 'Total failed authentications' },
      { name: MetricNames.AUTH_RATE_LIMITED_TOTAL, description: 'Total auth rate limit events' },
      { name: MetricNames.AUTH_MISSING_KEY_TOTAL, description: 'Total missing API key attempts' },
      { name: MetricNames.AUTH_INVALID_KEY_TOTAL, description: 'Total invalid API key attempts' },
      { name: MetricNames.AUTH_MALFORMED_KEY_TOTAL, description: 'Total malformed API key attempts' },
      { name: MetricNames.RATE_LIMIT_GENERAL_EXCEEDED, description: 'Total general rate limit exceeded' },
      { name: MetricNames.RATE_LIMIT_MESSAGE_EXCEEDED, description: 'Total message rate limit exceeded' },
      { name: MetricNames.RATE_LIMIT_PREAUTH_EXCEEDED, description: 'Total pre-auth rate limit exceeded' },
      { name: MetricNames.RATE_LIMIT_TENANT_EXCEEDED, description: 'Total tenant rate limit exceeded' },
      { name: MetricNames.RATE_LIMIT_TENANT_QUOTA_EXCEEDED, description: 'Total tenant quota exceeded' },
      { name: MetricNames.RATE_LIMIT_TENANT_MESSAGE_EXCEEDED, description: 'Total tenant message rate limit exceeded' },
      { name: MetricNames.RATE_LIMIT_TENANT_MESSAGE_QUOTA_EXCEEDED, description: 'Total tenant message quota exceeded' },
      { name: MetricNames.RATE_LIMITER_FALLBACK_TOTAL, description: 'Total rate limiter fallbacks to memory' },
      { name: MetricNames.REDIS_FALLBACK_TOTAL, description: 'Total Redis fallback events' },
      { name: MetricNames.NEO4J_FALLBACK_TOTAL, description: 'Total Neo4j fallback events' },
      { name: MetricNames.WEAVIATE_FALLBACK_TOTAL, description: 'Total Weaviate fallback events' },
      { name: MetricNames.SQLITE_FALLBACK_TOTAL, description: 'Total SQLite-only fallback events' },
      { name: MetricNames.DUAL_WRITE_SUCCESS_TOTAL, description: 'Total successful dual-writes' },
      { name: MetricNames.DUAL_WRITE_FAILURE_TOTAL, description: 'Total failed dual-writes' },
      { name: MetricNames.API_REQUESTS_TOTAL, description: 'Total API requests' },
      { name: MetricNames.API_ERRORS_TOTAL, description: 'Total API errors' }
    ];

    for (const def of counterDefs) {
      this.counters.set(def.name, { name: def.name, description: def.description, value: 0 });
    }

    // Initialize gauges
    const gaugeDefs: Array<{ name: string; description: string }> = [
      { name: MetricNames.RATE_LIMITER_BACKEND, description: 'Current rate limiter backend (0=memory, 1=redis)' },
      { name: MetricNames.REDIS_CONNECTED, description: 'Redis connection status (0=disconnected, 1=connected)' },
      { name: MetricNames.NEO4J_CONNECTED, description: 'Neo4j connection status (0=disconnected, 1=connected)' },
      { name: MetricNames.WEAVIATE_CONNECTED, description: 'Weaviate connection status (0=disconnected, 1=connected)' },
      { name: MetricNames.DUAL_WRITE_ENABLED, description: 'Dual-write mode status (0=disabled, 1=enabled)' }
    ];

    for (const def of gaugeDefs) {
      this.gauges.set(def.name, { name: def.name, description: def.description, value: 0 });
    }

    // Initialize histograms for latency tracking
    const histogramDefs: Array<{ name: string; description: string }> = [
      { name: MetricNames.MIGRATION_DURATION_MS, description: 'Migration duration in milliseconds' },
      { name: MetricNames.RECONCILIATION_DURATION_MS, description: 'Reconciliation duration in milliseconds' },
      { name: MetricNames.API_LATENCY_MS, description: 'API request latency in milliseconds' }
    ];

    const defaultBuckets = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    for (const def of histogramDefs) {
      const buckets = new Map<number, number>();
      for (const b of defaultBuckets) {
        buckets.set(b, 0);
      }
      this.histograms.set(def.name, {
        name: def.name,
        description: def.description,
        count: 0,
        sum: 0,
        buckets
      });
    }
  }

  // ============================================================================
  // COUNTER OPERATIONS
  // ============================================================================

  increment(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = this.getKey(name, labels);
    let counter = this.counters.get(key);
    if (!counter) {
      counter = { name, description: '', value: 0, labels };
      this.counters.set(key, counter);
    }
    counter.value += value;
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    const key = this.getKey(name, labels);
    return this.counters.get(key)?.value || 0;
  }

  // ============================================================================
  // GAUGE OPERATIONS
  // ============================================================================

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getKey(name, labels);
    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = { name, description: '', value: 0, labels };
      this.gauges.set(key, gauge);
    }
    gauge.value = value;
  }

  getGauge(name: string, labels?: Record<string, string>): number {
    const key = this.getKey(name, labels);
    return this.gauges.get(key)?.value || 0;
  }

  // ============================================================================
  // HISTOGRAM OPERATIONS
  // ============================================================================

  observe(name: string, value: number): void {
    const histogram = this.histograms.get(name);
    if (!histogram) return;

    histogram.count++;
    histogram.sum += value;

    for (const [threshold] of histogram.buckets) {
      if (value <= threshold) {
        histogram.buckets.set(threshold, (histogram.buckets.get(threshold) || 0) + 1);
      }
    }
  }

  getHistogram(name: string): Histogram | undefined {
    return this.histograms.get(name);
  }

  // ============================================================================
  // EVENT LOGGING
  // ============================================================================

  logEvent(level: 'info' | 'warn' | 'error', category: string, message: string, data?: any): void {
    const event: LogEvent = {
      id: `evt_${Date.now()}_${++this.eventIdCounter}`,
      timestamp: new Date(),
      level,
      category,
      message,
      data: data ? redactSensitiveData(data) : undefined  // Apply PII redaction
    };

    this.eventLog.push(event);

    // Trim log if too large (simple size-based trimming between compaction runs)
    if (this.eventLog.length > this.retentionConfig.maxEventLogSize * 1.5) {
      this.eventLog = this.eventLog.slice(-this.retentionConfig.maxEventLogSize);
    }

    // Also output to console with appropriate level
    const logPrefix = `[${category.toUpperCase()}]`;
    switch (level) {
      case 'info':
        console.log(`📊 ${logPrefix} ${message}`, data || '');
        break;
      case 'warn':
        console.warn(`⚠️ ${logPrefix} ${message}`, data || '');
        break;
      case 'error':
        console.error(`❌ ${logPrefix} ${message}`, data || '');
        break;
    }
  }

  getRecentEvents(count: number = 100, category?: string, level?: string): LogEvent[] {
    let events = this.eventLog;
    if (category) {
      events = events.filter(e => e.category === category);
    }
    if (level) {
      events = events.filter(e => e.level === level);
    }
    return events.slice(-count);
  }

  /**
   * Get event count by category and level
   */
  getEventCounts(): Record<string, Record<string, number>> {
    const counts: Record<string, Record<string, number>> = {};
    for (const event of this.eventLog) {
      if (!counts[event.category]) {
        counts[event.category] = { info: 0, warn: 0, error: 0 };
      }
      counts[event.category][event.level]++;
    }
    return counts;
  }

  /**
   * Get total event count
   */
  getEventLogSize(): number {
    return this.eventLog.length;
  }

  // ============================================================================
  // EXPORT / SNAPSHOT
  // ============================================================================

  getSnapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; sum: number; avg: number }>;
    timestamp: string;
  } {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const histograms: Record<string, { count: number; sum: number; avg: number }> = {};

    for (const [key, counter] of this.counters) {
      counters[key] = counter.value;
    }

    for (const [key, gauge] of this.gauges) {
      gauges[key] = gauge.value;
    }

    for (const [key, histogram] of this.histograms) {
      histograms[key] = {
        count: histogram.count,
        sum: histogram.sum,
        avg: histogram.count > 0 ? histogram.sum / histogram.count : 0
      };
    }

    return {
      counters,
      gauges,
      histograms,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Export metrics in Prometheus text format
   */
  toPrometheusFormat(): string {
    const lines: string[] = [];

    for (const [, counter] of this.counters) {
      lines.push(`# HELP ${counter.name} ${counter.description}`);
      lines.push(`# TYPE ${counter.name} counter`);
      const labelStr = counter.labels ? `{${Object.entries(counter.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
      lines.push(`${counter.name}${labelStr} ${counter.value}`);
    }

    for (const [, gauge] of this.gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.description}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      const labelStr = gauge.labels ? `{${Object.entries(gauge.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
      lines.push(`${gauge.name}${labelStr} ${gauge.value}`);
    }

    for (const [, histogram] of this.histograms) {
      lines.push(`# HELP ${histogram.name} ${histogram.description}`);
      lines.push(`# TYPE ${histogram.name} histogram`);
      for (const [le, count] of histogram.buckets) {
        lines.push(`${histogram.name}_bucket{le="${le}"} ${count}`);
      }
      lines.push(`${histogram.name}_bucket{le="+Inf"} ${histogram.count}`);
      lines.push(`${histogram.name}_sum ${histogram.sum}`);
      lines.push(`${histogram.name}_count ${histogram.count}`);
    }

    return lines.join('\n');
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private getKey(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  reset(): void {
    for (const counter of this.counters.values()) {
      counter.value = 0;
    }
    for (const histogram of this.histograms.values()) {
      histogram.count = 0;
      histogram.sum = 0;
      for (const key of histogram.buckets.keys()) {
        histogram.buckets.set(key, 0);
      }
    }
    this.eventLog = [];
  }
}

// Singleton instance
export const metrics = new MetricsCollector();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

// Migration metrics
export function recordMigrationRun(stats: { tasksM: number; tasksS: number; tasksE: number; knowledgeM: number; knowledgeS: number; knowledgeE: number; durationMs: number }): void {
  metrics.increment(MetricNames.MIGRATION_RUNS_TOTAL);
  metrics.increment(MetricNames.MIGRATION_TASKS_MIGRATED, stats.tasksM);
  metrics.increment(MetricNames.MIGRATION_TASKS_SKIPPED, stats.tasksS);
  metrics.increment(MetricNames.MIGRATION_TASKS_ERRORS, stats.tasksE);
  metrics.increment(MetricNames.MIGRATION_KNOWLEDGE_MIGRATED, stats.knowledgeM);
  metrics.increment(MetricNames.MIGRATION_KNOWLEDGE_SKIPPED, stats.knowledgeS);
  metrics.increment(MetricNames.MIGRATION_KNOWLEDGE_ERRORS, stats.knowledgeE);
  metrics.observe(MetricNames.MIGRATION_DURATION_MS, stats.durationMs);
  metrics.logEvent('info', 'migration', `Migration run completed`, stats);
}

// Reconciliation metrics
export function recordReconciliationRun(stats: { drifts: number; synced: number; durationMs: number }): void {
  metrics.increment(MetricNames.RECONCILIATION_RUNS_TOTAL);
  metrics.increment(MetricNames.RECONCILIATION_DRIFTS_DETECTED, stats.drifts);
  metrics.increment(MetricNames.RECONCILIATION_SYNCED, stats.synced);
  metrics.observe(MetricNames.RECONCILIATION_DURATION_MS, stats.durationMs);
  if (stats.drifts > 0) {
    metrics.logEvent('warn', 'reconciliation', `Reconciliation detected ${stats.drifts} drifts`, stats);
  } else {
    metrics.logEvent('info', 'reconciliation', `Reconciliation completed - no drifts`, stats);
  }
}

// Auth metrics
export function recordAuthSuccess(): void {
  metrics.increment(MetricNames.AUTH_SUCCESS_TOTAL);
}

export function recordAuthFailure(reason: 'missing_key' | 'invalid_key' | 'malformed_key' | 'rate_limited'): void {
  metrics.increment(MetricNames.AUTH_FAILURE_TOTAL);
  switch (reason) {
    case 'missing_key':
      metrics.increment(MetricNames.AUTH_MISSING_KEY_TOTAL);
      break;
    case 'invalid_key':
      metrics.increment(MetricNames.AUTH_INVALID_KEY_TOTAL);
      break;
    case 'malformed_key':
      metrics.increment(MetricNames.AUTH_MALFORMED_KEY_TOTAL);
      break;
    case 'rate_limited':
      metrics.increment(MetricNames.AUTH_RATE_LIMITED_TOTAL);
      break;
  }
  metrics.logEvent('warn', 'auth', `Auth failure: ${reason}`);
}

// Rate limiter metrics (extended for multi-tenant support)
export type RateLimitType = 'general' | 'message' | 'preauth' | 'tenant' | 'tenant_quota' | 'tenant_message' | 'tenant_message_quota';

export function recordRateLimitExceeded(type: RateLimitType): void {
  switch (type) {
    case 'general':
      metrics.increment(MetricNames.RATE_LIMIT_GENERAL_EXCEEDED);
      break;
    case 'message':
      metrics.increment(MetricNames.RATE_LIMIT_MESSAGE_EXCEEDED);
      break;
    case 'preauth':
      metrics.increment(MetricNames.RATE_LIMIT_PREAUTH_EXCEEDED);
      break;
    case 'tenant':
      metrics.increment(MetricNames.RATE_LIMIT_TENANT_EXCEEDED);
      break;
    case 'tenant_quota':
      metrics.increment(MetricNames.RATE_LIMIT_TENANT_QUOTA_EXCEEDED);
      break;
    case 'tenant_message':
      metrics.increment(MetricNames.RATE_LIMIT_TENANT_MESSAGE_EXCEEDED);
      break;
    case 'tenant_message_quota':
      metrics.increment(MetricNames.RATE_LIMIT_TENANT_MESSAGE_QUOTA_EXCEEDED);
      break;
  }
  metrics.logEvent('warn', 'rate_limit', `Rate limit exceeded: ${type}`);
}

export function setRateLimiterBackend(backend: 'memory' | 'redis'): void {
  metrics.setGauge(MetricNames.RATE_LIMITER_BACKEND, backend === 'redis' ? 1 : 0);
  if (backend === 'memory') {
    metrics.increment(MetricNames.RATE_LIMITER_FALLBACK_TOTAL);
    metrics.logEvent('warn', 'rate_limit', 'Rate limiter fell back to memory');
  } else {
    metrics.logEvent('info', 'rate_limit', 'Rate limiter using Redis backend');
  }
}

// Advanced systems metrics
export function setSystemConnected(system: 'redis' | 'neo4j' | 'weaviate', connected: boolean): void {
  const metricName = system === 'redis' ? MetricNames.REDIS_CONNECTED
    : system === 'neo4j' ? MetricNames.NEO4J_CONNECTED
      : MetricNames.WEAVIATE_CONNECTED;
  metrics.setGauge(metricName, connected ? 1 : 0);

  if (!connected) {
    const fallbackMetric = system === 'redis' ? MetricNames.REDIS_FALLBACK_TOTAL
      : system === 'neo4j' ? MetricNames.NEO4J_FALLBACK_TOTAL
        : MetricNames.WEAVIATE_FALLBACK_TOTAL;
    metrics.increment(fallbackMetric);
    metrics.logEvent('warn', 'systems', `${system} disconnected - falling back`);
  }
}

export function recordSQLiteFallback(): void {
  metrics.increment(MetricNames.SQLITE_FALLBACK_TOTAL);
  metrics.logEvent('warn', 'systems', 'Fell back to SQLite-only mode');
}

// Dual-write metrics
export function setDualWriteEnabled(enabled: boolean): void {
  metrics.setGauge(MetricNames.DUAL_WRITE_ENABLED, enabled ? 1 : 0);
  metrics.logEvent('info', 'dual_write', `Dual-write mode: ${enabled ? 'enabled' : 'disabled'}`);
}

export function recordDualWriteResult(success: boolean): void {
  if (success) {
    metrics.increment(MetricNames.DUAL_WRITE_SUCCESS_TOTAL);
  } else {
    metrics.increment(MetricNames.DUAL_WRITE_FAILURE_TOTAL);
    metrics.logEvent('error', 'dual_write', 'Dual-write failed');
  }
}

// API metrics
export function recordApiRequest(path: string, method: string, statusCode: number, durationMs: number): void {
  metrics.increment(MetricNames.API_REQUESTS_TOTAL, 1, { path, method });
  if (statusCode >= 400) {
    metrics.increment(MetricNames.API_ERRORS_TOTAL, 1, { path, method, status: String(statusCode) });
  }
  metrics.observe(MetricNames.API_LATENCY_MS, durationMs);
}
