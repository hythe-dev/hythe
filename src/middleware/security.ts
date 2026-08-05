/**
 * Security Middleware for Neural AI Collaboration Platform
 * Phase 1A: Mandatory Authentication, Rate Limiting, Input Validation
 * Phase 3: Redis-backed rate limiting for HA with graceful fallback
 * Phase 3: Observability metrics integration
 * Phase 5: Multi-tenant authentication support
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, IRateLimiterOptions } from 'rate-limiter-flexible';
import { createClient, RedisClientType } from 'redis';
import Joi from 'joi';
import crypto from 'crypto';
import {
  recordAuthSuccess,
  recordAuthFailure,
  recordRateLimitExceeded,
  setRateLimiterBackend,
  setSystemConnected,
  metrics
} from '../observability/metrics.js';
import {
  getTenantManager,
  TenantInfo,
  ApiKeyRecord,
  TenantQuotas,
  MULTI_TENANT_ENABLED,
  DEFAULT_TENANT_ID,
  TIER_QUOTAS
} from '../tenant/index.js';
import type { RequestContext, AuthAdapter } from './auth/types.js';
import { DEFAULT_REQUEST_CONTEXT } from './auth/types.js';
import { Auth0Adapter, getAuth0Config, isJwtShaped } from './auth/auth0-adapter.js';
import { LocalTenantResolver } from './auth/tenant-resolver.js';
import {
  buildContextFromJwt,
  buildContextFromApiKey,
  buildContextFromDevHeaders,
  extractBearerToken,
} from './auth/request-context.js';

// ============================================================================
// AUTH0 ADAPTER + TENANT RESOLVER (lazy-initialized)
// ============================================================================

let _auth0Adapter: Auth0Adapter | null = null;
let _tenantResolver: LocalTenantResolver | null = null;

/**
 * Initialize Auth0 adapter from environment config.
 * Called lazily on first JWT auth attempt.
 */
function getAuth0Adapter(): Auth0Adapter | null {
  if (_auth0Adapter) return _auth0Adapter;
  const config = getAuth0Config();
  if (!config) return null;
  _auth0Adapter = new Auth0Adapter(config);
  return _auth0Adapter;
}

/**
 * Set the tenant resolver (must be called from server initialization with the DB reference).
 */
export function setTenantResolver(resolver: LocalTenantResolver): void {
  _tenantResolver = resolver;
}

/**
 * Get the tenant resolver instance.
 */
function getTenantResolver(): LocalTenantResolver | null {
  return _tenantResolver;
}

// ============================================================================
// EXTENDED REQUEST TYPE WITH TENANT CONTEXT
// ============================================================================

export interface TenantRequest extends Request {
  tenant?: TenantInfo;
  apiKeyRecord?: ApiKeyRecord;
  requestContext?: RequestContext;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

interface SecurityConfig {
  // API Key settings
  apiKeyHeader: string;
  apiKeyQueryParam: string;
  requireAuth: boolean;

  // Rate limiting settings
  generalRateLimit: { points: number; duration: number };
  messageRateLimit: { points: number; duration: number };

  // Paths that don't require authentication
  publicPaths: Set<string>;
}

/** Parse a positive integer from an env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Startup guard: verify the server has a usable auth configuration.
 *
 * Without this, a boot with no API_KEY (e.g. `docker compose up` that didn't
 * export API_KEY from .env) starts a server that reports /health = healthy but
 * rejects EVERY authenticated request with AUTH_NOT_CONFIGURED — a healthy
 * container running a dead service, with all MCP clients silently dropped.
 * Failing fast here turns that latent footgun into a loud, immediate crash.
 *
 * Returns { ok } so callers can decide to throw/exit; mirrors the exact
 * condition authMiddleware uses (single-key mode requires API_KEY).
 */
export function checkAuthConfigured(): { ok: boolean; reason?: string } {
  if (MULTI_TENANT_ENABLED) return { ok: true }; // JWT/tenant mode validates per-request
  const serverApiKey = process.env.API_KEY || process.env.NEURAL_API_KEY;
  if (!serverApiKey || serverApiKey.trim().length === 0) {
    return {
      ok: false,
      reason: 'No API_KEY configured. Set API_KEY (or NEURAL_API_KEY), or enable MULTI_TENANT_ENABLED=true. '
        + 'In Docker, export API_KEY from .env before compose (see ~/bin/neural-unified-up) or add env_file to the compose service.',
    };
  }
  if (!isValidApiKeyFormat(serverApiKey)) {
    return { ok: false, reason: 'API_KEY is set but malformed (needs 32+ printable chars, no whitespace/control).' };
  }
  return { ok: true };
}

const DEFAULT_CONFIG: SecurityConfig = {
  apiKeyHeader: 'x-api-key',
  apiKeyQueryParam: 'api_key',
  requireAuth: true, // MANDATORY - no fallback to open mode

  // Rate limits are env-configurable to support load/contract testing and
  // per-deployment tuning. Defaults preserve the original 100/min and 20/min.
  generalRateLimit: {
    points: envInt('GENERAL_RATE_LIMIT_POINTS', 100),
    duration: envInt('GENERAL_RATE_LIMIT_DURATION', 60),
  },
  messageRateLimit: {
    points: envInt('MESSAGE_RATE_LIMIT_POINTS', 20),
    duration: envInt('MESSAGE_RATE_LIMIT_DURATION', 60),
  },

  publicPaths: new Set(['/health', '/health.json', '/ready'])
};

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

/**
 * Generates a secure API key
 */
export function generateApiKey(): string {
  return `nac_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Validates API key format
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (typeof key !== 'string') return false;
  // New format: nac_ + 64 hex chars.
  if (/^nac_[a-f0-9]{64}$/.test(key)) return true;
  // Legacy format: 32–512 printable ASCII chars, no whitespace or control
  // characters. Tightened from a bare `length >= 32` so garbage/multiline
  // input is rejected before it reaches the comparison path.
  return /^[\x21-\x7E]{32,512}$/.test(key);
}

/**
 * Constant-time comparison for API keys to avoid leaking key material through
 * response timing. Returns false on length mismatch without an early-exit.
 */
export function safeKeyEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Burn an equal-length compare so timing does not reveal the mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// REDIS CLIENT FOR RATE LIMITING (HA Support)
// ============================================================================

let redisClient: RedisClientType | null = null;
let redisHealthy: boolean = false;
const REDIS_HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

interface RateLimiterState {
  general: RateLimiterMemory | RateLimiterRedis;
  message: RateLimiterMemory | RateLimiterRedis;
  preAuth: RateLimiterMemory | RateLimiterRedis;
  usingRedis: boolean;
}

const rateLimiterState: RateLimiterState = {
  general: null as any,
  message: null as any,
  preAuth: null as any,
  usingRedis: false
};

/**
 * Initialize Redis client for rate limiting (if REDIS_URL is set)
 */
async function initializeRedisRateLimiter(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;

  if (!redisUrl) {
    console.log('📝 No REDIS_URL configured, using in-memory rate limiter');
    initializeMemoryRateLimiters();
    return;
  }

  try {
    console.log('🔗 Connecting to Redis for rate limiting...');
    redisClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.warn('⚠️ Redis reconnect failed after 10 attempts, falling back to memory');
            fallbackToMemory();
            return false; // Stop trying
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis rate limiter error:', err.message);
      metrics.logEvent('error', 'redis', `Redis rate limiter error: ${err.message}`);
      if (redisHealthy) {
        redisHealthy = false;
        setSystemConnected('redis', false);
        fallbackToMemory();
      }
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis rate limiter connected');
      metrics.logEvent('info', 'redis', 'Redis rate limiter connected');
      redisHealthy = true;
      setSystemConnected('redis', true);
    });

    redisClient.on('ready', () => {
      redisHealthy = true;
      setSystemConnected('redis', true);
      initializeRedisRateLimiters();
    });

    redisClient.on('end', () => {
      console.log('🔌 Redis rate limiter disconnected');
      metrics.logEvent('warn', 'redis', 'Redis rate limiter disconnected');
      redisHealthy = false;
      setSystemConnected('redis', false);
    });

    await redisClient.connect();
    redisHealthy = true;
    initializeRedisRateLimiters();

    // Start health check loop
    startRedisHealthCheck();

  } catch (error) {
    console.warn('⚠️ Failed to connect to Redis for rate limiting:', error);
    console.log('📝 Falling back to in-memory rate limiter');
    initializeMemoryRateLimiters();
  }
}

/**
 * Initialize Redis-backed rate limiters
 */
function initializeRedisRateLimiters(): void {
  if (!redisClient) return;

  // Env-scoped key prefix to prevent collisions across deployments
  const envScope = process.env.NODE_ENV || 'dev';
  const customPrefix = process.env.RATE_LIMIT_REDIS_KEY_PREFIX || '';
  const keyPrefix = customPrefix || `rl:${envScope}:`;

  rateLimiterState.general = new RateLimiterRedis({
    storeClient: redisClient,
    points: DEFAULT_CONFIG.generalRateLimit.points,
    duration: DEFAULT_CONFIG.generalRateLimit.duration,
    keyPrefix: `${keyPrefix}general`
  });

  rateLimiterState.message = new RateLimiterRedis({
    storeClient: redisClient,
    points: DEFAULT_CONFIG.messageRateLimit.points,
    duration: DEFAULT_CONFIG.messageRateLimit.duration,
    keyPrefix: `${keyPrefix}message`
  });

  rateLimiterState.preAuth = new RateLimiterRedis({
    storeClient: redisClient,
    points: 10,
    duration: 60,
    keyPrefix: `${keyPrefix}preauth`
  });

  rateLimiterState.usingRedis = true;
  setRateLimiterBackend('redis');
  console.log(`✅ Rate limiters using Redis backend (prefix: ${keyPrefix})`);
  metrics.logEvent('info', 'rate_limit', `Redis rate limiter initialized with prefix: ${keyPrefix}`);
}

/**
 * Initialize in-memory rate limiters (fallback)
 */
function initializeMemoryRateLimiters(): void {
  rateLimiterState.general = new RateLimiterMemory({
    points: DEFAULT_CONFIG.generalRateLimit.points,
    duration: DEFAULT_CONFIG.generalRateLimit.duration,
    keyPrefix: 'general'
  });

  rateLimiterState.message = new RateLimiterMemory({
    points: DEFAULT_CONFIG.messageRateLimit.points,
    duration: DEFAULT_CONFIG.messageRateLimit.duration,
    keyPrefix: 'message'
  });

  rateLimiterState.preAuth = new RateLimiterMemory({
    points: 10,
    duration: 60,
    keyPrefix: 'preauth'
  });

  rateLimiterState.usingRedis = false;
  setRateLimiterBackend('memory');
  console.log('📝 Rate limiters using in-memory backend');
}

/**
 * Fallback to memory rate limiters when Redis fails
 */
function fallbackToMemory(): void {
  if (!rateLimiterState.usingRedis) return;
  console.warn('⚠️ [RATE-LIMIT] Falling back to in-memory rate limiter');
  metrics.logEvent('warn', 'rate_limit', 'Rate limiter falling back to in-memory (Redis unavailable)');
  initializeMemoryRateLimiters();
}

/**
 * Periodic health check for Redis connection
 */
function startRedisHealthCheck(): void {
  setInterval(async () => {
    if (!redisClient) return;

    try {
      const result = await redisClient.ping();
      if (result === 'PONG' && !redisHealthy) {
        console.log('✅ Redis rate limiter recovered');
        metrics.logEvent('info', 'rate_limit', 'Rate limiter recovered - switching back to Redis');
        redisHealthy = true;
        setSystemConnected('redis', true);
        initializeRedisRateLimiters();
      }
    } catch (error) {
      if (redisHealthy) {
        console.warn('⚠️ Redis health check failed');
        metrics.logEvent('warn', 'rate_limit', 'Redis health check failed');
        redisHealthy = false;
        setSystemConnected('redis', false);
        fallbackToMemory();
      }
    }
  }, REDIS_HEALTH_CHECK_INTERVAL);
}

// Initialize rate limiters on module load (memory-first, Redis async)
initializeMemoryRateLimiters();
initializeRedisRateLimiter().catch(err => {
  console.warn('⚠️ Redis rate limiter init error:', err.message);
});

/**
 * Get rate limiter status (for monitoring)
 */
export function getRateLimiterStatus(): { backend: string; healthy: boolean } {
  return {
    backend: rateLimiterState.usingRedis ? 'redis' : 'memory',
    healthy: rateLimiterState.usingRedis ? redisHealthy : true
  };
}

// Legacy aliases for backwards compatibility
const generalRateLimiter = { consume: (key: string) => rateLimiterState.general.consume(key) };
const messageRateLimiter = { consume: (key: string) => rateLimiterState.message.consume(key) };

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

/**
 * Extracts client identifier for rate limiting
 */
function getClientId(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Extracts API key from request.
 * CONSTRAINT #1: Does NOT extract from Authorization:Bearer if the token is JWT-shaped.
 * JWT tokens are handled separately by the JWT auth path.
 */
function extractApiKey(req: Request): string | null {
  // Check dedicated API key header first (case-insensitive)
  const headerKey = req.headers[DEFAULT_CONFIG.apiKeyHeader] as string
    || req.headers['X-API-Key'] as string;

  if (headerKey) return headerKey;

  // Check Authorization:Bearer — but ONLY if it's NOT a JWT (CONSTRAINT #1)
  const bearerToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (bearerToken && !isJwtShaped(bearerToken)) {
    return bearerToken;
  }

  // Check query parameter
  const queryKey = req.query[DEFAULT_CONFIG.apiKeyQueryParam] as string;
  if (queryKey) return queryKey;

  return null;
}

/**
 * Authentication middleware - MANDATORY
 * CONSTRAINT #1: JWT detection BEFORE API key validation.
 * CONSTRAINT #2: Preserves existing tenant quota middleware. Adds requestContext alongside existing fields.
 * Supports: JWT (Auth0), tenant API keys, legacy env API keys, dev headers.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantReq = req as TenantRequest;

  // Allow public paths
  if (DEFAULT_CONFIG.publicPaths.has(req.path)) {
    return next();
  }

  const clientId = getClientId(req);

  // === PATH 1: JWT Authentication (CONSTRAINT #1 — check BEFORE API key) ===
  const bearerToken = extractBearerToken(req);
  if (bearerToken && isJwtShaped(bearerToken)) {
    const adapter = getAuth0Adapter();
    const resolver = getTenantResolver();

    if (adapter && resolver) {
      try {
        const context = await buildContextFromJwt(bearerToken, adapter, resolver, req);
        tenantReq.requestContext = context;

        // CONSTRAINT #2: Also populate tenant/apiKeyRecord for quota middleware compatibility
        if (MULTI_TENANT_ENABLED) {
          try {
            const tenantManager = getTenantManager();
            const tenantInfo = tenantManager.getTenant(context.tenantId);
            if (tenantInfo) {
              tenantReq.tenant = tenantInfo;
            }
          } catch {
            // Tenant manager may not have this tenant — OK for JWT path
          }
        }

        recordAuthSuccess();
        metrics.logEvent('info', 'auth', `JWT auth success: tenant=${context.tenantId} user=${context.userId}`);
        return next();
      } catch (jwtError: any) {
        // JWT verification failed — fall through to API key path
        console.warn(`⚠️ JWT verification failed from ${clientId}: ${jwtError.message}`);
        // Don't return error yet — might be a non-JWT bearer token
      }
    }
    // If no adapter configured, fall through to API key path
  }

  // === PATH 2: Dev Headers (ENABLE_DEV_HEADERS=1 only) ===
  if (process.env.ENABLE_DEV_HEADERS === '1') {
    const devUserId = req.headers['x-user-id'] as string | undefined;
    if (devUserId) {
      tenantReq.requestContext = buildContextFromDevHeaders(req);
      // Still need API key for auth (dev headers only provide identity context)
    }
  }

  // Check if server has API key configured (legacy mode)
  const serverApiKey = process.env.API_KEY || process.env.NEURAL_API_KEY;

  // If multi-tenant is not enabled and no server API key and no JWT was validated, reject
  if (!MULTI_TENANT_ENABLED && !serverApiKey) {
    console.error('❌ SECURITY: No API_KEY configured. Set API_KEY or NEURAL_API_KEY environment variable.');
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Server not properly configured for secure access',
      code: 'AUTH_NOT_CONFIGURED'
    });
    return;
  }

  // === PATH 3: API Key Authentication ===
  const providedKey = extractApiKey(req);

  if (!providedKey) {
    // Rate limit missing key attempts
    try {
      await rateLimiterState.preAuth.consume(clientId);
    } catch {
      recordAuthFailure('rate_limited');
      recordRateLimitExceeded('preauth');
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many authentication attempts',
        code: 'AUTH_RATE_LIMITED'
      });
      return;
    }

    recordAuthFailure('missing_key');
    res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Provide via X-API-Key header or api_key query parameter.',
      code: 'API_KEY_MISSING'
    });
    return;
  }

  // Validate key format first (reject obvious junk)
  if (!isValidApiKeyFormat(providedKey)) {
    console.warn(`⚠️ Malformed API key from ${clientId}`);
    try {
      await rateLimiterState.preAuth.consume(clientId);
    } catch {
      recordAuthFailure('rate_limited');
      recordRateLimitExceeded('preauth');
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many authentication attempts',
        code: 'AUTH_RATE_LIMITED'
      });
      return;
    }

    recordAuthFailure('malformed_key');
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key format',
      code: 'API_KEY_MALFORMED'
    });
    return;
  }

  // Try tenant-based authentication first (if enabled)
  if (MULTI_TENANT_ENABLED) {
    try {
      const tenantManager = getTenantManager();
      const validation = tenantManager.validateApiKey(providedKey);

      if (validation.valid && validation.tenant && validation.record) {
        // Tenant-based auth succeeded
        tenantReq.tenant = validation.tenant;
        tenantReq.apiKeyRecord = validation.record;
        tenantReq.requestContext = buildContextFromApiKey(validation.tenant, validation.record);

        // Track usage
        tenantManager.incrementUsage(validation.tenant.id, 'requests');

        recordAuthSuccess();
        metrics.logEvent('info', 'auth', `Tenant auth success: ${validation.tenant.id}`);
        return next();
      }

      // If key looks like tenant key (nac_ prefix) but invalid, reject
      if (providedKey.startsWith('nac_') && !validation.valid) {
        console.warn(`⚠️ Invalid tenant API key from ${clientId}: ${validation.reason}`);
        try {
          await rateLimiterState.preAuth.consume(clientId);
        } catch {
          recordAuthFailure('rate_limited');
          res.status(429).json({
            error: 'Too Many Requests',
            message: 'Too many authentication attempts',
            code: 'AUTH_RATE_LIMITED'
          });
          return;
        }

        recordAuthFailure('invalid_key');
        res.status(401).json({
          error: 'Unauthorized',
          message: validation.reason === 'expired_key' ? 'API key has expired' : 'Invalid API key',
          code: validation.reason === 'expired_key' ? 'API_KEY_EXPIRED' : 'API_KEY_INVALID'
        });
        return;
      }
    } catch (error) {
      // Tenant manager error, fall through to legacy auth
      console.warn('⚠️ Tenant auth error, falling back to legacy:', error);
    }
  }

  // Fall back to legacy (env-based) authentication
  if (serverApiKey && safeKeyEqual(providedKey, serverApiKey)) {
    // Legacy auth succeeded - assign default tenant if multi-tenant enabled
    if (MULTI_TENANT_ENABLED) {
      try {
        const tenantManager = getTenantManager();
        const defaultTenant = tenantManager.getTenant(DEFAULT_TENANT_ID);
        if (defaultTenant) {
          tenantReq.tenant = defaultTenant;
        }
      } catch {
        // Ignore - continue without tenant context
      }
    }

    // Build RequestContext for legacy API key (default tenant, no user)
    if (!tenantReq.requestContext) {
      tenantReq.requestContext = buildContextFromApiKey(tenantReq.tenant, undefined);
    }

    recordAuthSuccess();
    return next();
  }

  // All authentication methods failed
  console.warn(`⚠️ Invalid API key attempt from ${clientId}`);
  try {
    await rateLimiterState.preAuth.consume(clientId);
  } catch {
    recordAuthFailure('rate_limited');
    recordRateLimitExceeded('preauth');
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many authentication attempts',
      code: 'AUTH_RATE_LIMITED'
    });
    return;
  }

  recordAuthFailure('invalid_key');
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Invalid API key',
    code: 'API_KEY_INVALID'
  });
}

// ============================================================================
// RATE LIMITING MIDDLEWARE
// ============================================================================

// Cache for tenant-specific rate limiters
const tenantRateLimiters = new Map<string, RateLimiterMemory>();

/**
 * Get or create a rate limiter for a tenant with specific quotas
 */
function getTenantRateLimiter(tenantId: string, quotas: TenantQuotas): RateLimiterMemory {
  const cacheKey = `${tenantId}:${quotas.requestsPerMinute}`;

  if (!tenantRateLimiters.has(cacheKey)) {
    tenantRateLimiters.set(cacheKey, new RateLimiterMemory({
      points: quotas.requestsPerMinute,
      duration: 60,
      keyPrefix: `tenant:${tenantId}`
    }));
  }

  return tenantRateLimiters.get(cacheKey)!;
}

/**
 * General rate limiting middleware with tenant quota support
 */
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Skip rate limiting for public paths
  if (DEFAULT_CONFIG.publicPaths.has(req.path)) {
    return next();
  }

  const tenantReq = req as TenantRequest;
  const clientId = getClientId(req);

  // If multi-tenant enabled and tenant present, use tenant-specific quotas
  if (MULTI_TENANT_ENABLED && tenantReq.tenant) {
    try {
      const tenantManager = getTenantManager();
      const quotas = tenantManager.getQuotas(tenantReq.tenant.id);

      // Check tenant quota first
      const quotaCheck = tenantManager.checkQuota(tenantReq.tenant.id, 'requests');
      if (!quotaCheck.allowed) {
        console.warn(`⚠️ Tenant quota exceeded for ${tenantReq.tenant.id} (${quotaCheck.percentUsed}%)`);
        recordRateLimitExceeded('tenant_quota');

        res.status(429).json({
          error: 'Quota Exceeded',
          message: `Daily request quota exceeded (${quotaCheck.current}/${quotaCheck.limit})`,
          code: 'TENANT_QUOTA_EXCEEDED',
          usage: {
            current: quotaCheck.current,
            limit: quotaCheck.limit,
            percentUsed: quotaCheck.percentUsed
          }
        });
        return;
      }

      // Use tenant-specific rate limiter
      const tenantLimiter = getTenantRateLimiter(tenantReq.tenant.id, quotas);
      const rateLimitKey = `${tenantReq.tenant.id}:${clientId}`;

      try {
        await tenantLimiter.consume(rateLimitKey);

        // Add rate limit headers
        res.set('X-RateLimit-Limit', String(quotas.requestsPerMinute));
        res.set('X-Tenant-Id', tenantReq.tenant.id);
        res.set('X-Tenant-Tier', tenantReq.tenant.tier);

        next();
        return;
      } catch (rateLimiterRes) {
        const rlRes = rateLimiterRes as RateLimiterRes;
        const retryAfter = Math.ceil(rlRes.msBeforeNext / 1000);

        res.set('Retry-After', String(retryAfter));
        res.set('X-RateLimit-Limit', String(quotas.requestsPerMinute));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Date.now() + rlRes.msBeforeNext));

        console.warn(`⚠️ Tenant rate limit exceeded for ${tenantReq.tenant.id} (${clientId})`);
        recordRateLimitExceeded('tenant');

        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          code: 'TENANT_RATE_LIMIT_EXCEEDED',
          retryAfter,
          tenant: tenantReq.tenant.id
        });
        return;
      }
    } catch (error) {
      // Tenant quota check failed, fall through to general rate limiting
      console.warn('⚠️ Tenant quota check failed, using general rate limiter:', error);
    }
  }

  // Fallback to general rate limiting (non-tenant or tenant check failed)
  try {
    await generalRateLimiter.consume(clientId);
    next();
  } catch (rateLimiterRes) {
    const rlRes = rateLimiterRes as RateLimiterRes;
    const retryAfter = Math.ceil(rlRes.msBeforeNext / 1000);

    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Limit', String(DEFAULT_CONFIG.generalRateLimit.points));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset', String(Date.now() + rlRes.msBeforeNext));

    console.warn(`⚠️ Rate limit exceeded for ${clientId} on ${req.path}`);
    recordRateLimitExceeded('general');

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter
    });
  }
}

// Cache for tenant-specific message rate limiters
const tenantMessageRateLimiters = new Map<string, RateLimiterMemory>();

/**
 * Get or create a message rate limiter for a tenant
 */
function getTenantMessageRateLimiter(tenantId: string, quotas: TenantQuotas): RateLimiterMemory {
  const cacheKey = `msg:${tenantId}:${quotas.messagesPerMinute}`;

  if (!tenantMessageRateLimiters.has(cacheKey)) {
    tenantMessageRateLimiters.set(cacheKey, new RateLimiterMemory({
      points: quotas.messagesPerMinute,
      duration: 60,
      keyPrefix: `tenant:msg:${tenantId}`
    }));
  }

  return tenantMessageRateLimiters.get(cacheKey)!;
}

/**
 * Message-specific rate limiting middleware (stricter) with tenant support
 */
export async function messageRateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantReq = req as TenantRequest;
  const clientId = getClientId(req);

  // If multi-tenant enabled and tenant present, use tenant-specific message quotas
  if (MULTI_TENANT_ENABLED && tenantReq.tenant) {
    try {
      const tenantManager = getTenantManager();
      const quotas = tenantManager.getQuotas(tenantReq.tenant.id);

      // Check tenant message quota first
      const quotaCheck = tenantManager.checkQuota(tenantReq.tenant.id, 'messages');
      if (!quotaCheck.allowed) {
        console.warn(`⚠️ Tenant message quota exceeded for ${tenantReq.tenant.id}`);
        recordRateLimitExceeded('tenant_message_quota');

        res.status(429).json({
          error: 'Message Quota Exceeded',
          message: `Daily message quota exceeded (${quotaCheck.current}/${quotaCheck.limit})`,
          code: 'TENANT_MESSAGE_QUOTA_EXCEEDED',
          usage: {
            current: quotaCheck.current,
            limit: quotaCheck.limit,
            percentUsed: quotaCheck.percentUsed
          }
        });
        return;
      }

      // Use tenant-specific message rate limiter
      const tenantLimiter = getTenantMessageRateLimiter(tenantReq.tenant.id, quotas);
      const rateLimitKey = `${tenantReq.tenant.id}:${clientId}`;

      try {
        await tenantLimiter.consume(rateLimitKey);

        // Track message usage
        tenantManager.incrementUsage(tenantReq.tenant.id, 'messages');

        next();
        return;
      } catch (rateLimiterRes) {
        const rlRes = rateLimiterRes as RateLimiterRes;
        const retryAfter = Math.ceil(rlRes.msBeforeNext / 1000);

        res.set('Retry-After', String(retryAfter));
        res.set('X-RateLimit-Limit', String(quotas.messagesPerMinute));
        res.set('X-RateLimit-Remaining', '0');

        console.warn(`⚠️ Tenant message rate limit exceeded for ${tenantReq.tenant.id}`);
        recordRateLimitExceeded('tenant_message');

        res.status(429).json({
          error: 'Too Many Requests',
          message: `Message rate limit exceeded. Try again in ${retryAfter} seconds.`,
          code: 'TENANT_MESSAGE_RATE_LIMIT_EXCEEDED',
          retryAfter
        });
        return;
      }
    } catch (error) {
      // Tenant quota check failed, fall through to general rate limiting
      console.warn('⚠️ Tenant message quota check failed, using general limiter:', error);
    }
  }

  // Fallback to general message rate limiting
  try {
    await messageRateLimiter.consume(clientId);
    next();
  } catch (rateLimiterRes) {
    const rlRes = rateLimiterRes as RateLimiterRes;
    const retryAfter = Math.ceil(rlRes.msBeforeNext / 1000);

    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Limit', String(DEFAULT_CONFIG.messageRateLimit.points));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset', String(Date.now() + rlRes.msBeforeNext));

    console.warn(`⚠️ Message rate limit exceeded for ${clientId}`);
    recordRateLimitExceeded('message');

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Message rate limit exceeded. Try again in ${retryAfter} seconds.`,
      code: 'MESSAGE_RATE_LIMIT_EXCEEDED',
      retryAfter
    });
  }
}

// ============================================================================
// INPUT VALIDATION SCHEMAS (Joi)
// ============================================================================

export const ValidationSchemas = {
  // Agent registration
  agentRegistration: Joi.object({
    agentId: Joi.string().min(1).max(100).required(),
    name: Joi.string().min(1).max(200).required(),
    capabilities: Joi.array().items(Joi.string().max(50)).max(50).required(),
    endpoint: Joi.string().uri().optional(),
    metadata: Joi.object().optional()
  }),

  // AI message
  aiMessage: Joi.object({
    from: Joi.string().min(1).max(100).optional(),
    to: Joi.string().min(1).max(100).optional(),
    agentId: Joi.string().min(1).max(100).optional(), // legacy alias
    content: Joi.string().max(100000).optional(),
    message: Joi.string().max(100000).optional(), // legacy alias
    messageType: Joi.string().valid('info', 'task', 'query', 'response', 'collaboration').optional(),
    priority: Joi.string().valid('low', 'normal', 'high', 'urgent').optional(),
    broadcast: Joi.boolean().optional(),
    toCapabilities: Joi.array().items(Joi.string().max(50)).max(20).optional(),
    capabilities: Joi.array().items(Joi.string().max(50)).max(20).optional(),
    excludeSelf: Joi.boolean().optional()
  }).or('content', 'message'), // At least one of content or message required

  // Memory storage
  memoryStore: Joi.object({
    agentId: Joi.string().min(1).max(100).required(),
    memory: Joi.object().required(),
    scope: Joi.string().valid('individual', 'shared').required(),
    type: Joi.string().min(1).max(50).required()
  }),

  // Memory search
  memorySearch: Joi.object({
    query: Joi.string().min(1).max(1000).required(),
    scope: Joi.alternatives().try(
      Joi.string().valid('individual', 'shared', 'all'),
      Joi.object({
        individual: Joi.boolean(),
        shared: Joi.boolean()
      })
    ).optional()
  }),

  // Entity creation
  createEntities: Joi.object({
    entities: Joi.array().items(
      Joi.object({
        name: Joi.string().min(1).max(200).required(),
        entityType: Joi.string().min(1).max(100).required(),
        observations: Joi.array().items(Joi.string().max(10000)).max(100).required()
      })
    ).min(1).max(100).required()
  }),

  // Observations
  addObservations: Joi.object({
    observations: Joi.array().items(
      Joi.object({
        entityName: Joi.string().min(1).max(200).required(),
        contents: Joi.array().items(Joi.string().max(10000)).min(1).max(100).required()
      })
    ).min(1).max(100).required()
  }),

  // Relations
  createRelations: Joi.object({
    relations: Joi.array().items(
      Joi.object({
        from: Joi.string().min(1).max(200).required(),
        to: Joi.string().min(1).max(200).required(),
        relationType: Joi.string().min(1).max(100).required(),
        properties: Joi.object().optional()
      })
    ).min(1).max(100).required()
  }),

  // Consensus vote
  consensusVote: Joi.object({
    proposalId: Joi.string().min(1).max(100).required(),
    vote: Joi.string().valid('approve', 'reject', 'abstain').required(),
    agentId: Joi.string().min(1).max(100).required(),
    reasoning: Joi.string().max(5000).optional()
  }),

  // Agent coordination
  coordinateAgents: Joi.object({
    taskId: Joi.string().min(1).max(100).required(),
    agents: Joi.array().items(Joi.string().min(1).max(100)).min(1).max(50).required(),
    workflow: Joi.object().required(),
    deadline: Joi.string().isoDate().optional()
  }),

  // Generic tool call (for /api/tools/:toolName)
  toolCall: Joi.object().max(50).pattern(
    Joi.string().max(100),
    Joi.alternatives().try(
      Joi.string().max(100000),
      Joi.number(),
      Joi.boolean(),
      Joi.array().max(1000),
      Joi.object().max(100)
    )
  ),

  // MCP JSON-RPC request
  mcpRequest: Joi.object({
    jsonrpc: Joi.string().valid('2.0').optional(),
    id: Joi.alternatives().try(Joi.string().max(100), Joi.number()).optional(),
    method: Joi.string().max(100).optional(),
    params: Joi.object().max(100).optional()
  })
};

// ============================================================================
// VALIDATION MIDDLEWARE FACTORY
// ============================================================================

// Maximum raw body size for messages (1MB)
const MAX_RAW_BODY_SIZE = 1 * 1024 * 1024;

/**
 * Creates a validation middleware for a specific schema
 */
export function validateBody(schemaName: keyof typeof ValidationSchemas) {
  const schema = ValidationSchemas[schemaName];

  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
        type: d.type
      }));

      console.warn(`⚠️ Validation failed for ${req.path}:`, details);

      res.status(400).json({
        error: 'Validation Error',
        message: 'Request body validation failed',
        code: 'VALIDATION_FAILED',
        details
      });
      return;
    }

    // Replace body with validated/sanitized value
    req.body = value;
    next();
  };
}

/**
 * Validates raw body (Buffer) and parses to JSON with size limit
 * For endpoints like /ai-message that receive raw bodies
 */
export function validateRawBody(schemaName: keyof typeof ValidationSchemas) {
  const schema = ValidationSchemas[schemaName];

  return (req: Request, res: Response, next: NextFunction): void => {
    // Check size limit
    if (Buffer.isBuffer(req.body) && req.body.length > MAX_RAW_BODY_SIZE) {
      res.status(413).json({
        error: 'Payload Too Large',
        message: `Request body exceeds ${MAX_RAW_BODY_SIZE / 1024}KB limit`,
        code: 'PAYLOAD_TOO_LARGE'
      });
      return;
    }

    // Parse raw body to JSON
    let parsedBody: any;
    try {
      if (Buffer.isBuffer(req.body)) {
        const rawString = req.body.toString('utf8');
        parsedBody = JSON.parse(rawString);
      } else if (typeof req.body === 'string') {
        parsedBody = JSON.parse(req.body);
      } else if (typeof req.body === 'object' && req.body !== null) {
        parsedBody = req.body;
      } else {
        throw new Error('Invalid body type');
      }
    } catch (parseError) {
      res.status(400).json({
        error: 'Invalid JSON',
        message: 'Request body must be valid JSON',
        code: 'JSON_PARSE_ERROR'
      });
      return;
    }

    // Validate against schema
    const { error, value } = schema.validate(parsedBody, {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
        type: d.type
      }));

      console.warn(`⚠️ Raw body validation failed for ${req.path}:`, details);

      res.status(400).json({
        error: 'Validation Error',
        message: 'Request body validation failed',
        code: 'VALIDATION_FAILED',
        details
      });
      return;
    }

    // Replace body with validated/sanitized value (now parsed JSON)
    req.body = value;
    next();
  };
}

// ============================================================================
// COMBINED SECURITY MIDDLEWARE
// ============================================================================

/**
 * Applies all security middleware in correct order
 */
export function securityMiddleware() {
  return [
    authMiddleware,
    rateLimitMiddleware
  ];
}

/**
 * Applies security middleware plus message rate limiting for /ai-message
 */
export function messageSecurityMiddleware() {
  return [
    authMiddleware,
    messageRateLimitMiddleware,
    validateBody('aiMessage')
  ];
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  authMiddleware,
  rateLimitMiddleware,
  messageRateLimitMiddleware,
  validateBody,
  securityMiddleware,
  messageSecurityMiddleware,
  ValidationSchemas,
  generateApiKey,
  isValidApiKeyFormat,
  getRateLimiterStatus,
  setTenantResolver
};
