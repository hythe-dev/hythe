import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DDL } from './008-agent-principals.mjs';

function apply(db) {
  db.pragma('foreign_keys = ON');
  const run = db.transaction(() => {
    for (const statement of DDL) {
      if (!/^\s*PRAGMA\b/i.test(statement)) db.exec(statement);
    }
  });
  run();
}

test('008 applies atomically and idempotently with exact principal identities', () => {
  const db = new Database(':memory:');
  try {
    apply(db);
    apply(db);
    const insert = db.prepare(
      `INSERT INTO agent_principals
       (tenant_id, agent_id, display_name, enforcement_state, created_at, created_by)
       VALUES (?, ?, NULL, 'staged', ?, ?)`,
    );
    insert.run('default', 'ReviewCase', '2026-08-14T00:00:00.000Z', 'operator');
    insert.run('default', 'reviewcase', '2026-08-14T00:00:00.000Z', 'operator');
    assert.deepEqual(
      db.prepare('SELECT agent_id FROM agent_principals ORDER BY agent_id COLLATE BINARY')
        .all()
        .map((row) => row.agent_id),
      ['ReviewCase', 'reviewcase'],
    );
    assert.throws(
      () => insert.run('default', 'ReviewCase', '2026-08-14T00:00:00.000Z', 'operator'),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('008 enforces hash length, JSON scopes, principal ownership, and immutable references', () => {
  const db = new Database(':memory:');
  try {
    apply(db);
    db.prepare(
      `INSERT INTO agent_principals
       (tenant_id, agent_id, display_name, enforcement_state, created_at, created_by)
       VALUES ('tenant-a', 'codex-houston', NULL, 'enforced', '2026-08-14T00:00:00Z', 'operator')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO agent_credentials
       (credential_id, tenant_id, agent_id, token_hash, scopes_json, status,
        not_before, expires_at, last_used_at, created_at, created_by,
        revoked_at, revoked_by, replaced_by)
       VALUES (?, ?, ?, ?, ?, 'active', '2026-08-14T00:00:00Z', NULL, NULL,
               '2026-08-14T00:00:00Z', 'operator', NULL, NULL, NULL)`,
    );
    assert.throws(
      () => insert.run('bad-hash', 'tenant-a', 'codex-houston', Buffer.alloc(31), '["agent:self"]'),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run('bad-scopes', 'tenant-a', 'codex-houston', Buffer.alloc(32, 1), '{}'),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run('unknown', 'tenant-a', 'codex-hythe', Buffer.alloc(32, 2), '["agent:self"]'),
      /FOREIGN KEY constraint failed/,
    );
    insert.run('credential-1', 'tenant-a', 'codex-houston', Buffer.alloc(32, 3), '["agent:self"]');
    db.prepare(
      `INSERT INTO agent_credential_attestations
       (credential_id, tenant_id, agent_id, auth_mode, attested_at)
       VALUES ('credential-1', 'tenant-a', 'codex-houston', 'mixed', '2026-08-14T00:05:00Z')`,
    ).run();
    assert.throws(
      () => db.prepare(
        `INSERT INTO agent_credential_attestations
         (credential_id, tenant_id, agent_id, auth_mode, attested_at)
         VALUES ('missing', 'tenant-a', 'codex-houston', 'mixed', '2026-08-14T00:05:00Z')`,
      ).run(),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => db.prepare(
        `UPDATE agent_principals SET agent_id = 'codex-hythe'
         WHERE tenant_id = 'tenant-a' AND agent_id = 'codex-houston'`,
      ).run(),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => db.prepare(
        `DELETE FROM agent_principals
         WHERE tenant_id = 'tenant-a' AND agent_id = 'codex-houston'`,
      ).run(),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    db.close();
  }
});
