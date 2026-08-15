import Database from 'better-sqlite3';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCredentialStore } from '../src/agent-auth/credential-store.js';
import {
  AgentAuthOperatorError,
  runAgentAuthOperator,
  runAgentAuthOperatorCli,
} from '../src/agent-auth/operator.js';

function makeDatabase(root: string): string {
  const path = join(root, 'hythe.db');
  const db = new Database(path);
  db.exec('CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO sentinel (value) VALUES (?)').run('preserve-me');
  db.close();
  return path;
}

function expectOperatorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected operator action to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAuthOperatorError);
    expect((error as AgentAuthOperatorError).code).toBe(code);
  }
}

describe('offline agent-credential operator', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { root: string; dbPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'hythe-agent-auth-operator-'));
    roots.push(root);
    return { root, dbPath: makeDatabase(root) };
  }

  it('creates a principal explicitly, writes the secret once at mode 0600, and emits only safe JSON', () => {
    const { root, dbPath } = fixture();
    const secretFile = join(root, 'agent.key');
    let stdout = '';
    let stderr = '';
    const exitCode = runAgentAuthOperatorCli([
      'issue',
      '--db', dbPath,
      '--tenant-id', 'default',
      '--agent-id', 'codex-houston',
      '--actor', 'operator-1',
      '--scope', 'message:read',
      '--scope', 'agent:self',
      '--secret-file', secretFile,
      '--create-principal',
    ], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const token = readFileSync(secretFile, 'utf8').trim();
    expect(token).toMatch(/^hya1_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(stdout).not.toContain(token);
    expect(stdout).not.toContain('token_hash');
    expect(stdout).not.toContain('tokenHash');

    const audit = JSON.parse(stdout);
    expect(audit).toMatchObject({
      schemaVersion: 1,
      tool: 'hythe-agent-auth-operator',
      operation: 'issue',
      outcome: 'applied',
      tenantId: 'default',
      agentId: 'codex-houston',
      secretDelivery: { mode: '0600', format: 'raw-token' },
      principal: { enforcementState: 'staged' },
    });
    expect(audit.credentials).toHaveLength(1);
    expect(audit.credentials[0].scopes).toEqual(['agent:self', 'message:read']);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      'SELECT token_hash FROM agent_credentials WHERE credential_id = ?',
    ).get(audit.credentials[0].credentialId) as { token_hash: Buffer };
    expect(row.token_hash).toBeInstanceOf(Buffer);
    expect(row.token_hash.length).toBe(32);
    expect(row.token_hash.toString('utf8')).not.toContain(token);
    expect(db.prepare('SELECT value FROM sentinel').pluck().get()).toBe('preserve-me');
    db.close();
  });

  it('rejects operation-irrelevant CLI flags instead of silently ignoring them', () => {
    const { dbPath } = fixture();
    let stderr = '';
    const exitCode = runAgentAuthOperatorCli([
      'promote',
      '--db', dbPath,
      '--tenant-id', 'default',
      '--agent-id', 'codex-houston',
      '--actor', 'operator-1',
      '--credential-id', '0'.repeat(24),
      '--scope', 'memory:admin',
    ], {
      stdout: { write: () => undefined },
      stderr: { write: (value) => { stderr += value; } },
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({
      outcome: 'refused',
      code: 'INVALID_ARGUMENT',
    });
  });

  it('requires an explicit create and preserves exact case-sensitive principal identity', () => {
    const { root, dbPath } = fixture();
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'ReviewCase',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'missing.key'),
      now: '2026-08-14T00:00:00.000Z',
    }), 'PRINCIPAL_NOT_FOUND');

    const issued = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'ReviewCase',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'created.key'),
      createPrincipal: true,
      now: '2026-08-14T00:01:00.000Z',
    });
    expect(issued.principal).toMatchObject({ agentId: 'ReviewCase' });

    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'reviewcase',
      actor: 'operator-1',
      credentialId: issued.credentials[0].credentialId as string,
      now: '2026-08-14T00:02:00.000Z',
    }), 'PRINCIPAL_NOT_FOUND');
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'ReviewCase',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'duplicate.key'),
      createPrincipal: true,
      now: '2026-08-14T00:03:00.000Z',
    }), 'PRINCIPAL_ALREADY_EXISTS');

    const token = readFileSync(join(root, 'created.key'), 'utf8').trim();
    const canaryDb = new Database(dbPath);
    const canaryStore = new AgentCredentialStore(canaryDb);
    expect(canaryStore.validateCredential({
      token,
      tenantId: 'default',
      now: '2026-08-14T00:03:30.000Z',
    }).valid).toBe(true);
    const credentialId = issued.credentials[0].credentialId as string;
    canaryStore.markCredentialAttested(
      credentialId,
      'mixed',
      '2026-08-14T00:03:40.000Z',
    );
    canaryDb.close();

    const promoted = runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'ReviewCase',
      actor: 'operator-1',
      credentialId,
      now: '2026-08-14T00:04:00.000Z',
    });
    expect(promoted).toMatchObject({
      outcome: 'applied',
      principal: { agentId: 'ReviewCase', enforcementState: 'enforced' },
    });
    const repeated = runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'ReviewCase',
      actor: 'operator-2',
      credentialId,
      now: '2026-08-14T00:05:00.000Z',
    });
    expect(repeated.outcome).toBe('unchanged');
    expect(repeated.principal).toMatchObject({ promotedBy: 'operator-1' });
  });

  it('refuses promotion with no credential or only an unused credential', () => {
    const { root, dbPath } = fixture();
    let db = new Database(dbPath);
    let store = new AgentCredentialStore(db);
    store.ensurePrincipal({
      tenantId: 'default',
      agentId: 'no-credential',
      createdBy: 'operator-1',
      now: '2026-08-14T00:00:00.000Z',
    });
    db.close();

    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'no-credential',
      actor: 'operator-1',
      credentialId: '0'.repeat(24),
      now: '2026-08-14T01:00:00.000Z',
    }), 'CREDENTIAL_NOT_FOUND');

    const unused = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'unused-credential',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'unused.key'),
      createPrincipal: true,
      now: '2026-08-14T00:00:00.000Z',
    });
    const unusedToken = readFileSync(join(root, 'unused.key'), 'utf8').trim();
    db = new Database(dbPath);
    store = new AgentCredentialStore(db);
    expect(store.validateCredential({
      token: unusedToken,
      tenantId: 'default',
      now: '2026-08-14T00:30:00.000Z',
    }).valid).toBe(true);
    db.close();
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'unused-credential',
      actor: 'operator-1',
      credentialId: unused.credentials[0].credentialId as string,
      now: '2026-08-14T01:00:00.000Z',
    }), 'PRINCIPAL_NOT_CANARY_PROVEN');

    db = new Database(dbPath, { readonly: true });
    store = new AgentCredentialStore(db);
    expect(store.getPrincipal('default', 'no-credential')?.enforcementState).toBe('staged');
    expect(store.getPrincipal('default', 'unused-credential')?.enforcementState).toBe('staged');
    db.close();
  });

  it('binds promotion to the exact freshly attested rotation credential', () => {
    const { root, dbPath } = fixture();
    const old = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'rotation-canary-agent',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'rotation-old.key'),
      createPrincipal: true,
      now: '2026-08-14T00:00:00.000Z',
    });
    let db = new Database(dbPath);
    let store = new AgentCredentialStore(db);
    store.markCredentialAttested(
      old.credentials[0].credentialId as string,
      'mixed',
      '2026-08-14T00:10:00.000Z',
    );
    db.close();

    const rotated = runAgentAuthOperator({
      operation: 'rotate',
      dbPath,
      tenantId: 'default',
      agentId: 'rotation-canary-agent',
      actor: 'operator-1',
      credentialId: old.credentials[0].credentialId as string,
      secretFile: join(root, 'rotation-new.key'),
      now: '2026-08-14T00:20:00.000Z',
    });
    const replacementId = rotated.rotation!.replacementCredentialId;
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'rotation-canary-agent',
      actor: 'operator-1',
      credentialId: replacementId,
      now: '2026-08-14T00:30:00.000Z',
    }), 'PRINCIPAL_NOT_CANARY_PROVEN');

    db = new Database(dbPath);
    store = new AgentCredentialStore(db);
    store.markCredentialAttested(replacementId, 'required', '2026-08-14T00:40:00.000Z');
    db.close();
    expect(runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'rotation-canary-agent',
      actor: 'operator-1',
      credentialId: replacementId,
      now: '2026-08-14T00:50:00.000Z',
    })).toMatchObject({
      outcome: 'applied',
      principal: { enforcementState: 'enforced' },
      credentials: [{ credentialId: replacementId }],
    });
  });

  it('refuses promotion when every credential is future, expired, or revoked', () => {
    const { root, dbPath } = fixture();

    const future = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'future-agent',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'future.key'),
      createPrincipal: true,
      notBefore: '2026-08-14T05:00:00.000Z',
      now: '2026-08-14T00:00:00.000Z',
    });
    let db = new Database(dbPath);
    db.prepare(
      `UPDATE agent_credentials SET last_used_at = ?
       WHERE tenant_id = ? AND agent_id = ?`,
    ).run('2026-08-14T00:30:00.000Z', 'default', 'future-agent');
    db.close();
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'future-agent',
      actor: 'operator-1',
      credentialId: future.credentials[0].credentialId as string,
      now: '2026-08-14T01:00:00.000Z',
    }), 'PRINCIPAL_NOT_CANARY_PROVEN');

    const expired = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'expired-agent',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'expired.key'),
      createPrincipal: true,
      expiresAt: '2026-08-14T02:00:00.000Z',
      now: '2026-08-14T00:00:00.000Z',
    });
    db = new Database(dbPath);
    let store = new AgentCredentialStore(db);
    expect(store.validateCredential({
      token: readFileSync(join(root, 'expired.key'), 'utf8').trim(),
      now: '2026-08-14T01:00:00.000Z',
    }).valid).toBe(true);
    db.close();
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'expired-agent',
      actor: 'operator-1',
      credentialId: expired.credentials[0].credentialId as string,
      now: '2026-08-14T03:00:00.000Z',
    }), 'PRINCIPAL_NOT_CANARY_PROVEN');

    const revoked = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'revoked-agent',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile: join(root, 'revoked.key'),
      createPrincipal: true,
      now: '2026-08-14T00:00:00.000Z',
    });
    const revokedToken = readFileSync(join(root, 'revoked.key'), 'utf8').trim();
    db = new Database(dbPath);
    store = new AgentCredentialStore(db);
    expect(store.validateCredential({
      token: revokedToken,
      now: '2026-08-14T01:00:00.000Z',
    }).valid).toBe(true);
    db.close();
    runAgentAuthOperator({
      operation: 'revoke',
      dbPath,
      tenantId: 'default',
      agentId: 'revoked-agent',
      actor: 'operator-1',
      credentialId: revoked.credentials[0].credentialId as string,
      now: '2026-08-14T02:00:00.000Z',
    });
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'promote',
      dbPath,
      tenantId: 'default',
      agentId: 'revoked-agent',
      actor: 'operator-1',
      credentialId: revoked.credentials[0].credentialId as string,
      now: '2026-08-14T03:00:00.000Z',
    }), 'PRINCIPAL_NOT_CANARY_PROVEN');
  });

  it('keeps overlap during rotation, refuses a stale second rotation, then revokes only the old key', () => {
    const { root, dbPath } = fixture();
    const oldFile = join(root, 'old.key');
    const issued = runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'codex-hythe',
      actor: 'operator-1',
      scopes: ['agent:self', 'state:read'],
      secretFile: oldFile,
      createPrincipal: true,
      now: '2026-08-14T01:00:00.000Z',
    });
    const oldCredentialId = issued.credentials[0].credentialId as string;
    const oldToken = readFileSync(oldFile, 'utf8').trim();

    const newFile = join(root, 'new.key');
    const rotated = runAgentAuthOperator({
      operation: 'rotate',
      dbPath,
      tenantId: 'default',
      agentId: 'codex-hythe',
      actor: 'operator-1',
      credentialId: oldCredentialId,
      secretFile: newFile,
      now: '2026-08-14T02:00:00.000Z',
    });
    const newCredentialId = rotated.rotation!.replacementCredentialId;
    const newToken = readFileSync(newFile, 'utf8').trim();
    expect(newToken).not.toBe(oldToken);
    expect(rotated.rotation).toEqual({
      replacedCredentialId: oldCredentialId,
      replacementCredentialId: newCredentialId,
      overlapActive: true,
    });

    let db = new Database(dbPath);
    let store = new AgentCredentialStore(db);
    expect(store.validateCredential({
      token: oldToken,
      now: '2026-08-14T02:30:00.000Z',
      updateLastUsed: false,
    }).valid).toBe(true);
    expect(store.validateCredential({
      token: newToken,
      now: '2026-08-14T02:30:00.000Z',
      updateLastUsed: false,
    }).valid).toBe(true);
    db.close();

    const staleFile = join(root, 'stale.key');
    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'rotate',
      dbPath,
      tenantId: 'default',
      agentId: 'codex-hythe',
      actor: 'operator-1',
      credentialId: oldCredentialId,
      secretFile: staleFile,
      now: '2026-08-14T03:00:00.000Z',
    }), 'CREDENTIAL_ALREADY_ROTATED');
    expect(() => statSync(staleFile)).toThrow();

    const revoked = runAgentAuthOperator({
      operation: 'revoke',
      dbPath,
      tenantId: 'default',
      agentId: 'codex-hythe',
      actor: 'operator-2',
      credentialId: oldCredentialId,
      now: '2026-08-14T04:00:00.000Z',
    });
    expect(revoked.credentials[0]).toMatchObject({
      credentialId: oldCredentialId,
      status: 'revoked',
      revokedBy: 'operator-2',
    });

    db = new Database(dbPath);
    store = new AgentCredentialStore(db);
    expect(store.validateCredential({
      token: oldToken,
      now: '2026-08-14T04:30:00.000Z',
      updateLastUsed: false,
    })).toMatchObject({ valid: false, reason: 'revoked' });
    expect(store.validateCredential({
      token: newToken,
      now: '2026-08-14T04:30:00.000Z',
      updateLastUsed: false,
    }).valid).toBe(true);
    db.close();
  });

  it('rolls back all database work when the requested secret path already exists', () => {
    const { root, dbPath } = fixture();
    const secretFile = join(root, 'occupied.key');
    writeFileSync(secretFile, 'do-not-overwrite\n', { mode: 0o600 });

    expectOperatorCode(() => runAgentAuthOperator({
      operation: 'issue',
      dbPath,
      tenantId: 'default',
      agentId: 'new-agent',
      actor: 'operator-1',
      scopes: ['agent:self'],
      secretFile,
      createPrincipal: true,
      now: '2026-08-14T00:00:00.000Z',
    }), 'SECRET_FILE_EXISTS');
    expect(readFileSync(secretFile, 'utf8')).toBe('do-not-overwrite\n');

    const db = new Database(dbPath, { readonly: true });
    const schema = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_principals'",
    ).get();
    expect(schema).toBeUndefined();
    expect(db.prepare('SELECT value FROM sentinel').pluck().get()).toBe('preserve-me');
    db.close();
  });

  it('refuses immediately when another connection holds the database write lock', () => {
    const { dbPath } = fixture();
    const blocker = new Database(dbPath);
    blocker.pragma('journal_mode = DELETE');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expectOperatorCode(() => runAgentAuthOperator({
        operation: 'status',
        dbPath,
        tenantId: 'default',
        agentId: 'codex-hythe',
      }), 'DATABASE_NOT_OFFLINE');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('reports status without schema mutation, secrets, or hashes', () => {
    const { dbPath } = fixture();
    const audit = runAgentAuthOperator({
      operation: 'status',
      dbPath,
      tenantId: 'default',
      agentId: 'missing-agent',
    });
    expect(audit).toMatchObject({
      operation: 'status',
      outcome: 'inspected',
      schemaPresent: false,
      principal: null,
      credentials: [],
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('hash');

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_principals'",
    ).get()).toBeUndefined();
    db.close();
  });
});
