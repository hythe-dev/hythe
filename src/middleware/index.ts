/**
 * Middleware Module for Neural AI Collaboration Platform
 * Exports all middleware components
 */

export {
  authMiddleware,
  rateLimitMiddleware,
  messageRateLimitMiddleware,
  validateBody,
  validateRawBody,
  securityMiddleware,
  messageSecurityMiddleware,
  ValidationSchemas,
  generateApiKey,
  isValidApiKeyFormat,
  getRateLimiterStatus,
  setTenantResolver,
  checkAuthConfigured
} from './security.js';

export type { TenantRequest } from './security.js';

export { default as security } from './security.js';

// Auth module re-exports
export type { RequestContext } from './auth/types.js';
export { DEFAULT_REQUEST_CONTEXT } from './auth/types.js';
export { LocalTenantResolver } from './auth/tenant-resolver.js';
