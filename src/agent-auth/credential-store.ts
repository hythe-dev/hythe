import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { applyAgentPrincipalSchema } from './schema.js';
import type {
  AgentAuthMode,
  AgentCredential,
  AgentCredentialValidation,
  AgentPrincipal,
  AgentPrincipalState,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SCOPE_PATTERN = /^[A-Za-z0-9*_.:-]+$/;
const TOKEN_PATTERN = /^hya1_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/;
const DUMMY_HASH = Buffer.alloc(32, 0xa5);

function validateOpaqueId(value: string, label: string, maximum = 100): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || !ID_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be 1-${maximum} exact characters from A-Z, a-z, 0-9, _, ., :, or -`);
  }
  return value;
}

function validateActor(value: string): string {
  return validateOpaqueId(value, 'actor', 128);
}

function normalizeScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 64) {
    throw new Error('scopes must contain 1-64 entries');
  }
  const normalized = Array.from(new Set(scopes)).sort();
  for (const scope of normalized) {
    if (
      typeof scope !== 'string'
      || scope.length < 1
      || scope.length > 128
      || !SCOPE_PATTERN.test(scope)
    ) {
      throw new Error('scope entries must be 1-128 safe characters');
    }
  }
  return normalized;
}

function parseTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function safeHashEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function mapPrincipal(row: any): AgentPrincipal {
  return {
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    displayName: row.display_name ?? null,
    enforcementState: row.enforcement_state,
    createdAt: row.created_at,
    createdBy: row.created_by,
    promotedAt: row.promoted_at ?? null,
    promotedBy: row.promoted_by ?? null,
    disabledAt: row.disabled_at ?? null,
    disabledBy: row.disabled_by ?? null,
  };
}

function mapCredential(row: any): AgentCredential {
  return {
    credentialId: row.credential_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    scopes: parseScopes(row.scopes_json),
    status: row.status,
    notBefore: row.not_before,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at ?? null,
    revokedBy: row.revoked_by ?? null,
    replacedBy: row.replaced_by ?? null,
  };
}

export interface IssueAgentCredentialInput {
  tenantId: string;
  agentId: string;
  scopes: string[];
  createdBy: string;
  notBefore?: string;
  expiresAt?: string | null;
  now?: string;
}

export class AgentCredentialStore {
  constructor(private readonly db: Database.Database) {
    applyAgentPrincipalSchema(db);
  }

  ensurePrincipal(input: {
    tenantId: string;
    agentId: string;
    displayName?: string | null;
    enforcementState?: AgentPrincipalState;
    createdBy: string;
    now?: string;
  }): AgentPrincipal {
    const tenantId = validateOpaqueId(input.tenantId, 'tenantId', 128);
    const agentId = validateOpaqueId(input.agentId, 'agentId');
    const createdBy = validateActor(input.createdBy);
    const state = input.enforcementState ?? 'staged';
    if (!['staged', 'enforced', 'disabled'].includes(state)) {
      throw new Error('invalid principal enforcement state');
    }
    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    const displayName = input.displayName == null ? null : String(input.displayName).slice(0, 256);

    this.db.prepare(
      `INSERT INTO agent_principals (
         tenant_id, agent_id, display_name, enforcement_state, created_at, created_by,
         promoted_at, promoted_by, disabled_at, disabled_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, agent_id) DO NOTHING`
    ).run(
      tenantId,
      agentId,
      displayName,
      state,
      now,
      createdBy,
      state === 'enforced' ? now : null,
      state === 'enforced' ? createdBy : null,
      state === 'disabled' ? now : null,
      state === 'disabled' ? createdBy : null,
    );

    const principal = this.getPrincipal(tenantId, agentId);
    if (!principal) throw new Error('principal creation failed');
    return principal;
  }

  getPrincipal(tenantId: string, agentId: string): AgentPrincipal | null {
    const row = this.db.prepare(
      `SELECT * FROM agent_principals WHERE tenant_id = ? AND agent_id = ?`
    ).get(tenantId, agentId);
    return row ? mapPrincipal(row) : null;
  }

  setPrincipalState(input: {
    tenantId: string;
    agentId: string;
    state: AgentPrincipalState;
    actor: string;
    now?: string;
  }): AgentPrincipal {
    const tenantId = validateOpaqueId(input.tenantId, 'tenantId', 128);
    const agentId = validateOpaqueId(input.agentId, 'agentId');
    const actor = validateActor(input.actor);
    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    if (!['staged', 'enforced', 'disabled'].includes(input.state)) {
      throw new Error('invalid principal enforcement state');
    }

    const result = this.db.prepare(
      `UPDATE agent_principals
       SET enforcement_state = ?,
           promoted_at = CASE WHEN ? = 'enforced' THEN ? ELSE promoted_at END,
           promoted_by = CASE WHEN ? = 'enforced' THEN ? ELSE promoted_by END,
           disabled_at = CASE WHEN ? = 'disabled' THEN ? ELSE NULL END,
           disabled_by = CASE WHEN ? = 'disabled' THEN ? ELSE NULL END
       WHERE tenant_id = ? AND agent_id = ?`
    ).run(
      input.state,
      input.state,
      now,
      input.state,
      actor,
      input.state,
      now,
      input.state,
      actor,
      tenantId,
      agentId,
    );
    if (result.changes !== 1) throw new Error('principal not found');
    return this.getPrincipal(tenantId, agentId)!;
  }

  issueCredential(input: IssueAgentCredentialInput): {
    token: string;
    credential: AgentCredential;
  } {
    const tenantId = validateOpaqueId(input.tenantId, 'tenantId', 128);
    const agentId = validateOpaqueId(input.agentId, 'agentId');
    const createdBy = validateActor(input.createdBy);
    const scopes = normalizeScopes(input.scopes);
    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    const notBefore = parseTimestamp(input.notBefore ?? now, 'notBefore');
    const expiresAt = input.expiresAt == null
      ? null
      : parseTimestamp(input.expiresAt, 'expiresAt');
    if (expiresAt != null && Date.parse(expiresAt) <= Date.parse(notBefore)) {
      throw new Error('expiresAt must be later than notBefore');
    }

    const principal = this.getPrincipal(tenantId, agentId);
    if (!principal) throw new Error('principal not found');
    if (principal.enforcementState === 'disabled') throw new Error('principal is disabled');

    const credentialId = randomBytes(12).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const token = `hya1_${credentialId}_${secret}`;
    const tokenHash = hashToken(token);

    this.db.prepare(
      `INSERT INTO agent_credentials (
         credential_id, tenant_id, agent_id, token_hash, scopes_json, status,
         not_before, expires_at, last_used_at, created_at, created_by,
         revoked_at, revoked_by, replaced_by
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, NULL, NULL, NULL)`
    ).run(
      credentialId,
      tenantId,
      agentId,
      tokenHash,
      JSON.stringify(scopes),
      notBefore,
      expiresAt,
      now,
      createdBy,
    );

    const credential = this.getCredential(credentialId);
    if (!credential) throw new Error('credential creation failed');
    return { token, credential };
  }

  getCredential(credentialId: string): AgentCredential | null {
    const row = this.db.prepare(
      `SELECT credential_id, tenant_id, agent_id, scopes_json, status,
              not_before, expires_at, last_used_at, created_at, created_by,
              revoked_at, revoked_by, replaced_by
       FROM agent_credentials WHERE credential_id = ?`
    ).get(credentialId);
    return row ? mapCredential(row) : null;
  }

  markCredentialUsed(credentialId: string, now = new Date().toISOString()): AgentCredential {
    const usedAt = parseTimestamp(now, 'now');
    const result = this.db.prepare(
      `UPDATE agent_credentials
       SET last_used_at = CASE
         WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
         ELSE last_used_at
       END
       WHERE credential_id = ? AND status = 'active'`
    ).run(usedAt, usedAt, credentialId);
    if (result.changes !== 1) throw new Error('active credential not found');
    return this.getCredential(credentialId)!;
  }

  /**
   * Recheck the mutable credential/principal state for an already-authenticated
   * long-lived transport. The raw token is intentionally not retained by the
   * WebSocket connection after the upgrade proof has been verified.
   */
  isCredentialBindingActive(input: {
    credentialId: string;
    tenantId: string;
    agentId: string;
    now?: string;
  }): boolean {
    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    const nowMs = Date.parse(now);
    const row = this.db.prepare(
      `SELECT c.status, c.not_before, c.expires_at, p.enforcement_state
       FROM agent_credentials c
       JOIN agent_principals p
         ON p.tenant_id = c.tenant_id AND p.agent_id = c.agent_id
       WHERE c.credential_id = ? AND c.tenant_id = ? AND c.agent_id = ?`
    ).get(input.credentialId, input.tenantId, input.agentId) as any;
    if (!row || row.status !== 'active' || row.enforcement_state === 'disabled') return false;
    const notBeforeMs = Date.parse(row.not_before);
    const expiresAtMs = row.expires_at == null ? null : Date.parse(row.expires_at);
    return Number.isFinite(notBeforeMs)
      && nowMs >= notBeforeMs
      && (expiresAtMs == null || (Number.isFinite(expiresAtMs) && nowMs < expiresAtMs));
  }

  /** Record only a completed, server-derived /agent/whoami attestation. */
  markCredentialAttested(
    credentialId: string,
    authMode: AgentAuthMode,
    now = new Date().toISOString(),
  ): { credentialId: string; tenantId: string; agentId: string; authMode: AgentAuthMode; attestedAt: string } {
    if (!['observe', 'mixed', 'required'].includes(authMode)) {
      throw new Error('invalid agent authentication mode');
    }
    const attestedAt = parseTimestamp(now, 'now');
    const credential = this.getCredential(credentialId);
    if (!credential || !this.isCredentialBindingActive({
      credentialId,
      tenantId: credential.tenantId,
      agentId: credential.agentId,
      now: attestedAt,
    })) {
      throw new Error('active credential binding not found');
    }
    this.db.prepare(
      `INSERT INTO agent_credential_attestations
         (credential_id, tenant_id, agent_id, auth_mode, attested_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (credential_id) DO UPDATE SET
         auth_mode = excluded.auth_mode,
         attested_at = CASE
           WHEN agent_credential_attestations.attested_at < excluded.attested_at
             THEN excluded.attested_at
           ELSE agent_credential_attestations.attested_at
         END`
    ).run(credentialId, credential.tenantId, credential.agentId, authMode, attestedAt);
    const row = this.db.prepare(
      `SELECT credential_id, tenant_id, agent_id, auth_mode, attested_at
       FROM agent_credential_attestations WHERE credential_id = ?`
    ).get(credentialId) as any;
    return {
      credentialId: row.credential_id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      authMode: row.auth_mode,
      attestedAt: row.attested_at,
    };
  }

  validateCredential(input: {
    token?: string | null;
    tenantId?: string | null;
    now?: string;
    updateLastUsed?: boolean;
  }): AgentCredentialValidation {
    if (input.token == null || input.token === '') {
      return { valid: false, reason: 'missing', credentialId: null };
    }
    const token = String(input.token);
    const match = TOKEN_PATTERN.exec(token);
    const candidateHash = hashToken(token);
    const credentialId = match?.[1] ?? null;
    const row = credentialId
      ? this.db.prepare(
        `SELECT c.*, p.display_name, p.enforcement_state,
                p.created_at AS principal_created_at,
                p.created_by AS principal_created_by,
                p.promoted_at, p.promoted_by, p.disabled_at, p.disabled_by
         FROM agent_credentials c
         JOIN agent_principals p
           ON p.tenant_id = c.tenant_id AND p.agent_id = c.agent_id
         WHERE c.credential_id = ?`
      ).get(credentialId) as any
      : undefined;

    const expectedHash = row?.token_hash instanceof Buffer ? row.token_hash : DUMMY_HASH;
    const hashMatches = safeHashEqual(candidateHash, expectedHash);
    if (!match) return { valid: false, reason: 'malformed', credentialId: null };
    if (!row) return { valid: false, reason: 'unknown', credentialId };
    if (!hashMatches) return { valid: false, reason: 'hash_mismatch', credentialId };
    if (input.tenantId != null && input.tenantId !== row.tenant_id) {
      return { valid: false, reason: 'tenant_mismatch', credentialId };
    }
    if (row.status !== 'active') return { valid: false, reason: 'revoked', credentialId };
    if (row.enforcement_state === 'disabled') {
      return { valid: false, reason: 'principal_disabled', credentialId };
    }

    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    const nowMs = Date.parse(now);
    if (nowMs < Date.parse(row.not_before)) {
      return { valid: false, reason: 'not_yet_valid', credentialId };
    }
    if (row.expires_at != null && nowMs >= Date.parse(row.expires_at)) {
      return { valid: false, reason: 'expired', credentialId };
    }

    if (input.updateLastUsed !== false) {
      row.last_used_at = this.markCredentialUsed(credentialId!, now).lastUsedAt;
    }

    return {
      valid: true,
      principal: mapPrincipal({
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        display_name: row.display_name,
        enforcement_state: row.enforcement_state,
        created_at: row.principal_created_at,
        created_by: row.principal_created_by,
        promoted_at: row.promoted_at,
        promoted_by: row.promoted_by,
        disabled_at: row.disabled_at,
        disabled_by: row.disabled_by,
      }),
      credential: mapCredential(row),
    };
  }

  revokeCredential(input: {
    credentialId: string;
    actor: string;
    now?: string;
  }): AgentCredential {
    const actor = validateActor(input.actor);
    const now = parseTimestamp(input.now ?? new Date().toISOString(), 'now');
    const result = this.db.prepare(
      `UPDATE agent_credentials
       SET status = 'revoked', revoked_at = ?, revoked_by = ?
       WHERE credential_id = ? AND status = 'active'`
    ).run(now, actor, input.credentialId);
    if (result.changes !== 1) throw new Error('active credential not found');
    return this.getCredential(input.credentialId)!;
  }

  rotateCredential(input: IssueAgentCredentialInput & {
    credentialId: string;
  }): { token: string; credential: AgentCredential; replaced: AgentCredential } {
    const rotate = this.db.transaction(() => {
      const old = this.getCredential(input.credentialId);
      if (!old || old.status !== 'active') throw new Error('active credential not found');
      if (old.tenantId !== input.tenantId || old.agentId !== input.agentId) {
        throw new Error('credential principal mismatch');
      }
      const issued = this.issueCredential(input);
      this.db.prepare(
        `UPDATE agent_credentials SET replaced_by = ? WHERE credential_id = ?`
      ).run(issued.credential.credentialId, old.credentialId);
      return {
        ...issued,
        replaced: this.getCredential(old.credentialId)!,
      };
    });
    return rotate();
  }
}
