/**
 * Auth0 JWT verification adapter using jose (ESM-native).
 * Config-driven JWKS/issuer/audience. Local JWKS cache + background refresh.
 * Task 1000: RequestContext + Auth0 JWT + tenant-scoped handlers
 */

import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import type { AuthAdapter, VerifiedPrincipal, Auth0Config } from './types.js';

/**
 * Read Auth0 config from environment variables.
 * Returns null if required vars are not set (auth0 not configured).
 */
export function getAuth0Config(): Auth0Config | null {
  const domain = process.env.AUTH0_DOMAIN;
  if (!domain) return null;

  return {
    domain,
    clientId: process.env.AUTH0_CLIENT_ID || '',
    audience: process.env.AUTH0_AUDIENCE || '',
    issuer: process.env.AUTH0_ISSUER || `https://${domain}/`,
    jwksUri: process.env.AUTH0_JWKS_URI || `https://${domain}/.well-known/jwks.json`,
    claimsNamespace: process.env.AUTH0_CLAIMS_NAMESPACE || 'https://neural-mcp.local/',
  };
}

/**
 * Auth0 adapter — verifies JWT tokens using JWKS.
 * Uses jose's createRemoteJWKSet for automatic JWKS caching and background refresh.
 */
export class Auth0Adapter implements AuthAdapter {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  private config: Auth0Config;

  constructor(config: Auth0Config) {
    this.config = config;
    // jose handles JWKS caching, key rotation, and stale-if-error internally
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  async verifyBearer(token: string): Promise<VerifiedPrincipal> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.audience,
    });

    const ns = this.config.claimsNamespace;

    return {
      provider: 'auth0',
      iss: payload.iss || '',
      aud: payload.aud || '',
      sub: payload.sub || '',
      orgId: payload[`${ns}org_id`] as string | undefined,
      permissions: (payload.permissions as string[] | undefined) || [],
      claims: payload as Record<string, unknown>,
    };
  }
}

/**
 * Check if a bearer token looks like a JWT (has 3 dot-separated base64 segments).
 * This is a fast pre-check to avoid JWKS round-trips for API keys.
 */
export function isJwtShaped(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every(p => p.length > 0);
}
