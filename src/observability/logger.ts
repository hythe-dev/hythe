/**
 * Structured Logger for Neural AI Collaboration Platform
 * Phase 4.7: Observability sink & hygiene
 *
 * Provides consistent logging patterns with:
 * - Correlation IDs for request tracing
 * - Structured log format (JSON optional)
 * - Category-based filtering
 * - Integration with metrics event log
 */

import { metrics } from './metrics.js';

// ============================================================================
// LOG LEVELS AND CATEGORIES
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'api'        // API requests/responses
  | 'auth'       // Authentication events
  | 'rate_limit' // Rate limiting
  | 'systems'    // Backend system events (Redis, Neo4j, etc.)
  | 'memory'     // Memory operations
  | 'migration'  // Data migrations
  | 'reconciliation' // Data sync
  | 'slo'        // SLO alerts
  | 'websocket'  // WebSocket events
  | 'mcp'        // MCP protocol
  | 'agent'      // Agent operations
  | 'consensus'  // Consensus/voting
  | 'dual_write' // Dual-write shim
  | 'general';   // General logs

// ============================================================================
// LOGGER CONFIGURATION
// ============================================================================

export interface LoggerConfig {
  minLevel: LogLevel;
  enableConsole: boolean;
  enableMetrics: boolean;  // Write to metrics event log
  enableJson: boolean;     // JSON format output
  includeTimestamp: boolean;
  includeCorrelationId: boolean;
  categoryFilter?: LogCategory[]; // Only log these categories (empty = all)
}

const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: 'info',
  enableConsole: true,
  enableMetrics: true,
  enableJson: false,
  includeTimestamp: true,
  includeCorrelationId: true
};

// Log level priority (lower = more verbose)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

// Emoji prefixes for console output
const LOG_EMOJI: Record<LogLevel, string> = {
  debug: '🔍',
  info: '📊',
  warn: '⚠️',
  error: '❌'
};

// ============================================================================
// PII REDACTION
// ============================================================================

// Fields that should be redacted from logs
const SENSITIVE_FIELDS = new Set([
  'password',
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'secretKey',
  'secret_key',
  'authorization',
  'auth',
  'credentials',
  'credit_card',
  'creditCard',
  'ssn',
  'social_security',
  'email',
  'phone',
  'phoneNumber',
  'phone_number',
  'address',
  'dob',
  'date_of_birth',
  'dateOfBirth'
]);

// Patterns that indicate sensitive content
const SENSITIVE_PATTERNS = [
  /^nac_[a-f0-9]{64}$/i,           // Our API key format
  /^bearer\s+.+$/i,                 // Bearer tokens
  /^basic\s+.+$/i,                  // Basic auth
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // Phone numbers
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,   // SSN
];

const REDACTED = '[REDACTED]';

/**
 * Recursively redact sensitive fields from an object
 */
function redactSensitiveData(obj: any, depth: number = 0): any {
  // Prevent infinite recursion
  if (depth > 10) return obj;

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Check if string matches sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(obj)) {
        return REDACTED;
      }
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
// CORRELATION ID MANAGEMENT
// ============================================================================

// Store correlation ID in async local storage for request tracing
import { AsyncLocalStorage } from 'async_hooks';

interface LogContext {
  correlationId?: string;
  tenantId?: string;
  agentId?: string;
  requestPath?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run a function with log context (e.g., correlation ID)
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Get the current log context
 */
export function getLogContext(): LogContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// STRUCTURED LOG ENTRY
// ============================================================================

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  correlationId?: string;
  tenantId?: string;
  agentId?: string;
  data?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
  };
}

// ============================================================================
// LOGGER CLASS
// ============================================================================

class Logger {
  private config: LoggerConfig = { ...DEFAULT_CONFIG };

  /**
   * Configure the logger
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  /**
   * Check if a log level should be logged
   */
  private shouldLog(level: LogLevel, category: LogCategory): boolean {
    // Check level
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return false;
    }

    // Check category filter
    if (this.config.categoryFilter && this.config.categoryFilter.length > 0) {
      if (!this.config.categoryFilter.includes(category)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Create a log entry
   */
  private createEntry(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, any>,
    error?: Error
  ): LogEntry {
    const context = getLogContext();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message
    };

    if (this.config.includeCorrelationId && context?.correlationId) {
      entry.correlationId = context.correlationId;
    }

    if (context?.tenantId) {
      entry.tenantId = context.tenantId;
    }

    if (context?.agentId) {
      entry.agentId = context.agentId;
    }

    if (data) {
      // Apply PII redaction to data
      entry.data = redactSensitiveData(data);
    }

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack
      };
    }

    return entry;
  }

  /**
   * Output log entry to console
   */
  private outputToConsole(entry: LogEntry): void {
    if (!this.config.enableConsole) return;

    if (this.config.enableJson) {
      // JSON format
      console.log(JSON.stringify(entry));
    } else {
      // Human-readable format
      const parts: string[] = [];

      if (this.config.includeTimestamp) {
        parts.push(`[${entry.timestamp}]`);
      }

      parts.push(`${LOG_EMOJI[entry.level]} [${entry.category.toUpperCase()}]`);
      parts.push(entry.message);

      if (entry.correlationId) {
        parts.push(`(${entry.correlationId})`);
      }

      const logFn = entry.level === 'error' ? console.error
        : entry.level === 'warn' ? console.warn
          : console.log;

      if (entry.data || entry.error) {
        logFn(parts.join(' '), entry.data || '', entry.error?.stack || '');
      } else {
        logFn(parts.join(' '));
      }
    }
  }

  /**
   * Write to metrics event log
   */
  private outputToMetrics(entry: LogEntry): void {
    if (!this.config.enableMetrics) return;

    // Map to metrics log levels
    const metricsLevel = entry.level === 'debug' ? 'info' : entry.level;

    metrics.logEvent(
      metricsLevel as 'info' | 'warn' | 'error',
      entry.category,
      entry.message,
      {
        ...entry.data,
        correlationId: entry.correlationId,
        tenantId: entry.tenantId,
        agentId: entry.agentId,
        error: entry.error
      }
    );
  }

  /**
   * Main log method
   */
  log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, any>,
    error?: Error
  ): void {
    if (!this.shouldLog(level, category)) return;

    const entry = this.createEntry(level, category, message, data, error);
    this.outputToConsole(entry);
    this.outputToMetrics(entry);
  }

  // ============================================================================
  // CONVENIENCE METHODS
  // ============================================================================

  debug(category: LogCategory, message: string, data?: Record<string, any>): void {
    this.log('debug', category, message, data);
  }

  info(category: LogCategory, message: string, data?: Record<string, any>): void {
    this.log('info', category, message, data);
  }

  warn(category: LogCategory, message: string, data?: Record<string, any>): void {
    this.log('warn', category, message, data);
  }

  error(category: LogCategory, message: string, error?: Error, data?: Record<string, any>): void {
    this.log('error', category, message, data, error);
  }

  // ============================================================================
  // CATEGORY-SPECIFIC LOGGERS
  // ============================================================================

  api = {
    debug: (message: string, data?: Record<string, any>) => this.debug('api', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('api', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('api', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('api', message, error, data)
  };

  auth = {
    debug: (message: string, data?: Record<string, any>) => this.debug('auth', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('auth', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('auth', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('auth', message, error, data)
  };

  systems = {
    debug: (message: string, data?: Record<string, any>) => this.debug('systems', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('systems', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('systems', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('systems', message, error, data)
  };

  memory = {
    debug: (message: string, data?: Record<string, any>) => this.debug('memory', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('memory', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('memory', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('memory', message, error, data)
  };

  agent = {
    debug: (message: string, data?: Record<string, any>) => this.debug('agent', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('agent', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('agent', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('agent', message, error, data)
  };

  mcp = {
    debug: (message: string, data?: Record<string, any>) => this.debug('mcp', message, data),
    info: (message: string, data?: Record<string, any>) => this.info('mcp', message, data),
    warn: (message: string, data?: Record<string, any>) => this.warn('mcp', message, data),
    error: (message: string, error?: Error, data?: Record<string, any>) => this.error('mcp', message, error, data)
  };
}

// Singleton instance
export const logger = new Logger();

// ============================================================================
// EXPRESS MIDDLEWARE FOR CORRELATION ID
// ============================================================================

import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware to set up log context with correlation ID
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) || generateCorrelationId();

  // Set correlation ID in response header
  res.setHeader('x-correlation-id', correlationId);

  // Extract tenant/agent from request if available
  const context: LogContext = {
    correlationId,
    requestPath: req.path
  };

  // Run the rest of the request with this context
  withLogContext(context, () => {
    next();
  });
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export default logger;
