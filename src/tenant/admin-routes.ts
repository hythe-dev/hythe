/**
 * Tenant Admin Routes
 * Phase 5: Multi-tenant isolation & quotas
 *
 * Admin API endpoints for tenant and API key management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getTenantManager } from './tenant-manager.js';
import { TenantRequest } from '../middleware/security.js';
import { MULTI_TENANT_ENABLED } from './types.js';
import { metrics } from '../observability/index.js';

const router = Router();

// ============================================================================
// MIDDLEWARE: Admin Authorization
// ============================================================================

/**
 * Middleware to check if requester has admin access
 * Requires either:
 * 1. Server admin key (ADMIN_API_KEY env var)
 * 2. Tenant API key with isAdmin=true
 */
function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check server admin key first
  const serverAdminKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers['x-admin-key'] as string;

  if (serverAdminKey && providedKey === serverAdminKey) {
    return next();
  }

  // Check tenant-based admin access
  const tenantReq = req as TenantRequest;
  if (tenantReq.apiKeyRecord?.isAdmin) {
    return next();
  }

  res.status(403).json({
    error: 'Forbidden',
    message: 'Admin access required',
    code: 'ADMIN_ACCESS_REQUIRED'
  });
}

/**
 * Middleware to check if multi-tenant is enabled
 */
function requireMultiTenant(req: Request, res: Response, next: NextFunction): void {
  if (!MULTI_TENANT_ENABLED) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Multi-tenant mode is not enabled. Set MULTI_TENANT_ENABLED=true',
      code: 'MULTI_TENANT_DISABLED'
    });
    return;
  }
  next();
}

// Apply multi-tenant check to all routes
router.use(requireMultiTenant);

// ============================================================================
// TENANT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /admin/tenants - List all tenants
 */
router.get('/tenants', adminAuthMiddleware, (_req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenants = tenantManager.listTenants();
    res.json({ tenants, total: tenants.length });
  } catch (error) {
    console.error('❌ Error listing tenants:', error);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

/**
 * POST /admin/tenants - Create a new tenant
 */
router.post('/tenants', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const { name, tier, metadata } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Tenant name is required' });
      return;
    }

    const tenantManager = getTenantManager();
    const tenant = tenantManager.createTenant({ name, tier, metadata });

    metrics.logEvent('info', 'admin', `Created tenant via API: ${tenant.id}`);

    res.status(201).json({ tenant });
  } catch (error) {
    console.error('❌ Error creating tenant:', error);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

/**
 * GET /admin/tenants/:id - Get tenant details
 */
router.get('/tenants/:id', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    // Include quotas and usage
    const quotas = tenantManager.getQuotas(tenant.id);
    const usage = tenantManager.getUsage(tenant.id);

    res.json({ tenant, quotas, usage });
  } catch (error) {
    console.error('❌ Error getting tenant:', error);
    res.status(500).json({ error: 'Failed to get tenant' });
  }
});

/**
 * PATCH /admin/tenants/:id - Update tenant
 */
router.patch('/tenants/:id', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const { name, tier, metadata } = req.body;
    const tenantManager = getTenantManager();

    const tenant = tenantManager.updateTenant(req.params.id, { name, tier, metadata });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    metrics.logEvent('info', 'admin', `Updated tenant via API: ${tenant.id}`);

    res.json({ tenant });
  } catch (error) {
    console.error('❌ Error updating tenant:', error);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

/**
 * DELETE /admin/tenants/:id - Delete tenant
 */
router.delete('/tenants/:id', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const deleted = tenantManager.deleteTenant(req.params.id);

    if (!deleted) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    metrics.logEvent('info', 'admin', `Deleted tenant via API: ${req.params.id}`);

    res.json({ success: true, message: 'Tenant deleted' });
  } catch (error: any) {
    console.error('❌ Error deleting tenant:', error);
    if (error.message?.includes('Cannot delete default')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete tenant' });
    }
  }
});

// ============================================================================
// QUOTA MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /admin/tenants/:id/quotas - Get tenant quotas
 */
router.get('/tenants/:id/quotas', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const quotas = tenantManager.getQuotas(tenant.id);
    res.json({ quotas });
  } catch (error) {
    console.error('❌ Error getting quotas:', error);
    res.status(500).json({ error: 'Failed to get quotas' });
  }
});

/**
 * PUT /admin/tenants/:id/quotas - Set custom quotas
 */
router.put('/tenants/:id/quotas', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const {
      requestsPerMinute,
      requestsPerDay,
      maxStorageBytes,
      maxMemoryEntries,
      maxAgents,
      messagesPerMinute,
      messagesPerDay,
      maxConcurrentConnections,
      eventRetentionDays
    } = req.body;

    tenantManager.setQuotas(tenant.id, {
      requestsPerMinute,
      requestsPerDay,
      maxStorageBytes,
      maxMemoryEntries,
      maxAgents,
      messagesPerMinute,
      messagesPerDay,
      maxConcurrentConnections,
      eventRetentionDays
    });

    const quotas = tenantManager.getQuotas(tenant.id);
    metrics.logEvent('info', 'admin', `Updated quotas for tenant: ${tenant.id}`);

    res.json({ quotas });
  } catch (error) {
    console.error('❌ Error setting quotas:', error);
    res.status(500).json({ error: 'Failed to set quotas' });
  }
});

// ============================================================================
// USAGE ENDPOINTS
// ============================================================================

/**
 * GET /admin/tenants/:id/usage - Get tenant usage
 */
router.get('/tenants/:id/usage', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const usage = tenantManager.getUsage(tenant.id);
    const quotas = tenantManager.getQuotas(tenant.id);

    // Calculate usage percentages
    const usagePercent = {
      requests: quotas.requestsPerDay > 0 ? (usage.requestCount / quotas.requestsPerDay) * 100 : 0,
      storage: quotas.maxStorageBytes > 0 ? (usage.storageBytes / quotas.maxStorageBytes) * 100 : 0,
      memoryEntries: quotas.maxMemoryEntries > 0 ? (usage.memoryEntryCount / quotas.maxMemoryEntries) * 100 : 0,
      agents: quotas.maxAgents > 0 ? (usage.agentCount / quotas.maxAgents) * 100 : 0,
      messages: quotas.messagesPerDay > 0 ? (usage.messagesSent / quotas.messagesPerDay) * 100 : 0,
      connections: quotas.maxConcurrentConnections > 0 ? (usage.connectionCount / quotas.maxConcurrentConnections) * 100 : 0
    };

    res.json({ usage, quotas, usagePercent });
  } catch (error) {
    console.error('❌ Error getting usage:', error);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

// ============================================================================
// API KEY MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /admin/tenants/:id/keys - List API keys for tenant
 */
router.get('/tenants/:id/keys', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const keys = tenantManager.listApiKeys(tenant.id);
    res.json({ keys, total: keys.length });
  } catch (error) {
    console.error('❌ Error listing API keys:', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

/**
 * POST /admin/tenants/:id/keys - Generate API key for tenant
 */
router.post('/tenants/:id/keys', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const { name, permissions, isAdmin, expiresInDays } = req.body;
    const tenantManager = getTenantManager();
    const tenant = tenantManager.getTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    if (!name) {
      res.status(400).json({ error: 'API key name is required' });
      return;
    }

    const { key, record } = tenantManager.generateApiKey({
      tenantId: tenant.id,
      name,
      permissions,
      isAdmin,
      expiresInDays
    });

    metrics.logEvent('info', 'admin', `Generated API key for tenant: ${tenant.id}`);

    // Return the key only once - it won't be shown again
    res.status(201).json({
      key,  // This is the actual key - ONLY returned on creation
      record: {
        ...record,
        keyHash: '[HIDDEN]'  // Don't expose hash
      },
      warning: 'Save this API key now. It will not be shown again.'
    });
  } catch (error) {
    console.error('❌ Error generating API key:', error);
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

/**
 * DELETE /admin/keys/:keyId - Revoke API key
 */
router.delete('/keys/:keyId', adminAuthMiddleware, (req: Request, res: Response) => {
  try {
    const tenantManager = getTenantManager();
    const deleted = tenantManager.revokeApiKey(req.params.keyId);

    if (!deleted) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    metrics.logEvent('info', 'admin', `Revoked API key: ${req.params.keyId}`);

    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    console.error('❌ Error revoking API key:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ============================================================================
// SELF-SERVICE ENDPOINTS (for authenticated tenants)
// ============================================================================

/**
 * GET /admin/me - Get current tenant info (self-service)
 */
router.get('/me', (req: Request, res: Response) => {
  const tenantReq = req as TenantRequest;

  if (!tenantReq.tenant) {
    res.status(401).json({ error: 'No tenant context' });
    return;
  }

  try {
    const tenantManager = getTenantManager();
    const quotas = tenantManager.getQuotas(tenantReq.tenant.id);
    const usage = tenantManager.getUsage(tenantReq.tenant.id);

    res.json({
      tenant: tenantReq.tenant,
      quotas,
      usage,
      apiKey: {
        id: tenantReq.apiKeyRecord?.id,
        name: tenantReq.apiKeyRecord?.name,
        isAdmin: tenantReq.apiKeyRecord?.isAdmin,
        permissions: tenantReq.apiKeyRecord?.permissions
      }
    });
  } catch (error) {
    console.error('❌ Error getting tenant info:', error);
    res.status(500).json({ error: 'Failed to get tenant info' });
  }
});

/**
 * GET /admin/me/usage - Get current tenant usage (self-service)
 */
router.get('/me/usage', (req: Request, res: Response) => {
  const tenantReq = req as TenantRequest;

  if (!tenantReq.tenant) {
    res.status(401).json({ error: 'No tenant context' });
    return;
  }

  try {
    const tenantManager = getTenantManager();
    const usage = tenantManager.getUsage(tenantReq.tenant.id);
    const quotas = tenantManager.getQuotas(tenantReq.tenant.id);

    // Calculate remaining quotas
    const remaining = {
      requestsPerDay: quotas.requestsPerDay === -1 ? -1 : quotas.requestsPerDay - usage.requestCount,
      messagesPerDay: quotas.messagesPerDay === -1 ? -1 : quotas.messagesPerDay - usage.messagesSent,
      storageBytes: quotas.maxStorageBytes === -1 ? -1 : quotas.maxStorageBytes - usage.storageBytes,
      memoryEntries: quotas.maxMemoryEntries === -1 ? -1 : quotas.maxMemoryEntries - usage.memoryEntryCount,
      agents: quotas.maxAgents === -1 ? -1 : quotas.maxAgents - usage.agentCount
    };

    res.json({ usage, quotas, remaining });
  } catch (error) {
    console.error('❌ Error getting usage:', error);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

export default router;
