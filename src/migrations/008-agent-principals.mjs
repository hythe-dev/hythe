/**
 * Migration 008 — immutable exact agent principals and rotatable credentials.
 *
 * Additive schema only. Runtime applies this DDL idempotently on the exact DB
 * connection it already owns. This module intentionally has no standalone
 * executable path: credential issuance/promotion is an explicit offline
 * operator workflow, never an automatic migration side effect.
 */

export const DDL = [
  `PRAGMA foreign_keys = ON`,
  `CREATE TABLE IF NOT EXISTS agent_principals (
     tenant_id TEXT COLLATE BINARY NOT NULL,
     agent_id TEXT COLLATE BINARY NOT NULL,
     display_name TEXT,
     enforcement_state TEXT NOT NULL
       CHECK (enforcement_state IN ('staged', 'enforced', 'disabled')),
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     promoted_at TEXT,
     promoted_by TEXT,
     disabled_at TEXT,
     disabled_by TEXT,
     PRIMARY KEY (tenant_id, agent_id)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS agent_credentials (
     credential_id TEXT COLLATE BINARY PRIMARY KEY,
     tenant_id TEXT COLLATE BINARY NOT NULL,
     agent_id TEXT COLLATE BINARY NOT NULL,
     token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
     scopes_json TEXT NOT NULL
       CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
     status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
     not_before TEXT NOT NULL,
     expires_at TEXT,
     last_used_at TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     revoked_at TEXT,
     revoked_by TEXT,
     replaced_by TEXT COLLATE BINARY,
     FOREIGN KEY (tenant_id, agent_id)
       REFERENCES agent_principals(tenant_id, agent_id)
       ON UPDATE RESTRICT ON DELETE RESTRICT,
     FOREIGN KEY (replaced_by)
       REFERENCES agent_credentials(credential_id)
       ON UPDATE RESTRICT ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_credentials_principal
     ON agent_credentials (tenant_id, agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_credentials_expiry
     ON agent_credentials (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS agent_credential_attestations (
     credential_id TEXT COLLATE BINARY PRIMARY KEY,
     tenant_id TEXT COLLATE BINARY NOT NULL,
     agent_id TEXT COLLATE BINARY NOT NULL,
     auth_mode TEXT NOT NULL CHECK (auth_mode IN ('observe', 'mixed', 'required')),
     attested_at TEXT NOT NULL,
     FOREIGN KEY (credential_id)
       REFERENCES agent_credentials(credential_id)
       ON UPDATE RESTRICT ON DELETE CASCADE,
     FOREIGN KEY (tenant_id, agent_id)
       REFERENCES agent_principals(tenant_id, agent_id)
       ON UPDATE RESTRICT ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_attestations_principal
     ON agent_credential_attestations (tenant_id, agent_id, attested_at)`,
  `CREATE TABLE IF NOT EXISTS agent_labels (
     tenant_id TEXT COLLATE BINARY NOT NULL,
     agent_id TEXT COLLATE BINARY NOT NULL,
     label TEXT NOT NULL,
     label_kind TEXT NOT NULL CHECK (label_kind IN ('display', 'search', 'legacy')),
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, label, label_kind),
     FOREIGN KEY (tenant_id, agent_id)
       REFERENCES agent_principals(tenant_id, agent_id)
       ON UPDATE RESTRICT ON DELETE RESTRICT
   ) WITHOUT ROWID`,
];

const invokedDirectly = process.argv[1]
  && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
  process.stderr.write(
    'Migration 008 is additive runtime DDL and is not directly executable. '
    + 'Use the reviewed offline agent-credential operator workflow.\n',
  );
  process.exitCode = 2;
}
