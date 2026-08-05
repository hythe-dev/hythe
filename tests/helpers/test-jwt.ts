/**
 * Test JWT minting utility for Auth0 integration tests (Phase C prep).
 *
 * Mints JWTs signed with a local test secret. These tokens match the claim
 * structure expected by Auth0Adapter.verifyBearer and LocalTenantResolver.resolve,
 * but will NOT pass Auth0 JWKS verification in production mode.
 *
 * To use these in integration tests the server must either:
 *   1. Run with a TEST_JWT_MODE env flag that swaps the Auth0Adapter for a
 *      local-secret verifier, or
 *   2. Use ENABLE_DEV_HEADERS=1 (dev mode) which bypasses JWT verification
 *      entirely and accepts X-User-Id / X-Tenant-Id headers instead.
 *
 * See contract-auth0-harness.test.ts for usage.
 */

import jwt from 'jsonwebtoken';

/** Test secret -- never used in production. */
export const TEST_JWT_SECRET = 'TEST_JWT_SECRET_FOR_NEURAL_MCP_TESTS';

/** Default claims namespace matching Auth0Adapter default. */
export const DEFAULT_CLAIMS_NAMESPACE = 'https://neural-mcp.local/';

/** Default issuer and audience for test tokens. */
export const TEST_ISSUER = 'https://test.auth0.com/';
export const TEST_AUDIENCE = 'https://neural-mcp-test';

export interface MintJwtOptions {
  /** Auth0 `sub` claim -- user identifier (e.g. "auth0|user123"). */
  sub: string;
  /** Tenant / org_id -- written as a namespaced claim. */
  orgId: string;
  /** Roles array -- written as a namespaced claim. */
  roles?: string[];
  /** Permissions array -- written as a top-level `permissions` claim. */
  permissions?: string[];
  /** Additional custom claims merged into the payload. */
  customClaims?: Record<string, unknown>;
  /** Override the claims namespace (default: DEFAULT_CLAIMS_NAMESPACE). */
  claimsNamespace?: string;
  /** Override the issuer (default: TEST_ISSUER). */
  issuer?: string;
  /** Override the audience (default: TEST_AUDIENCE). */
  audience?: string;
  /** Token lifetime in seconds (default: 3600 = 1 hour). */
  expiresInSeconds?: number;
  /** Override the signing secret (default: TEST_JWT_SECRET). */
  secret?: string;
}

/**
 * Mint a signed JWT with configurable claims that match the Auth0 claim
 * layout expected by the Neural MCP auth middleware.
 *
 * Claim mapping (mirrors Auth0Adapter.verifyBearer + LocalTenantResolver.resolve):
 *   - `sub` => principal.sub => userId
 *   - `${ns}org_id` => principal.orgId => tenantId
 *   - `${ns}roles` => resolved roles
 *   - `permissions` => principal.permissions => scopes
 *   - `${ns}mfa_level` => mfaLevel
 *   - `${ns}timezone` => timezoneHint
 */
export function mintTestJwt(options: MintJwtOptions): string {
  const ns = options.claimsNamespace ?? DEFAULT_CLAIMS_NAMESPACE;
  const iss = options.issuer ?? TEST_ISSUER;
  const aud = options.audience ?? TEST_AUDIENCE;
  const secret = options.secret ?? TEST_JWT_SECRET;
  const expiresIn = options.expiresInSeconds ?? 3600;

  const payload: Record<string, unknown> = {
    sub: options.sub,
    iss,
    aud,
    [`${ns}org_id`]: options.orgId,
    ...(options.roles ? { [`${ns}roles`]: options.roles } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.customClaims ?? {}),
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn,
    // sub, iss, aud already in payload -- prevent jwt.sign from overwriting
    noTimestamp: false,
  });
}

/**
 * Convenience: mint a "member" JWT for a given user + tenant.
 */
export function mintMemberJwt(userId: string, tenantId: string): string {
  return mintTestJwt({
    sub: userId,
    orgId: tenantId,
    roles: ['member'],
    permissions: ['graph:write'],
  });
}

/**
 * Convenience: mint an "admin" JWT for a given user + tenant.
 */
export function mintAdminJwt(userId: string, tenantId: string): string {
  return mintTestJwt({
    sub: userId,
    orgId: tenantId,
    roles: ['admin'],
    permissions: ['graph:write', 'admin:*'],
  });
}

/**
 * Decode a test JWT (without verification) to inspect claims.
 * Useful for test assertions.
 */
export function decodeTestJwt(token: string): jwt.JwtPayload | null {
  return jwt.decode(token) as jwt.JwtPayload | null;
}
