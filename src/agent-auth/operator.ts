#!/usr/bin/env node

import Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCredentialStore } from './credential-store.js';
import type { AgentCredential, AgentPrincipal } from './types.js';

const TOOL_NAME = 'hythe-agent-auth-operator';
const AUDIT_SCHEMA_VERSION = 1;
const SECRET_FILE_MODE = 0o600;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const CREDENTIAL_ID_PATTERN = /^[a-f0-9]{24}$/;
const CANARY_ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Operation = 'issue' | 'promote' | 'rotate' | 'revoke' | 'status';

interface CommonOptions {
  operation: Operation;
  dbPath: string;
  tenantId: string;
  agentId: string;
  now?: string;
}

export interface IssueOptions extends CommonOptions {
  operation: 'issue';
  actor: string;
  scopes: string[];
  secretFile: string;
  createPrincipal?: boolean;
  notBefore?: string;
  expiresAt?: string | null;
}

export interface PromoteOptions extends CommonOptions {
  operation: 'promote';
  actor: string;
  credentialId: string;
}

export interface RotateOptions extends CommonOptions {
  operation: 'rotate';
  actor: string;
  credentialId: string;
  secretFile: string;
  scopes?: string[];
  notBefore?: string;
  expiresAt?: string | null;
}

export interface RevokeOptions extends CommonOptions {
  operation: 'revoke';
  actor: string;
  credentialId: string;
}

export interface StatusOptions extends CommonOptions {
  operation: 'status';
  credentialId?: string;
}

export type AgentAuthOperatorOptions =
  | IssueOptions
  | PromoteOptions
  | RotateOptions
  | RevokeOptions
  | StatusOptions;

export interface OperatorAudit {
  schemaVersion: number;
  tool: string;
  operation: Operation;
  outcome: 'applied' | 'unchanged' | 'inspected';
  database: string;
  occurredAt: string;
  tenantId: string;
  agentId: string;
  actor?: string;
  principal: Record<string, unknown> | null;
  credentials: Array<Record<string, unknown>>;
  schemaPresent?: boolean;
  secretDelivery?: {
    file: string;
    mode: '0600';
    format: 'raw-token';
  };
  rotation?: {
    replacedCredentialId: string;
    replacementCredentialId: string;
    overlapActive: true;
  };
}

export class AgentAuthOperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentAuthOperatorError';
  }
}

function operatorError(code: string, message: string): never {
  throw new AgentAuthOperatorError(code, message);
}

function safePrincipal(principal: AgentPrincipal): Record<string, unknown> {
  return {
    tenantId: principal.tenantId,
    agentId: principal.agentId,
    displayName: principal.displayName,
    enforcementState: principal.enforcementState,
    createdAt: principal.createdAt,
    createdBy: principal.createdBy,
    promotedAt: principal.promotedAt,
    promotedBy: principal.promotedBy,
    disabledAt: principal.disabledAt,
    disabledBy: principal.disabledBy,
  };
}

function safeCredential(credential: AgentCredential): Record<string, unknown> {
  return {
    credentialId: credential.credentialId,
    tenantId: credential.tenantId,
    agentId: credential.agentId,
    scopes: [...credential.scopes],
    status: credential.status,
    notBefore: credential.notBefore,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
    createdAt: credential.createdAt,
    createdBy: credential.createdBy,
    revokedAt: credential.revokedAt,
    revokedBy: credential.revokedBy,
    replacedBy: credential.replacedBy,
  };
}

function parseScopesJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function principalFromRow(row: any): AgentPrincipal {
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

function credentialFromRow(row: any): AgentCredential {
  return {
    credentialId: row.credential_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    scopes: parseScopesJson(row.scopes_json),
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

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE BINARY`,
  ).get(table));
}

function resolveDatabasePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path === ':memory:') {
    operatorError('DATABASE_PATH_REQUIRED', '--db must name an existing on-disk SQLite database');
  }
  const absolute = resolve(path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    operatorError('DATABASE_NOT_FOUND', 'database file does not exist');
  }
  if (!stats.isFile()) operatorError('DATABASE_NOT_REGULAR', 'database path must be a regular file');
  return realpathSync(absolute);
}

function validateExactId(value: string, label: string, maximum: number): void {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || !SAFE_ID_PATTERN.test(value)
  ) {
    operatorError(
      'INVALID_IDENTITY',
      `${label} must be 1-${maximum} exact characters from A-Z, a-z, 0-9, _, ., :, or -`,
    );
  }
}

function validateOptions(options: AgentAuthOperatorOptions): void {
  validateExactId(options.tenantId, 'tenantId', 128);
  validateExactId(options.agentId, 'agentId', 100);
  if ('actor' in options) validateExactId(options.actor, 'actor', 128);
  if (
    'credentialId' in options
    && options.credentialId != null
    && !CREDENTIAL_ID_PATTERN.test(options.credentialId)
  ) {
    operatorError('INVALID_CREDENTIAL_ID', 'credentialId must be exactly 24 lowercase hex characters');
  }
}

function prepareNewSecretPath(path: string, dbPath: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    operatorError('SECRET_FILE_REQUIRED', '--secret-file is required for credential issuance');
  }
  const absolute = resolve(path);
  if (absolute === dbPath) operatorError('SECRET_FILE_INVALID', 'secret file must differ from the database');
  let parent;
  try {
    parent = statSync(dirname(absolute));
  } catch {
    operatorError('SECRET_DIRECTORY_NOT_FOUND', 'secret-file parent directory does not exist');
  }
  if (!parent.isDirectory()) {
    operatorError('SECRET_DIRECTORY_INVALID', 'secret-file parent must be a directory');
  }
  if (existsSync(absolute)) {
    operatorError('SECRET_FILE_EXISTS', 'secret file already exists; refusing to overwrite it');
  }
  return absolute;
}

function writeSecretOnce(path: string, token: string): void {
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(path, 'wx', SECRET_FILE_MODE);
    created = true;
    writeFileSync(fd, `${token}\n`, { encoding: 'utf8' });
    fchmodSync(fd, SECRET_FILE_MODE);
    const stats = fstatSync(fd);
    if (!stats.isFile() || (stats.mode & 0o777) !== SECRET_FILE_MODE) {
      operatorError('SECRET_FILE_PERMISSIONS', 'secret file could not be secured to mode 0600');
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Continue with best-effort removal of the newly created secret path.
      }
    }
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // The caller still rolls back the database. Do not expose secret bytes
        // while reporting a best-effort filesystem cleanup failure.
      }
    }
    if (error instanceof AgentAuthOperatorError) throw error;
    operatorError('SECRET_FILE_WRITE_FAILED', 'secret file could not be created safely');
  }
}

function openExclusively(dbPath: string): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 0');
    db.pragma('foreign_keys = ON');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error: any) {
    try {
      db.close();
    } catch {
      // Preserve the fail-closed operator error below.
    }
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
      operatorError(
        'DATABASE_NOT_OFFLINE',
        'database is active or locked; stop every HYTHE reader/writer before retrying',
      );
    }
    throw error;
  }
  return db;
}

function requirePrincipal(
  store: AgentCredentialStore,
  tenantId: string,
  agentId: string,
): AgentPrincipal {
  const principal = store.getPrincipal(tenantId, agentId);
  if (!principal) {
    operatorError(
      'PRINCIPAL_NOT_FOUND',
      'exact tenant/agent principal not found; identity matching is case-sensitive',
    );
  }
  return principal;
}

function requireUsablePrincipal(
  store: AgentCredentialStore,
  tenantId: string,
  agentId: string,
): AgentPrincipal {
  const principal = requirePrincipal(store, tenantId, agentId);
  if (principal.enforcementState === 'disabled') {
    operatorError('PRINCIPAL_DISABLED', 'principal is disabled');
  }
  return principal;
}

function requireCredential(
  store: AgentCredentialStore,
  credentialId: string,
  tenantId: string,
  agentId: string,
): AgentCredential {
  const credential = store.getCredential(credentialId);
  if (!credential) operatorError('CREDENTIAL_NOT_FOUND', 'credential not found');
  if (credential.tenantId !== tenantId || credential.agentId !== agentId) {
    operatorError(
      'CREDENTIAL_PRINCIPAL_MISMATCH',
      'credential does not belong to the exact tenant/agent principal',
    );
  }
  return credential;
}

function hasCanaryProvenCredential(
  db: Database.Database,
  tenantId: string,
  agentId: string,
  credentialId: string,
  now: string,
): boolean {
  const nowMs = Date.parse(now);
  const rows = db.prepare(
    `SELECT c.not_before, c.expires_at, a.attested_at, a.auth_mode
     FROM agent_credentials c
     JOIN agent_credential_attestations a
       ON a.credential_id = c.credential_id
      AND a.tenant_id = c.tenant_id
      AND a.agent_id = c.agent_id
     WHERE c.tenant_id = ? AND c.agent_id = ?
       AND c.credential_id = ? AND c.status = 'active'`,
  ).all(tenantId, agentId, credentialId) as Array<{
    not_before: string;
    expires_at: string | null;
    attested_at: string;
    auth_mode: string;
  }>;
  return rows.some((row) => {
    const notBeforeMs = Date.parse(row.not_before);
    const attestedAtMs = Date.parse(row.attested_at);
    const expiresAtMs = row.expires_at == null ? null : Date.parse(row.expires_at);
    return Number.isFinite(notBeforeMs)
      && notBeforeMs <= nowMs
      && Number.isFinite(attestedAtMs)
      && attestedAtMs >= notBeforeMs
      && attestedAtMs <= nowMs
      && attestedAtMs >= nowMs - CANARY_ATTESTATION_MAX_AGE_MS
      && (row.auth_mode === 'mixed' || row.auth_mode === 'required')
      && (expiresAtMs == null || (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs));
  });
}

function baseAudit(
  options: AgentAuthOperatorOptions,
  database: string,
  occurredAt: string,
): Omit<OperatorAudit, 'outcome' | 'principal' | 'credentials'> {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    tool: TOOL_NAME,
    operation: options.operation,
    database,
    occurredAt,
    tenantId: options.tenantId,
    agentId: options.agentId,
    ...('actor' in options ? { actor: options.actor } : {}),
  };
}

function readStatus(
  db: Database.Database,
  options: StatusOptions,
  base: Omit<OperatorAudit, 'outcome' | 'principal' | 'credentials'>,
): OperatorAudit {
  const schemaPresent = tableExists(db, 'agent_principals')
    && tableExists(db, 'agent_credentials');
  if (!schemaPresent) {
    return {
      ...base,
      outcome: 'inspected',
      schemaPresent: false,
      principal: null,
      credentials: [],
    };
  }

  const principalRow = db.prepare(
    `SELECT * FROM agent_principals WHERE tenant_id = ? AND agent_id = ?`,
  ).get(options.tenantId, options.agentId) as any;
  if (!principalRow) {
    return {
      ...base,
      outcome: 'inspected',
      schemaPresent: true,
      principal: null,
      credentials: [],
    };
  }

  const rows = options.credentialId == null
    ? db.prepare(
      `SELECT credential_id, tenant_id, agent_id, scopes_json, status,
              not_before, expires_at, last_used_at, created_at, created_by,
              revoked_at, revoked_by, replaced_by
       FROM agent_credentials
       WHERE tenant_id = ? AND agent_id = ?
       ORDER BY created_at COLLATE BINARY, credential_id COLLATE BINARY`,
    ).all(options.tenantId, options.agentId) as any[]
    : db.prepare(
      `SELECT credential_id, tenant_id, agent_id, scopes_json, status,
              not_before, expires_at, last_used_at, created_at, created_by,
              revoked_at, revoked_by, replaced_by
       FROM agent_credentials WHERE credential_id = ?`,
    ).all(options.credentialId) as any[];
  if (
    options.credentialId != null
    && rows.length === 1
    && (rows[0].tenant_id !== options.tenantId || rows[0].agent_id !== options.agentId)
  ) {
    operatorError(
      'CREDENTIAL_PRINCIPAL_MISMATCH',
      'credential does not belong to the exact tenant/agent principal',
    );
  }

  return {
    ...base,
    outcome: 'inspected',
    schemaPresent: true,
    principal: safePrincipal(principalFromRow(principalRow)),
    credentials: rows.map((row) => safeCredential(credentialFromRow(row))),
  };
}

/**
 * Execute one offline operator action. The exclusive transaction acquired here
 * is held through every schema/state change and through create-only secret-file
 * delivery. The returned audit object never contains a token or token hash.
 */
export function runAgentAuthOperator(options: AgentAuthOperatorOptions): OperatorAudit {
  validateOptions(options);
  const database = resolveDatabasePath(options.dbPath);
  const occurredAt = new Date(options.now ?? new Date().toISOString()).toISOString();
  const secretFile = options.operation === 'issue' || options.operation === 'rotate'
    ? prepareNewSecretPath(options.secretFile, database)
    : null;
  const db = openExclusively(database);
  let createdSecretFile: string | null = null;

  try {
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') {
      operatorError('DATABASE_INTEGRITY_FAILED', `SQLite quick_check failed: ${String(quickCheck)}`);
    }
    const base = baseAudit(options, database, occurredAt);
    let audit: OperatorAudit;

    if (options.operation === 'status') {
      audit = readStatus(db, options, base);
    } else {
      const store = new AgentCredentialStore(db);

      if (options.operation === 'issue') {
        const existing = store.getPrincipal(options.tenantId, options.agentId);
        let principal: AgentPrincipal;
        if (options.createPrincipal === true) {
          if (existing) {
            operatorError(
              'PRINCIPAL_ALREADY_EXISTS',
              'exact principal already exists; omit --create-principal to issue another credential',
            );
          }
          principal = store.ensurePrincipal({
            tenantId: options.tenantId,
            agentId: options.agentId,
            createdBy: options.actor,
            now: occurredAt,
          });
        } else {
          principal = requireUsablePrincipal(store, options.tenantId, options.agentId);
        }
        if (principal.enforcementState === 'disabled') {
          operatorError('PRINCIPAL_DISABLED', 'principal is disabled');
        }
        const issued = store.issueCredential({
          tenantId: options.tenantId,
          agentId: options.agentId,
          scopes: options.scopes,
          createdBy: options.actor,
          notBefore: options.notBefore,
          expiresAt: options.expiresAt,
          now: occurredAt,
        });
        writeSecretOnce(secretFile!, issued.token);
        createdSecretFile = secretFile;
        audit = {
          ...base,
          outcome: 'applied',
          principal: safePrincipal(principal),
          credentials: [safeCredential(issued.credential)],
          secretDelivery: {
            file: secretFile!,
            mode: '0600',
            format: 'raw-token',
          },
        };
      } else if (options.operation === 'promote') {
        const principal = requirePrincipal(store, options.tenantId, options.agentId);
        if (principal.enforcementState === 'disabled') {
          operatorError('PRINCIPAL_DISABLED', 'disabled principals cannot be promoted');
        }
        const canaryCredential = requireCredential(
          store,
          options.credentialId,
          options.tenantId,
          options.agentId,
        );
        if (
          principal.enforcementState === 'staged'
          && !hasCanaryProvenCredential(
            db,
            options.tenantId,
            options.agentId,
            options.credentialId,
            occurredAt,
          )
        ) {
          operatorError(
            'PRINCIPAL_NOT_CANARY_PROVEN',
            'principal is not eligible for enforcement; complete the authenticated identity canary first',
          );
        }
        const promoted = principal.enforcementState === 'enforced'
          ? principal
          : store.setPrincipalState({
            tenantId: options.tenantId,
            agentId: options.agentId,
            state: 'enforced',
            actor: options.actor,
            now: occurredAt,
          });
        audit = {
          ...base,
          outcome: principal.enforcementState === 'enforced' ? 'unchanged' : 'applied',
          principal: safePrincipal(promoted),
          credentials: [safeCredential(canaryCredential)],
        };
      } else if (options.operation === 'rotate') {
        const principal = requireUsablePrincipal(store, options.tenantId, options.agentId);
        const old = requireCredential(
          store,
          options.credentialId,
          options.tenantId,
          options.agentId,
        );
        if (old.status !== 'active') {
          operatorError('CREDENTIAL_NOT_ACTIVE', 'only an active credential can be rotated');
        }
        if (old.replacedBy != null) {
          operatorError('CREDENTIAL_ALREADY_ROTATED', 'credential already names a replacement');
        }
        const rotated = store.rotateCredential({
          credentialId: options.credentialId,
          tenantId: options.tenantId,
          agentId: options.agentId,
          scopes: options.scopes == null || options.scopes.length === 0
            ? old.scopes
            : options.scopes,
          createdBy: options.actor,
          notBefore: options.notBefore,
          expiresAt: options.expiresAt,
          now: occurredAt,
        });
        writeSecretOnce(secretFile!, rotated.token);
        createdSecretFile = secretFile;
        audit = {
          ...base,
          outcome: 'applied',
          principal: safePrincipal(principal),
          credentials: [
            safeCredential(rotated.replaced),
            safeCredential(rotated.credential),
          ],
          secretDelivery: {
            file: secretFile!,
            mode: '0600',
            format: 'raw-token',
          },
          rotation: {
            replacedCredentialId: rotated.replaced.credentialId,
            replacementCredentialId: rotated.credential.credentialId,
            overlapActive: true,
          },
        };
      } else {
        const principal = requirePrincipal(store, options.tenantId, options.agentId);
        const credential = requireCredential(
          store,
          options.credentialId,
          options.tenantId,
          options.agentId,
        );
        if (credential.status !== 'active') {
          operatorError('CREDENTIAL_NOT_ACTIVE', 'credential is already revoked or stale');
        }
        const revoked = store.revokeCredential({
          credentialId: options.credentialId,
          actor: options.actor,
          now: occurredAt,
        });
        audit = {
          ...base,
          outcome: 'applied',
          principal: safePrincipal(principal),
          credentials: [safeCredential(revoked)],
        };
      }
    }

    db.exec('COMMIT');
    return audit;
  } catch (error) {
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original fail-closed error.
      }
    }
    if (createdSecretFile != null) {
      try {
        unlinkSync(createdSecretFile);
      } catch {
        // The credential transaction has rolled back. Avoid echoing secret data.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

const HELP = `HYTHE offline agent-credential operator

Usage:
  hythe-agent-auth issue  --db <file> --tenant-id <id> --agent-id <id> --actor <id>
                          --scope <scope> [--scope <scope> ...]
                          --secret-file <new-file> [--create-principal]
                          [--not-before <ISO>] [--expires-at <ISO>]
  hythe-agent-auth promote --db <file> --tenant-id <id> --agent-id <id> --actor <id>
                          --credential-id <attested-id>
  hythe-agent-auth rotate --db <file> --tenant-id <id> --agent-id <id> --actor <id>
                          --credential-id <id> --secret-file <new-file>
                          [--scope <scope> ...] [--not-before <ISO>] [--expires-at <ISO>]
  hythe-agent-auth revoke --db <file> --tenant-id <id> --agent-id <id> --actor <id>
                          --credential-id <id>
  hythe-agent-auth status --db <file> --tenant-id <id> --agent-id <id>
                          [--credential-id <id>]

The database must be offline. Secret files are create-only, raw-token files
secured to mode 0600. JSON stdout is an audit record and contains no secret.
`;

const VALUE_FLAGS = new Set([
  '--db',
  '--tenant-id',
  '--agent-id',
  '--actor',
  '--credential-id',
  '--scope',
  '--secret-file',
  '--not-before',
  '--expires-at',
]);
const BOOLEAN_FLAGS = new Set(['--create-principal']);

function parseCommandLine(argv: string[]): AgentAuthOperatorOptions | 'help' {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return 'help';
  const operation = argv[0] as Operation;
  if (!['issue', 'promote', 'rotate', 'revoke', 'status'].includes(operation)) {
    operatorError('INVALID_OPERATION', 'operation must be issue, promote, rotate, revoke, or status');
  }

  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (booleans.has(flag)) operatorError('DUPLICATE_ARGUMENT', `${flag} may be supplied only once`);
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) operatorError('UNKNOWN_ARGUMENT', `unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      operatorError('MISSING_ARGUMENT_VALUE', `${flag} requires a value`);
    }
    const prior = values.get(flag) ?? [];
    if (flag !== '--scope' && prior.length > 0) {
      operatorError('DUPLICATE_ARGUMENT', `${flag} may be supplied only once`);
    }
    prior.push(value);
    values.set(flag, prior);
    index += 1;
  }

  const required = (flag: string): string => {
    const value = values.get(flag)?.[0];
    if (value == null) operatorError('MISSING_ARGUMENT', `${flag} is required`);
    return value;
  };
  const common = {
    operation,
    dbPath: required('--db'),
    tenantId: required('--tenant-id'),
    agentId: required('--agent-id'),
  };

  const commonFlags = ['--db', '--tenant-id', '--agent-id'];
  const allowedValueFlags = new Set<string>([
    ...commonFlags,
    ...(operation === 'status'
      ? ['--credential-id']
      : operation === 'issue'
        ? ['--actor', '--scope', '--secret-file', '--not-before', '--expires-at']
        : operation === 'promote'
          ? ['--actor', '--credential-id']
          : operation === 'rotate'
            ? ['--actor', '--credential-id', '--scope', '--secret-file', '--not-before', '--expires-at']
            : ['--actor', '--credential-id']),
  ]);
  for (const suppliedFlag of values.keys()) {
    if (!allowedValueFlags.has(suppliedFlag)) {
      operatorError('INVALID_ARGUMENT', `${suppliedFlag} is not valid for ${operation}`);
    }
  }

  if (operation === 'status') {
    if (booleans.size > 0) operatorError('INVALID_ARGUMENT', '--create-principal is valid only for issue');
    return {
      ...common,
      operation,
      credentialId: values.get('--credential-id')?.[0],
    };
  }

  const actor = required('--actor');
  if (operation === 'issue') {
    const scopes = values.get('--scope') ?? [];
    if (scopes.length === 0) operatorError('MISSING_ARGUMENT', 'at least one --scope is required');
    return {
      ...common,
      operation,
      actor,
      scopes,
      secretFile: required('--secret-file'),
      createPrincipal: booleans.has('--create-principal'),
      notBefore: values.get('--not-before')?.[0],
      expiresAt: values.get('--expires-at')?.[0],
    };
  }
  if (booleans.size > 0) operatorError('INVALID_ARGUMENT', '--create-principal is valid only for issue');
  if (operation === 'promote') {
    return {
      ...common,
      operation,
      actor,
      credentialId: required('--credential-id'),
    };
  }
  if (operation === 'rotate') {
    return {
      ...common,
      operation,
      actor,
      credentialId: required('--credential-id'),
      secretFile: required('--secret-file'),
      scopes: values.get('--scope'),
      notBefore: values.get('--not-before')?.[0],
      expiresAt: values.get('--expires-at')?.[0],
    };
  }
  return {
    ...common,
    operation,
    actor,
    credentialId: required('--credential-id'),
  };
}

export interface OperatorCliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export function runAgentAuthOperatorCli(
  argv: string[],
  io: OperatorCliIo = process,
): number {
  let parsedOperation: string | null = argv[0] ?? null;
  try {
    const options = parseCommandLine(argv);
    if (options === 'help') {
      io.stdout.write(HELP);
      return 0;
    }
    parsedOperation = options.operation;
    const audit = runAgentAuthOperator(options);
    io.stdout.write(`${JSON.stringify(audit)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof AgentAuthOperatorError
      ? error
      : new AgentAuthOperatorError('OPERATOR_FAILED', 'offline credential operation failed');
    io.stderr.write(`${JSON.stringify({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      tool: TOOL_NAME,
      operation: parsedOperation,
      outcome: 'refused',
      code: safe.code,
      message: safe.message,
    })}\n`);
    return 2;
  }
}

function resolvesToCurrentModule(invocationPath: string): boolean {
  try {
    return realpathSync(resolve(invocationPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = process.argv[1]
  && resolvesToCurrentModule(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = runAgentAuthOperatorCli(process.argv.slice(2));
}
