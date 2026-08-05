/**
 * Tenant resolver — maps verified JWT principal to local tenant/user/roles.
 * CONSTRAINT #5: org_id == tenant_id for MVP (direct mapping).
 * JIT upsert: user + membership sync after JWT verification.
 * Task 1000: RequestContext + Auth0 JWT + tenant-scoped handlers
 */

import Database from 'better-sqlite3';
import type { TenantResolver, VerifiedPrincipal } from './types.js';

/**
 * Local tenant resolver backed by SQLite tenant_memberships table.
 * Uses Auth0 org_id claim as tenant_id (direct mapping, CONSTRAINT #5).
 */
export class LocalTenantResolver implements TenantResolver {
  private db: Database.Database;
  private claimsNamespace: string;

  constructor(db: Database.Database, claimsNamespace: string = 'https://neural-mcp.local/') {
    this.db = db;
    this.claimsNamespace = claimsNamespace;
  }

  async resolve(input: {
    principal: VerifiedPrincipal;
    requestedTenantId?: string;
  }): Promise<{
    tenantId: string;
    userId: string;
    roles: string[];
    scopes: string[];
  }> {
    const { principal, requestedTenantId } = input;

    // Extract org_id from namespaced claim or principal
    const orgId = principal.orgId ||
      (principal.claims[`${this.claimsNamespace}org_id`] as string | undefined);

    if (!orgId) {
      throw new TenantResolutionError('JWT missing org_id claim', 'MISSING_ORG_ID');
    }

    // CONSTRAINT #5: tenant_id == org_id (direct mapping for MVP)
    const tenantId = orgId;

    // JIT upsert: ensure user exists
    const userId = this.jitUpsertUser(principal.sub, tenantId);

    // JIT upsert: ensure membership exists
    const membership = this.jitUpsertMembership(userId, tenantId);

    // If a different tenant was requested, validate membership
    if (requestedTenantId && requestedTenantId !== tenantId) {
      const hasMembership = this.checkMembership(userId, requestedTenantId);
      if (!hasMembership) {
        throw new TenantResolutionError(
          `User ${userId} is not a member of tenant ${requestedTenantId}`,
          'MEMBERSHIP_REQUIRED'
        );
      }
      // Use the requested tenant since membership is validated
      return {
        tenantId: requestedTenantId,
        userId,
        roles: this.getRoles(userId, requestedTenantId),
        scopes: principal.permissions || [],
      };
    }

    // Extract roles from namespaced claim or membership
    const claimRoles = principal.claims[`${this.claimsNamespace}roles`] as string[] | undefined;
    const roles = claimRoles || [membership.role];
    const scopes = principal.permissions || [];

    return { tenantId, userId, roles, scopes };
  }

  /**
   * JIT upsert user — create or update user record from JWT sub.
   */
  private jitUpsertUser(idpSub: string, tenantId: string): string {
    // Use idpSub as user ID for now (Auth0 sub like "auth0|...")
    const existing = this.db.prepare(
      'SELECT id FROM users WHERE id = ?'
    ).get(idpSub) as { id: string } | undefined;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO users (id, tenant_id, display_name, timezone, locale)
        VALUES (?, ?, ?, 'UTC', 'en-US')
      `).run(idpSub, tenantId, idpSub);
    }

    return idpSub;
  }

  /**
   * JIT upsert membership — ensure (user_id, tenant_id) exists.
   */
  private jitUpsertMembership(userId: string, tenantId: string): { role: string } {
    const existing = this.db.prepare(
      'SELECT role FROM tenant_memberships WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId) as { role: string } | undefined;

    if (existing) return existing;

    // Insert with default 'member' role
    this.db.prepare(`
      INSERT OR IGNORE INTO tenant_memberships (user_id, tenant_id, role)
      VALUES (?, ?, 'member')
    `).run(userId, tenantId);

    return { role: 'member' };
  }

  /**
   * Check if user has membership in a specific tenant.
   */
  private checkMembership(userId: string, tenantId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM tenant_memberships WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
    return !!row;
  }

  /**
   * Get roles for a user in a tenant.
   */
  private getRoles(userId: string, tenantId: string): string[] {
    const rows = this.db.prepare(
      'SELECT role FROM tenant_memberships WHERE user_id = ? AND tenant_id = ?'
    ).all(userId, tenantId) as { role: string }[];
    return rows.map(r => r.role);
  }
}

/**
 * Typed error for tenant resolution failures.
 */
export class TenantResolutionError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TenantResolutionError';
    this.code = code;
  }
}
