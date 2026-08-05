/**
 * Observability Module for Neural AI Collaboration Platform
 * Phase 3: Centralized metrics, logging, and alerting
 * Phase 4: SLO monitoring, alerting, and event retention
 */

export {
  metrics,
  MetricNames,
  // Migration
  recordMigrationRun,
  // Reconciliation
  recordReconciliationRun,
  // Auth
  recordAuthSuccess,
  recordAuthFailure,
  // Rate limiting
  recordRateLimitExceeded,
  setRateLimiterBackend,
  // Systems
  setSystemConnected,
  recordSQLiteFallback,
  // Dual-write
  setDualWriteEnabled,
  recordDualWriteResult,
  // API
  recordApiRequest
} from './metrics.js';

export type {
  MetricValue,
  Counter,
  Gauge,
  Histogram,
  // Event retention types
  EventRetentionConfig,
  LogEvent,
  CompactionStats
} from './metrics.js';

// SLO monitoring
export {
  SLOConfig,
  sloMonitor,
  recordMCPLatency,
  recordWSFanoutLatency,
  recordMemoryReadLatency,
  recordMemoryWriteLatency,
  startSLOMonitoring,
  stopSLOMonitoring,
  onSLOAlert
} from './slo.js';

export type {
  SLOThreshold,
  AlertSeverity,
  Alert
} from './slo.js';

// Structured logger
export {
  logger,
  withLogContext,
  getLogContext,
  generateCorrelationId,
  correlationMiddleware
} from './logger.js';

export type {
  LogLevel,
  LogCategory,
  LoggerConfig,
  LogEntry
} from './logger.js';
