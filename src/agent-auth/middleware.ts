import type { NextFunction, Request, Response } from 'express';
import type { TenantRequest } from '../middleware/security.js';
import type { AgentAuthMode } from './types.js';
import { AgentCredentialStore } from './credential-store.js';
import { recordAgentAuthDenial } from '../observability/metrics.js';

export const AGENT_KEY_HEADER = 'x-hythe-agent-key';
export const AGENT_ID_HEADER = 'x-hythe-agent-id';

const QUERY_KEY_NAMES = new Set([
  'agent_key',
  'agentkey',
  'hythe_agent_key',
  'hythe_agent_token',
  'agent_token',
  'x-hythe-agent-key',
  'x_hythe_agent_key',
]);

export function resolveAgentAuthMode(raw = process.env.HYTHE_AGENT_AUTH_MODE): AgentAuthMode {
  const mode = raw == null || raw === '' ? 'observe' : raw;
  if (mode !== 'observe' && mode !== 'mixed' && mode !== 'required') {
    throw new Error('HYTHE_AGENT_AUTH_MODE must be observe, mixed, or required');
  }
  return mode;
}

function singleHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a single non-empty header`);
  }
  return value;
}

function hasAgentKeyInQuery(req: Request): boolean {
  return Object.keys(req.query).some((key) => QUERY_KEY_NAMES.has(key.toLowerCase()));
}

/**
 * Bind an optional per-agent credential after the existing deployment/tenant
 * credential has authenticated the request. This middleware never treats an
 * agent token as a replacement for the base credential and never accepts one
 * from a URL. Operation-specific enforcement happens in the central binder.
 */
export function createAgentCredentialMiddleware(
  store: AgentCredentialStore,
  mode: AgentAuthMode,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantReq = req as TenantRequest;
    const context = tenantReq.requestContext;

    if (hasAgentKeyInQuery(req)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Agent credentials are accepted only in the X-Hythe-Agent-Key header',
        code: 'AGENT_CREDENTIAL_IN_URL',
      });
      return;
    }

    let token: string | null;
    let assertedAgentId: string | null;
    try {
      token = singleHeader(req, AGENT_KEY_HEADER);
      assertedAgentId = singleHeader(req, AGENT_ID_HEADER);
    } catch {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Malformed agent identity header',
        code: 'AGENT_IDENTITY_HEADER_MALFORMED',
      });
      return;
    }

    if (!context) {
      if (token != null || assertedAgentId != null) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'A valid deployment or tenant credential is required with agent proof',
          code: 'AGENT_BASE_AUTH_REQUIRED',
        });
        return;
      }
      next();
      return;
    }

    context.agentAuthMode = mode;
    context.agentCredentialPresented = token != null;
    context.agentPrincipal = null;

    if (token == null) {
      if (assertedAgentId != null) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'X-Hythe-Agent-Id requires a valid agent credential',
          code: 'AGENT_CREDENTIAL_REQUIRED',
        });
        return;
      }
      next();
      return;
    }

    const validation = store.validateCredential({
      token,
      tenantId: context.tenantId,
      updateLastUsed: false,
    });
    if (!validation.valid) {
      recordAgentAuthDenial(mode, 'invalid_credential');
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Agent credential validation failed',
        code: 'AGENT_CREDENTIAL_INVALID',
      });
      return;
    }

    if (assertedAgentId != null && assertedAgentId !== validation.principal.agentId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Asserted agent identity does not match the authenticated principal',
        code: 'AGENT_IDENTITY_MISMATCH',
      });
      return;
    }

    // A failed exact-identity assertion must never count as a canary. Only
    // record use after base proof, token validation, and the optional exact ID
    // assertion have all succeeded.
    store.markCredentialUsed(validation.credential.credentialId);

    context.agentPrincipal = {
      agentId: validation.principal.agentId,
      credentialId: validation.credential.credentialId,
      scopes: [...validation.credential.scopes],
      enforcementState: validation.principal.enforcementState,
    };
    next();
  };
}
