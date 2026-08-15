import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentCredentialStore,
  AgentAuthorizationError,
  applyAgentPrincipalSchema,
  bindAgentInvocation,
  bindMessageResourceRecipient,
  createAgentCredentialMiddleware,
  decideAgentAuthorization,
} from '../src/agent-auth/index.js';
import type { RequestContext } from '../src/middleware/auth/types.js';
import { MemoryManager } from '../src/unified-server/memory/index.js';

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: 'default',
    userId: null,
    authType: 'api_key',
    apiKeyId: 'base-key',
    idpSub: null,
    roles: [],
    scopes: ['*'],
    mfaLevel: null,
    timezoneHint: null,
    agentPrincipal: null,
    agentCredentialPresented: false,
    agentAuthMode: 'observe',
    ...overrides,
  };
}

describe('server-authoritative agent credential foundation', () => {
  let db: Database.Database;
  let store: AgentCredentialStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new AgentCredentialStore(db);
  });

  afterEach(() => db.close());

  it('creates the additive schema idempotently and preserves exact case-sensitive principals', () => {
    applyAgentPrincipalSchema(db);
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'ReviewCase',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'reviewcase',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });

    const rows = db.prepare(
      `SELECT agent_id FROM agent_principals ORDER BY agent_id COLLATE BINARY`
    ).all() as Array<{ agent_id: string }>;
    expect(rows.map((row) => row.agent_id)).toEqual(['ReviewCase', 'reviewcase']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('issues a 256-bit secret once and stores only its hash', () => {
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'codex-houston',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const issued = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['message:read', 'message:send', 'agent:self'],
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });

    expect(issued.token).toMatch(/^hya1_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
    expect(issued.credential.scopes).toEqual(['agent:self', 'message:read', 'message:send']);
    const raw = db.prepare(
      `SELECT token_hash, scopes_json FROM agent_credentials WHERE credential_id = ?`
    ).get(issued.credential.credentialId) as { token_hash: Buffer; scopes_json: string };
    expect(raw.token_hash).toBeInstanceOf(Buffer);
    expect(raw.token_hash.length).toBe(32);
    expect(raw.token_hash.toString('utf8')).not.toContain(issued.token);
    expect(JSON.stringify(raw)).not.toContain(issued.token);
  });

  it('validates tenant, time, revocation, and disabled-principal boundaries', () => {
    store.ensurePrincipal({
      tenantId: 'tenant-a',
      agentId: 'codex-hythe',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const issued = store.issueCredential({
      tenantId: 'tenant-a',
      agentId: 'codex-hythe',
      scopes: ['agent:self'],
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
      notBefore: '2026-08-14T01:00:00.000Z',
      expiresAt: '2026-08-14T03:00:00.000Z',
    });

    expect(store.validateCredential({
      token: issued.token,
      tenantId: 'tenant-a',
      now: '2026-08-14T00:30:00.000Z',
    })).toMatchObject({ valid: false, reason: 'not_yet_valid' });
    expect(store.validateCredential({
      token: issued.token,
      tenantId: 'tenant-b',
      now: '2026-08-14T02:00:00.000Z',
    })).toMatchObject({ valid: false, reason: 'tenant_mismatch' });
    expect(store.validateCredential({
      token: `${issued.token.slice(0, -1)}x`,
      tenantId: 'tenant-a',
      now: '2026-08-14T02:00:00.000Z',
    })).toMatchObject({ valid: false, reason: 'hash_mismatch' });
    expect(store.validateCredential({
      token: issued.token,
      tenantId: 'tenant-a',
      now: '2026-08-14T02:00:00.000Z',
    })).toMatchObject({
      valid: true,
      principal: { tenantId: 'tenant-a', agentId: 'codex-hythe' },
    });
    expect(store.validateCredential({
      token: issued.token,
      tenantId: 'tenant-a',
      now: '2026-08-14T03:00:00.000Z',
    })).toMatchObject({ valid: false, reason: 'expired' });

    store.setPrincipalState({
      tenantId: 'tenant-a',
      agentId: 'codex-hythe',
      state: 'disabled',
      actor: 'operator-1',
      now: '2026-08-14T02:30:00.000Z',
    });
    expect(store.validateCredential({
      token: issued.token,
      tenantId: 'tenant-a',
      now: '2026-08-14T02:45:00.000Z',
    })).toMatchObject({ valid: false, reason: 'principal_disabled' });
  });

  it('supports overlap rotation followed by explicit old-key revocation', () => {
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'codex-mud',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const old = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-mud',
      scopes: ['agent:self'],
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const rotated = store.rotateCredential({
      credentialId: old.credential.credentialId,
      tenantId: 'default',
      agentId: 'codex-mud',
      scopes: ['agent:self'],
      createdBy: 'operator-1',
      now: '2026-08-14T01:00:00.000Z',
    });

    expect(rotated.token).not.toBe(old.token);
    expect(rotated.replaced.replacedBy).toBe(rotated.credential.credentialId);
    expect(store.validateCredential({
      token: old.token,
      now: '2026-08-14T02:00:00.000Z',
    }).valid).toBe(true);
    expect(store.validateCredential({
      token: rotated.token,
      now: '2026-08-14T02:00:00.000Z',
    }).valid).toBe(true);

    store.revokeCredential({
      credentialId: old.credential.credentialId,
      actor: 'operator-1',
      now: '2026-08-14T02:30:00.000Z',
    });
    expect(store.validateCredential({
      token: old.token,
      now: '2026-08-14T02:45:00.000Z',
    })).toMatchObject({ valid: false, reason: 'revoked' });
    expect(store.validateCredential({
      token: rotated.token,
      now: '2026-08-14T02:45:00.000Z',
    }).valid).toBe(true);
  });

  it('never downgrades an invalid proof and reserves enforced principals in mixed mode', () => {
    const invalid = { valid: false as const, reason: 'unknown' as const, credentialId: 'missing' };
    expect(decideAgentAuthorization({
      mode: 'observe',
      claimedAgentId: 'codex-houston',
      credentialPresented: true,
      validation: invalid,
    })).toMatchObject({ allowed: false, reason: 'invalid_credential' });

    expect(decideAgentAuthorization({
      mode: 'mixed',
      claimedAgentId: 'codex-houston',
      credentialPresented: false,
      validation: { valid: false, reason: 'missing', credentialId: null },
      claimedPrincipalState: 'enforced',
    })).toMatchObject({ allowed: false, reason: 'credential_required' });

    expect(decideAgentAuthorization({
      mode: 'mixed',
      claimedAgentId: 'unclaimed-agent',
      credentialPresented: false,
      validation: { valid: false, reason: 'missing', credentialId: null },
      claimedPrincipalState: null,
    })).toMatchObject({ allowed: true, legacy: true, reason: 'legacy_unclaimed' });

    expect(decideAgentAuthorization({
      mode: 'required',
      claimedAgentId: 'unclaimed-agent',
      credentialPresented: false,
      validation: { valid: false, reason: 'missing', credentialId: null },
    })).toMatchObject({ allowed: false, reason: 'credential_required' });

    expect(decideAgentAuthorization({
      mode: 'observe',
      claimedAgentId: 'retired-agent',
      credentialPresented: false,
      validation: { valid: false, reason: 'missing', credentialId: null },
      claimedPrincipalState: 'disabled',
    })).toMatchObject({ allowed: false, reason: 'principal_disabled' });
  });

  it('requires dual proof, rejects URL credentials, and derives the exact principal in middleware', async () => {
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'codex-houston',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const issued = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['agent:self'],
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const app = express();
    app.use((req: any, _res, next) => {
      if (req.headers['x-base-key'] === 'valid') req.requestContext = requestContext();
      next();
    });
    app.use(createAgentCredentialMiddleware(store, 'mixed'));
    app.get('/probe', (req: any, res) => res.json(req.requestContext?.agentPrincipal ?? null));

    await request(app)
      .get('/probe')
      .set('x-hythe-agent-key', issued.token)
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('AGENT_BASE_AUTH_REQUIRED'));
    await request(app)
      .get(`/probe?hythe_agent_key=${encodeURIComponent(issued.token)}`)
      .set('x-base-key', 'valid')
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('AGENT_CREDENTIAL_IN_URL'));
    await request(app)
      .get('/probe')
      .set('x-base-key', 'valid')
      .set('x-hythe-agent-key', issued.token)
      .set('x-hythe-agent-id', 'codex-hythe')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('AGENT_IDENTITY_MISMATCH'));
    expect(store.getCredential(issued.credential.credentialId)?.lastUsedAt).toBeNull();
    await request(app)
      .get('/probe')
      .set('x-base-key', 'valid')
      .set('x-hythe-agent-key', issued.token)
      .set('x-hythe-agent-id', 'codex-houston')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          agentId: 'codex-houston',
          credentialId: issued.credential.credentialId,
          scopes: ['agent:self'],
        });
        expect(JSON.stringify(body)).not.toContain(issued.token);
      });
    expect(store.getCredential(issued.credential.credentialId)?.lastUsedAt).not.toBeNull();
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM agent_credential_attestations
       WHERE credential_id = ?`,
    ).get(issued.credential.credentialId) as any).count).toBe(0);
    expect(store.markCredentialAttested(
      issued.credential.credentialId,
      'mixed',
      '2026-08-14T00:05:00.000Z',
    )).toMatchObject({
      credentialId: issued.credential.credentialId,
      tenantId: 'default',
      agentId: 'codex-houston',
      authMode: 'mixed',
    });
  });

  it('binds actors server-side, preserves targets, enforces scopes, and refuses downgrade', () => {
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'codex-houston',
      enforcementState: 'enforced',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const credentialContext = requestContext({
      agentAuthMode: 'mixed',
      agentCredentialPresented: true,
      agentPrincipal: {
        agentId: 'codex-houston',
        credentialId: 'credential-1',
        scopes: ['message:send', 'message:read', 'state:*'],
        enforcementState: 'enforced',
      },
    });

    expect(bindAgentInvocation(
      'send_ai_message',
      { to: 'codex-hythe', agentId: 'target-alias' },
      credentialContext,
      store,
    )).toEqual({ to: 'codex-hythe', agentId: 'target-alias', from: 'codex-houston' });
    expect(bindAgentInvocation(
      'resume',
      { project: 'hythe' },
      credentialContext,
      store,
    )).toMatchObject({ project: 'hythe', agentId: 'codex-houston' });
    expect(() => bindAgentInvocation(
      'get_ai_messages',
      { agentId: 'codex-hythe' },
      credentialContext,
      store,
    )).toThrowError(AgentAuthorizationError);
    expect(() => bindAgentInvocation(
      'create_entities',
      { entities: [] },
      credentialContext,
      store,
    )).toThrowError(/memory:write/);
    expect(() => bindAgentInvocation(
      'get_user_profile',
      { userId: 'operator-user' },
      credentialContext,
      store,
    )).toThrowError(/profile:read/);
    expect(() => bindAgentInvocation(
      'gc_agent_registrations',
      {},
      credentialContext,
      store,
    )).toThrowError(/agent:admin/);
    expect(() => bindAgentInvocation(
      'search_entities',
      { query: 'shared' },
      credentialContext,
      store,
    )).toThrowError(/memory:read/);

    const sharedReadContext = requestContext({
      ...credentialContext,
      agentPrincipal: {
        ...credentialContext.agentPrincipal!,
        scopes: [...credentialContext.agentPrincipal!.scopes, 'memory:read'],
      },
    });
    expect(bindAgentInvocation(
      'search_entities',
      { query: 'shared' },
      sharedReadContext,
      store,
    )).toEqual({ query: 'shared' });

    const legacyContext = requestContext({ agentAuthMode: 'mixed' });
    expect(() => bindAgentInvocation(
      'get_ai_messages',
      { agentId: 'codex-houston' },
      legacyContext,
      store,
    )).toThrowError(/not authorized/);
    expect(bindAgentInvocation(
      'get_ai_messages',
      { agentId: 'unclaimed-agent' },
      legacyContext,
      store,
    )).toMatchObject({ agentId: 'unclaimed-agent' });
    expect(bindAgentInvocation(
      'get_ai_messages',
      {},
      requestContext({ agentAuthMode: 'observe' }),
      store,
    )).toEqual({});
    expect(() => bindAgentInvocation(
      'get_ai_messages',
      {},
      requestContext({ agentAuthMode: 'mixed' }),
      store,
    )).toThrowError(/explicit agent identity/);
  });

  it('intersects tenant base scopes with agent scopes while preserving trusted base authorities', () => {
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'codex-houston',
      enforcementState: 'enforced',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    const agentPrincipal = {
      agentId: 'codex-houston',
      credentialId: 'credential-1',
      scopes: ['message:read'],
      enforcementState: 'enforced' as const,
    };
    const credentialContext = {
      agentAuthMode: 'required' as const,
      agentCredentialPresented: true,
      agentPrincipal,
    };
    const readOwnMailbox = (context: RequestContext) => bindAgentInvocation(
      'get_ai_messages',
      { agentId: 'codex-houston' },
      context,
      store,
    );

    const restrictedTenant = requestContext({
      ...credentialContext,
      apiKeyId: 'restricted-tenant-key',
      scopes: ['profile:read'],
    });
    let restrictedError: unknown;
    try {
      readOwnMailbox(restrictedTenant);
    } catch (error) {
      restrictedError = error;
    }
    expect(restrictedError).toMatchObject({
      code: 'BASE_SCOPE_REQUIRED',
      status: 403,
      message: 'Base credential lacks required scope message:read',
    });

    for (const context of [
      requestContext({ ...credentialContext, apiKeyId: 'full-tenant-key', scopes: ['*'] }),
      requestContext({ ...credentialContext, apiKeyId: null, scopes: [] }),
      requestContext({ ...credentialContext, authType: 'dev', apiKeyId: null, scopes: [] }),
      requestContext({
        ...credentialContext,
        authType: 'jwt',
        apiKeyId: null,
        roles: ['admin'],
        scopes: [],
      }),
      requestContext({
        ...credentialContext,
        authType: 'jwt',
        apiKeyId: null,
        roles: ['owner'],
        scopes: [],
      }),
    ]) {
      expect(readOwnMailbox(context)).toEqual({ agentId: 'codex-houston' });
    }
  });

  it('binds message resource reads to the authenticated recipient', () => {
    const context = requestContext({
      agentAuthMode: 'required',
      agentCredentialPresented: true,
      agentPrincipal: {
        agentId: 'codex-houston',
        credentialId: 'credential-1',
        scopes: ['message:read'],
        enforcementState: 'enforced',
      },
    });
    expect(() => bindMessageResourceRecipient(
      'engram://message/p%3Aproject/codex-houston/message-1',
      context,
      store,
    )).not.toThrow();
    expect(() => bindMessageResourceRecipient(
      'engram://message/p%3Aproject/codex-hythe/message-1',
      context,
      store,
    )).toThrowError(/not authorized/);
    expect(() => bindMessageResourceRecipient(
      'engram://snapshot/p%3Aproject/state-1',
      context,
      store,
    )).toThrowError(/state:read/);
  });

  it('audits the exact agent principal while preserving shared and tenant base actors', async () => {
    const previousAdvancedMemory = process.env.ENABLE_ADVANCED_MEMORY;
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const manager = new MemoryManager(':memory:');
    if (previousAdvancedMemory === undefined) delete process.env.ENABLE_ADVANCED_MEMORY;
    else process.env.ENABLE_ADVANCED_MEMORY = previousAdvancedMemory;
    try {
      manager.auditMutationOp(
        'delete_entity',
        requestContext({
          apiKeyId: null,
          agentAuthMode: 'required',
          agentCredentialPresented: true,
          agentPrincipal: {
            agentId: 'codex-shared',
            credentialId: 'credential-shared',
            scopes: ['memory:admin'],
            enforcementState: 'enforced',
          },
        }),
        'shared-entity',
        ['shared-row'],
        'shared-key regression',
      );
      manager.auditMutationOp(
        'remove_observations',
        requestContext({
          tenantId: 'tenant-a',
          apiKeyId: 'tenant-key-a',
          agentAuthMode: 'required',
          agentCredentialPresented: true,
          agentPrincipal: {
            agentId: 'codex-tenant',
            credentialId: 'credential-tenant',
            scopes: ['memory:admin'],
            enforcementState: 'enforced',
          },
        }),
        'tenant-entity',
        ['tenant-row'],
        'tenant-key regression',
      );

      expect(manager.getDb().prepare(
        `SELECT operation, tenant_id, agent_id, actor_type, actor_id
         FROM neural_audit_log
         WHERE operation IN ('delete_entity', 'remove_observations')
         ORDER BY operation`,
      ).all()).toEqual([
        {
          operation: 'delete_entity',
          tenant_id: 'default',
          agent_id: 'codex-shared',
          actor_type: 'api_key',
          actor_id: 'system',
        },
        {
          operation: 'remove_observations',
          tenant_id: 'tenant-a',
          agent_id: 'codex-tenant',
          actor_type: 'api_key',
          actor_id: 'tenant-key-a',
        },
      ]);
    } finally {
      await manager.close();
    }
  });
});
