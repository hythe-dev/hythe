/**
 * Multi-Tenant Types
 * Phase 5: Multi-tenant isolation & quotas
 */

// ============================================================================
// TENANT TYPES
// ============================================================================

export type TenantTier = 'free' | 'pro' | 'enterprise';

export interface TenantInfo {
  id: string;
  name: string;
  tier: TenantTier;
  createdAt: Date;
  updatedAt?: Date;
  metadata?: Record<string, any>;
}

export interface TenantQuotas {
  requestsPerMinute: number;
  requestsPerDay: number;
  maxStorageBytes: number;
  maxMemoryEntries: number;
  maxAgents: number;
  messagesPerMinute: number;
  messagesPerDay: number;
  maxConcurrentConnections: number;
  eventRetentionDays: number;
}

export interface TenantUsage {
  tenantId: string;
  requestCount: number;
  storageBytes: number;
  memoryEntryCount: number;
  agentCount: number;
  messagesSent: number;
  connectionCount: number;
  periodStart: Date;
  lastUpdated: Date;
}

// ============================================================================
// API KEY TYPES
// ============================================================================

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  tenantId: string;
  name: string;
  permissions: string[];
  isAdmin: boolean;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

export interface ApiKeyCreateRequest {
  tenantId: string;
  name: string;
  permissions?: string[];
  isAdmin?: boolean;
  expiresInDays?: number;
}

// ============================================================================
// TIER DEFAULTS
// ============================================================================

export const TIER_QUOTAS: Record<TenantTier, TenantQuotas> = {
  free: {
    requestsPerMinute: 60,
    requestsPerDay: 1000,
    maxStorageBytes: 10 * 1024 * 1024,  // 10 MB
    maxMemoryEntries: 1000,
    maxAgents: 5,
    messagesPerMinute: 10,
    messagesPerDay: 100,
    maxConcurrentConnections: 2,
    eventRetentionDays: 7
  },
  pro: {
    requestsPerMinute: 300,
    requestsPerDay: 10000,
    maxStorageBytes: 100 * 1024 * 1024, // 100 MB
    maxMemoryEntries: 10000,
    maxAgents: 25,
    messagesPerMinute: 60,
    messagesPerDay: 1000,
    maxConcurrentConnections: 10,
    eventRetentionDays: 30
  },
  enterprise: {
    requestsPerMinute: 1000,
    requestsPerDay: -1,  // Unlimited
    maxStorageBytes: 1024 * 1024 * 1024, // 1 GB
    maxMemoryEntries: -1,  // Unlimited
    maxAgents: -1,  // Unlimited
    messagesPerMinute: 300,
    messagesPerDay: -1,  // Unlimited
    maxConcurrentConnections: 100,
    eventRetentionDays: 365
  }
};

// ============================================================================
// FEATURE FLAG
// ============================================================================

export const MULTI_TENANT_ENABLED = process.env.MULTI_TENANT_ENABLED === 'true';
export const DEFAULT_TENANT_ID = 'default';
