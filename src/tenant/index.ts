/**
 * Tenant Module
 * Phase 5: Multi-tenant isolation & quotas
 */

export {
  TenantManager,
  getTenantManager
} from './tenant-manager.js';

export type {
  TenantTier,
  TenantInfo,
  TenantQuotas,
  TenantUsage,
  ApiKeyRecord,
  ApiKeyCreateRequest
} from './types.js';

export {
  TIER_QUOTAS,
  MULTI_TENANT_ENABLED,
  DEFAULT_TENANT_ID
} from './types.js';

export { default as tenantAdminRoutes } from './admin-routes.js';
