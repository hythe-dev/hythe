/**
 * RequestContext factory — builds trusted RequestContext from JWT or API key path.
 * Legacy API keys: tenantId='default', userId=null.
 * Task 1000: RequestContext + Auth0 JWT + tenant-scoped handlers
 */

import { Request } from 'express';
import type { RequestContext, AuthAdapter, VerifiedPrincipal } from './types.js';
import { DEFAULT_REQUEST_CONTEXT } from './types.js';
import type { LocalTenantResolver } from './tenant-resolver.js';
import { isJwtShaped } from './auth0-adapter.js';
import type { TenantInfo, ApiKeyRecord } from '../../tenant/index.js';

/**
 * Build RequestContext from a JWT bearer token.
 */
export async function buildContextFromJwt(
  token: string,
  adapter: AuthAdapter,
  resolver: LocalTenantResolver,
  req: Request,
): Promise<RequestContext> {
  const principal: VerifiedPrincipal = await adapter.verifyBearer(token);

  const claimsNamespace = process.env.AUTH0_CLAIMS_NAMESPACE || 'https://neural-mcp.local/';
  const mfaLevel = principal.claims[`${claimsNamespace}mfa_level`] as string | undefined;
  const timezoneHint = (req.headers['x-user-timezone'] as string) ||
    (principal.claims[`${claimsNamespace}timezone`] as string | undefined) ||
    null;

  // Requested tenant override from header (if any)
  const requestedTenantId = req.headers['x-tenant-id'] as string | undefined;

  const resolved = await resolver.resolve({
    principal,
    requestedTenantId: requestedTenantId || undefined,
  });

  return {
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    authType: 'jwt',
    apiKeyId: null,
    idpSub: principal.sub,
    roles: resolved.roles,
    scopes: resolved.scopes,
    mfaLevel: mfaLevel || null,
    timezoneHint,
  };
}

/**
 * Build RequestContext from a validated API key.
 * Tenant API key path: uses tenant info from key validation.
 * Legacy API key path: defaults to tenantId='default', userId=null.
 */
export function buildContextFromApiKey(
  tenant?: TenantInfo,
  apiKeyRecord?: ApiKeyRecord,
): RequestContext {
  if (tenant && apiKeyRecord) {
    // Phase B: propagate isAdmin into roles so authorizeGraphMutation can check role-based access
    const roles: string[] = apiKeyRecord.isAdmin ? ['admin'] : [];
    return {
      tenantId: tenant.id,
      userId: null, // API keys don't carry user identity (until key migration)
      authType: 'api_key',
      apiKeyId: apiKeyRecord.id,
      idpSub: null,
      roles,
      scopes: apiKeyRecord.permissions || [],
      mfaLevel: null,
      timezoneHint: null,
    };
  }

  // Legacy API key — default tenant
  return { ...DEFAULT_REQUEST_CONTEXT };
}

/**
 * Build RequestContext for dev mode (ENABLE_DEV_HEADERS=1).
 * X-User-Id header accepted ONLY in dev mode.
 */
export function buildContextFromDevHeaders(req: Request): RequestContext {
  const userId = req.headers['x-user-id'] as string | null || null;
  const tenantId = (req.headers['x-tenant-id'] as string) || 'default';

  return {
    tenantId,
    userId,
    authType: 'dev',
    apiKeyId: null,
    idpSub: null,
    roles: ['dev'],
    scopes: ['*'],
    mfaLevel: null,
    timezoneHint: (req.headers['x-user-timezone'] as string) || null,
  };
}

/**
 * Extract bearer token from Authorization header.
 * Returns the token string or null if not a Bearer token.
 */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Determine if a bearer token is a JWT (vs an API key).
 * JWTs have 3 dot-separated base64 segments.
 */
export { isJwtShaped };
