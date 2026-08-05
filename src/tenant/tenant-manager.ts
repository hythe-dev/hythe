/**
 * Tenant Manager
 * Phase 5: Multi-tenant isolation & quotas
 *
 * Manages tenant CRUD operations, API keys, and quota enforcement
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  TenantInfo,
  TenantTier,
  TenantQuotas,
  TenantUsage,
  ApiKeyRecord,
  ApiKeyCreateRequest,
  TIER_QUOTAS,
  MULTI_TENANT_ENABLED,
  DEFAULT_TENANT_ID
} from './types.js';
import { metrics } from '../observability/index.js';

// ============================================================================
// TENANT MANAGER CLASS
// ============================================================================

export class TenantManager {
  private db: Database.Database;
  private initialized: boolean = false;

  constructor(dbPath: string = './data/tenants.db') {
    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  // ============================================================================
  // DATABASE INITIALIZATION
  // ============================================================================

  private initializeDatabase(): void {
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Tenants table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tier TEXT DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT
      )
    `);

    // API Keys table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT,
        permissions TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        expires_at DATETIME
      )
    `);

    // Tenant quotas table (custom overrides)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_quotas (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
        requests_per_minute INTEGER,
        requests_per_day INTEGER,
        max_storage_bytes INTEGER,
        max_memory_entries INTEGER,
        max_agents INTEGER,
        messages_per_minute INTEGER,
        messages_per_day INTEGER,
        max_concurrent_connections INTEGER,
        event_retention_days INTEGER
      )
    `);

    // Tenant usage table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_usage (
        tenant_id TEXT,
        metric TEXT,
        value INTEGER DEFAULT 0,
        period_start DATETIME,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, metric, period_start)
      )
    `);

    // Create indices
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant ON tenant_usage(tenant_id);
    `);

    // Create default tenant if multi-tenant is enabled
    if (MULTI_TENANT_ENABLED) {
      this.ensureDefaultTenant();
    }

    this.initialized = true;
    console.log('🏢 Tenant manager initialized');
  }

  private ensureDefaultTenant(): void {
    const existing = this.getTenant(DEFAULT_TENANT_ID);
    if (!existing) {
      this.createTenant({
        id: DEFAULT_TENANT_ID,
        name: 'Default Tenant',
        tier: 'enterprise'  // Default tenant gets full access for backward compat
      });
      console.log('🏢 Created default tenant');
    }
  }

  // ============================================================================
  // TENANT CRUD
  // ============================================================================

  createTenant(params: { id?: string; name: string; tier?: TenantTier; metadata?: Record<string, any> }): TenantInfo {
    const id = params.id || `tenant_${crypto.randomBytes(8).toString('hex')}`;
    const tier = params.tier || 'free';

    const stmt = this.db.prepare(`
      INSERT INTO tenants (id, name, tier, metadata)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(id, params.name, tier, params.metadata ? JSON.stringify(params.metadata) : null);

    metrics.logEvent('info', 'tenant', `Created tenant: ${id} (${params.name})`);

    return this.getTenant(id)!;
  }

  getTenant(id: string): TenantInfo | null {
    const stmt = this.db.prepare(`
      SELECT id, name, tier, created_at, updated_at, metadata
      FROM tenants WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      tier: row.tier as TenantTier,
      createdAt: new Date(row.created_at),
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  listTenants(): TenantInfo[] {
    const stmt = this.db.prepare(`
      SELECT id, name, tier, created_at, updated_at, metadata
      FROM tenants ORDER BY created_at DESC
    `);

    return (stmt.all() as any[]).map(row => ({
      id: row.id,
      name: row.name,
      tier: row.tier as TenantTier,
      createdAt: new Date(row.created_at),
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  updateTenant(id: string, updates: { name?: string; tier?: TenantTier; metadata?: Record<string, any> }): TenantInfo | null {
    const tenant = this.getTenant(id);
    if (!tenant) return null;

    const stmt = this.db.prepare(`
      UPDATE tenants SET
        name = COALESCE(?, name),
        tier = COALESCE(?, tier),
        metadata = COALESCE(?, metadata),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      updates.name || null,
      updates.tier || null,
      updates.metadata ? JSON.stringify(updates.metadata) : null,
      id
    );

    metrics.logEvent('info', 'tenant', `Updated tenant: ${id}`);

    return this.getTenant(id);
  }

  deleteTenant(id: string): boolean {
    if (id === DEFAULT_TENANT_ID) {
      throw new Error('Cannot delete default tenant');
    }

    // Delete associated API keys first
    this.db.prepare('DELETE FROM api_keys WHERE tenant_id = ?').run(id);
    this.db.prepare('DELETE FROM tenant_quotas WHERE tenant_id = ?').run(id);
    this.db.prepare('DELETE FROM tenant_usage WHERE tenant_id = ?').run(id);

    const result = this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);

    if (result.changes > 0) {
      metrics.logEvent('info', 'tenant', `Deleted tenant: ${id}`);
      return true;
    }
    return false;
  }

  // ============================================================================
  // API KEY MANAGEMENT
  // ============================================================================

  generateApiKey(request: ApiKeyCreateRequest): { key: string; record: ApiKeyRecord } {
    // Verify tenant exists
    const tenant = this.getTenant(request.tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${request.tenantId}`);
    }

    // Generate key: nac_{tenantId prefix}_{random}
    const keyId = crypto.randomBytes(4).toString('hex');
    const keySecret = crypto.randomBytes(32).toString('hex');
    const key = `nac_${request.tenantId.substring(0, 8)}_${keySecret}`;
    const keyHash = this.hashApiKey(key);

    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = request.expiresInDays
      ? new Date(Date.now() + request.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (id, key_hash, tenant_id, name, permissions, is_admin, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      keyHash,
      request.tenantId,
      request.name,
      JSON.stringify(request.permissions || ['*']),
      request.isAdmin ? 1 : 0,
      expiresAt?.toISOString() || null
    );

    metrics.logEvent('info', 'tenant', `Generated API key for tenant: ${request.tenantId}`);

    const record = this.getApiKeyById(id)!;
    return { key, record };
  }

  private hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  validateApiKey(key: string): { valid: boolean; tenant?: TenantInfo; record?: ApiKeyRecord; reason?: string } {
    const keyHash = this.hashApiKey(key);

    const stmt = this.db.prepare(`
      SELECT k.*, t.name as tenant_name, t.tier, t.metadata as tenant_metadata
      FROM api_keys k
      JOIN tenants t ON k.tenant_id = t.id
      WHERE k.key_hash = ?
    `);

    const row = stmt.get(keyHash) as any;
    if (!row) {
      return { valid: false, reason: 'invalid_key' };
    }

    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return { valid: false, reason: 'expired_key' };
    }

    // Update last used
    this.db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

    const tenant: TenantInfo = {
      id: row.tenant_id,
      name: row.tenant_name,
      tier: row.tier as TenantTier,
      createdAt: new Date(row.created_at),
      metadata: row.tenant_metadata ? JSON.parse(row.tenant_metadata) : undefined
    };

    const record: ApiKeyRecord = {
      id: row.id,
      keyHash: row.key_hash,
      tenantId: row.tenant_id,
      name: row.name,
      permissions: JSON.parse(row.permissions || '[]'),
      isAdmin: row.is_admin === 1,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
    };

    return { valid: true, tenant, record };
  }

  getApiKeyById(id: string): ApiKeyRecord | null {
    const stmt = this.db.prepare('SELECT * FROM api_keys WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      keyHash: row.key_hash,
      tenantId: row.tenant_id,
      name: row.name,
      permissions: JSON.parse(row.permissions || '[]'),
      isAdmin: row.is_admin === 1,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
    };
  }

  listApiKeys(tenantId: string): ApiKeyRecord[] {
    const stmt = this.db.prepare('SELECT * FROM api_keys WHERE tenant_id = ?');
    return (stmt.all(tenantId) as any[]).map(row => ({
      id: row.id,
      keyHash: '[HIDDEN]',  // Don't expose hash
      tenantId: row.tenant_id,
      name: row.name,
      permissions: JSON.parse(row.permissions || '[]'),
      isAdmin: row.is_admin === 1,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined
    }));
  }

  revokeApiKey(keyId: string): boolean {
    const result = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
    if (result.changes > 0) {
      metrics.logEvent('info', 'tenant', `Revoked API key: ${keyId}`);
      return true;
    }
    return false;
  }

  // ============================================================================
  // QUOTA MANAGEMENT
  // ============================================================================

  getQuotas(tenantId: string): TenantQuotas {
    const tenant = this.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    // Get tier defaults
    const defaults = TIER_QUOTAS[tenant.tier];

    // Check for custom overrides
    const stmt = this.db.prepare('SELECT * FROM tenant_quotas WHERE tenant_id = ?');
    const row = stmt.get(tenantId) as any;

    if (!row) {
      return defaults;
    }

    // Merge with defaults
    return {
      requestsPerMinute: row.requests_per_minute ?? defaults.requestsPerMinute,
      requestsPerDay: row.requests_per_day ?? defaults.requestsPerDay,
      maxStorageBytes: row.max_storage_bytes ?? defaults.maxStorageBytes,
      maxMemoryEntries: row.max_memory_entries ?? defaults.maxMemoryEntries,
      maxAgents: row.max_agents ?? defaults.maxAgents,
      messagesPerMinute: row.messages_per_minute ?? defaults.messagesPerMinute,
      messagesPerDay: row.messages_per_day ?? defaults.messagesPerDay,
      maxConcurrentConnections: row.max_concurrent_connections ?? defaults.maxConcurrentConnections,
      eventRetentionDays: row.event_retention_days ?? defaults.eventRetentionDays
    };
  }

  setQuotas(tenantId: string, quotas: Partial<TenantQuotas>): void {
    const stmt = this.db.prepare(`
      INSERT INTO tenant_quotas (
        tenant_id, requests_per_minute, requests_per_day, max_storage_bytes,
        max_memory_entries, max_agents, messages_per_minute, messages_per_day,
        max_concurrent_connections, event_retention_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        requests_per_minute = COALESCE(excluded.requests_per_minute, requests_per_minute),
        requests_per_day = COALESCE(excluded.requests_per_day, requests_per_day),
        max_storage_bytes = COALESCE(excluded.max_storage_bytes, max_storage_bytes),
        max_memory_entries = COALESCE(excluded.max_memory_entries, max_memory_entries),
        max_agents = COALESCE(excluded.max_agents, max_agents),
        messages_per_minute = COALESCE(excluded.messages_per_minute, messages_per_minute),
        messages_per_day = COALESCE(excluded.messages_per_day, messages_per_day),
        max_concurrent_connections = COALESCE(excluded.max_concurrent_connections, max_concurrent_connections),
        event_retention_days = COALESCE(excluded.event_retention_days, event_retention_days)
    `);

    stmt.run(
      tenantId,
      quotas.requestsPerMinute ?? null,
      quotas.requestsPerDay ?? null,
      quotas.maxStorageBytes ?? null,
      quotas.maxMemoryEntries ?? null,
      quotas.maxAgents ?? null,
      quotas.messagesPerMinute ?? null,
      quotas.messagesPerDay ?? null,
      quotas.maxConcurrentConnections ?? null,
      quotas.eventRetentionDays ?? null
    );

    metrics.logEvent('info', 'tenant', `Updated quotas for tenant: ${tenantId}`);
  }

  // ============================================================================
  // USAGE TRACKING
  // ============================================================================

  incrementUsage(tenantId: string, metric: string, amount: number = 1): void {
    const periodStart = this.getCurrentPeriodStart();

    const stmt = this.db.prepare(`
      INSERT INTO tenant_usage (tenant_id, metric, value, period_start, last_updated)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, metric, period_start) DO UPDATE SET
        value = value + ?,
        last_updated = CURRENT_TIMESTAMP
    `);

    stmt.run(tenantId, metric, amount, periodStart, amount);
  }

  getUsage(tenantId: string): TenantUsage {
    const periodStart = this.getCurrentPeriodStart();

    const stmt = this.db.prepare(`
      SELECT metric, value, last_updated
      FROM tenant_usage
      WHERE tenant_id = ? AND period_start = ?
    `);

    const rows = stmt.all(tenantId, periodStart) as any[];

    const usage: TenantUsage = {
      tenantId,
      requestCount: 0,
      storageBytes: 0,
      memoryEntryCount: 0,
      agentCount: 0,
      messagesSent: 0,
      connectionCount: 0,
      periodStart: new Date(periodStart),
      lastUpdated: new Date()
    };

    for (const row of rows) {
      switch (row.metric) {
        case 'requests': usage.requestCount = row.value; break;
        case 'storage': usage.storageBytes = row.value; break;
        case 'memory_entries': usage.memoryEntryCount = row.value; break;
        case 'agents': usage.agentCount = row.value; break;
        case 'messages': usage.messagesSent = row.value; break;
        case 'connections': usage.connectionCount = row.value; break;
      }
      usage.lastUpdated = new Date(row.last_updated);
    }

    return usage;
  }

  private getCurrentPeriodStart(): string {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
  }

  // ============================================================================
  // QUOTA CHECK
  // ============================================================================

  checkQuota(tenantId: string, metric: string): { allowed: boolean; current: number; limit: number; percentUsed: number } {
    const quotas = this.getQuotas(tenantId);
    const usage = this.getUsage(tenantId);

    let current = 0;
    let limit = -1;

    switch (metric) {
      case 'requests_per_day':
        current = usage.requestCount;
        limit = quotas.requestsPerDay;
        break;
      case 'storage':
        current = usage.storageBytes;
        limit = quotas.maxStorageBytes;
        break;
      case 'memory_entries':
        current = usage.memoryEntryCount;
        limit = quotas.maxMemoryEntries;
        break;
      case 'agents':
        current = usage.agentCount;
        limit = quotas.maxAgents;
        break;
      case 'messages_per_day':
        current = usage.messagesSent;
        limit = quotas.messagesPerDay;
        break;
      case 'connections':
        current = usage.connectionCount;
        limit = quotas.maxConcurrentConnections;
        break;
    }

    // -1 means unlimited
    if (limit === -1) {
      return { allowed: true, current, limit, percentUsed: 0 };
    }

    const percentUsed = (current / limit) * 100;
    return {
      allowed: current < limit,
      current,
      limit,
      percentUsed
    };
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  close(): void {
    this.db.close();
    console.log('🏢 Tenant manager closed');
  }
}

// Singleton instance
let tenantManagerInstance: TenantManager | null = null;

export function getTenantManager(dbPath?: string): TenantManager {
  if (!tenantManagerInstance) {
    tenantManagerInstance = new TenantManager(dbPath);
  }
  return tenantManagerInstance;
}
