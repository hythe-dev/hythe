/**
 * Auth types for Neural AI Collaboration Platform
 * Task 1000: RequestContext + Auth0 JWT + tenant-scoped handlers
 */

/**
 * Trusted request context — built by auth middleware from verified identity.
 * This is the ONLY source of truth for tenant_id and user_id.
 * Tool args MUST NOT be trusted for identity.
 */
export interface RequestContext {
  tenantId: string;
  userId: string | null;
  authType: 'jwt' | 'api_key' | 'dev';
  apiKeyId: string | null;
  idpSub: string | null;
  roles: string[];
  scopes: string[];
  mfaLevel: string | null;
  timezoneHint: string | null;
}

/**
 * Verified principal from JWT verification — provider-agnostic.
 */
export interface VerifiedPrincipal {
  provider: 'auth0' | string;
  iss: string;
  aud: string | string[];
  sub: string;
  orgId?: string;
  permissions?: string[];
  claims: Record<string, unknown>;
}

/**
 * Auth adapter contract — verifies a bearer token and returns a verified principal.
 */
export interface AuthAdapter {
  verifyBearer(token: string): Promise<VerifiedPrincipal>;
}

/**
 * Tenant resolver contract — maps a verified principal to local tenant/user/roles.
 */
export interface TenantResolver {
  resolve(input: {
    principal: VerifiedPrincipal;
    requestedTenantId?: string;
  }): Promise<{
    tenantId: string;
    userId: string;
    roles: string[];
    scopes: string[];
  }>;
}

/**
 * Auth0 configuration — read from environment variables.
 */
export interface Auth0Config {
  domain: string;
  clientId: string;
  audience: string;
  issuer: string;
  jwksUri: string;
  claimsNamespace: string;
}

/**
 * Default RequestContext for legacy API key auth (tenantId='default', userId=null).
 */
export const DEFAULT_REQUEST_CONTEXT: RequestContext = {
  tenantId: 'default',
  userId: null,
  authType: 'api_key',
  apiKeyId: null,
  idpSub: null,
  roles: [],
  scopes: [],
  mfaLevel: null,
  timezoneHint: null,
};
