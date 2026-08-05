/**
 * ENG-4 engram:// resource layer (sub-step 2(d), authorized by engram-sol
 * b21bccde on base eabf1ce) — a typed READ module. History is a RESOURCE,
 * never a tool (review #5): nothing here is MCP-registered; registration
 * is a later, separately-gated slice.
 *
 * Invariants (executable-tested):
 * - URIs are product-stable and URL-encoded per segment — raw scope
 *   delimiters (':', '|') never appear in a URI path.
 * - Snapshot fetch selects by EXACTLY ONE of stateId | revision within a
 *   resolved scope; the fetched payload is hash+size VERIFIED on every
 *   fetch (fail closed on corruption — never serve unverifiable bytes).
 * - Every query is tenant-keyed: knowing another tenant's stateId,
 *   revision, or URI grants nothing (fail closed as not-found).
 * - changes-since is a cursor-backed, complete, revision-ordered view.
 */
import type DatabaseType from 'better-sqlite3';
import type { SnapshotSelector, StateSnapshot, ChangesSinceQuery } from './contracts.js';
import { verifyPayloadIntegrity } from './checkpoint.js';
import { parseScopeKey, resolveScope, type EntityDirectory } from './resolver.js';
import { ENGRAM_URI_PATTERN } from './schemas.js';

/** Absence/foreign-tenant/unresolved-scope fetches fail CLOSED as this. */
export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

export function buildSnapshotUri(scopeKey: string, stateId: string): string {
  return `engram://snapshot/${encodeURIComponent(scopeKey)}/${encodeURIComponent(stateId)}`;
}

/**
 * Message/handoff handles are SCOPE-BOUND (sol review 037cfc22): the URI
 * carries the originating resolved scopeKey, and dereference applies the
 * SAME tenant+scope selection predicate resume used — a same-tenant agent
 * knowing a raw row id cannot read another project's content.
 */
export function buildMessageUri(scopeKey: string, messageId: string): string {
  return `engram://message/${encodeURIComponent(scopeKey)}/${encodeURIComponent(messageId)}`;
}

export function buildHandoffUri(scopeKey: string, handoffId: string): string {
  return `engram://handoff/${encodeURIComponent(scopeKey)}/${encodeURIComponent(handoffId)}`;
}

const URI_RE = new RegExp(ENGRAM_URI_PATTERN);

/** Parse + validate an engram:// URI; segments are decoded. Fail closed. */
export function parseEngramUri(uri: string): { kind: string; segments: string[] } {
  if (!URI_RE.test(uri)) throw new ResourceNotFoundError(`eng4: malformed engram URI`);
  const [kind, ...encoded] = uri.slice('engram://'.length).split('/');
  return { kind, segments: encoded.map((s) => decodeURIComponent(s)) };
}

export interface FetchedSnapshot {
  snapshot: StateSnapshot;
  /** Full canonical envelope bytes, hash+size verified against contentHash. */
  body: Buffer;
  byteLength: number;
  mediaType: string;
}

interface SnapshotRow {
  state_id: string;
  scope_key: string;
  revision: number;
  parent_state_id: string | null;
  content_hash: string;
  author: string;
  asserted_agent_id: string;
  recorded_at: string;
  state_json: string;
}

function loadVerified(db: DatabaseType.Database, tenantId: string, row: SnapshotRow): FetchedSnapshot {
  verifyPayloadIntegrity(db, tenantId, row.content_hash);
  const payload = db.prepare(
    `SELECT body, byte_length, media_type FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`
  ).get(tenantId, row.content_hash) as { body: Buffer; byte_length: number; media_type: string };
  return {
    snapshot: {
      stateId: row.state_id,
      scopeKey: row.scope_key,
      revision: row.revision,
      parentStateId: row.parent_state_id,
      contentHash: row.content_hash,
      author: row.author,
      assertedAgentId: row.asserted_agent_id,
      recordedAt: row.recorded_at,
      state: JSON.parse(row.state_json),
    },
    body: Buffer.from(payload.body),
    byteLength: payload.byte_length,
    mediaType: payload.media_type,
  };
}

const SNAPSHOT_COLS = `state_id, scope_key, revision, parent_state_id, content_hash,
                       author, asserted_agent_id, recorded_at, state_json`;

/** Snapshot fetch by {scope, stateId} XOR {scope, revision} — tenant-keyed. */
export function fetchSnapshot(
  db: DatabaseType.Database,
  directory: EntityDirectory,
  tenantId: string,
  selector: SnapshotSelector
): FetchedSnapshot {
  const resolved = resolveScope(directory, tenantId, selector.scope);
  if (!resolved.scopeKey) throw new ResourceNotFoundError('eng4: snapshot scope did not resolve');
  const row = ('stateId' in selector && selector.stateId !== undefined
    ? db.prepare(
        `SELECT ${SNAPSHOT_COLS} FROM eng4_state_snapshots
          WHERE tenant_id = ? AND scope_key = ? AND state_id = ?`
      ).get(tenantId, resolved.scopeKey, selector.stateId)
    : db.prepare(
        `SELECT ${SNAPSHOT_COLS} FROM eng4_state_snapshots
          WHERE tenant_id = ? AND scope_key = ? AND revision = ?`
      ).get(tenantId, resolved.scopeKey, (selector as { revision: number }).revision)
  ) as SnapshotRow | undefined;
  if (!row) throw new ResourceNotFoundError('eng4: snapshot not found in this scope');
  return loadVerified(db, tenantId, row);
}

export type FetchedResource =
  | { kind: 'state-snapshot'; contentHash: string; byteLength: number; mediaType: string; body: Buffer }
  | { kind: 'message'; body: string };

/** Resolve a handle URI to verified content — the lossless-reachability path. */
export function fetchResourceByUri(
  db: DatabaseType.Database,
  tenantId: string,
  uri: string
): FetchedResource {
  const { kind, segments } = parseEngramUri(uri);
  if (kind === 'snapshot' && segments.length === 2) {
    const [scopeKey, stateId] = segments;
    const row = db.prepare(
      `SELECT ${SNAPSHOT_COLS} FROM eng4_state_snapshots
        WHERE tenant_id = ? AND scope_key = ? AND state_id = ?`
    ).get(tenantId, scopeKey, stateId) as SnapshotRow | undefined;
    if (!row) throw new ResourceNotFoundError('eng4: snapshot not found');
    const fetched = loadVerified(db, tenantId, row);
    return {
      kind: 'state-snapshot',
      contentHash: fetched.snapshot.contentHash,
      byteLength: fetched.byteLength,
      mediaType: fetched.mediaType,
      body: fetched.body,
    };
  }
  if (kind === 'message' && segments.length === 2) {
    const scope = parseScopeKey(segments[0]);
    if (!scope) throw new ResourceNotFoundError('eng4: malformed message handle scope');
    // Same predicate as resume's scoped selection — tenant AND scope bound.
    const row = db.prepare(
      `SELECT content FROM ai_messages
        WHERE tenant_id = ? AND id = ?
          AND ((project_id IS NOT NULL AND project_id = ?) OR (task_id IS NOT NULL AND task_id = ?))`
    ).get(tenantId, segments[1], scope.projectId, scope.taskId) as { content: string } | undefined;
    if (!row) throw new ResourceNotFoundError('eng4: message not found in this scope');
    return { kind: 'message', body: String(row.content ?? '') };
  }
  if (kind === 'handoff' && segments.length === 2) {
    const scope = parseScopeKey(segments[0]);
    // Handoffs are project-scoped rows: a task-only scope binds no project
    // and therefore dereferences nothing (fail closed).
    if (!scope?.projectId) throw new ResourceNotFoundError('eng4: malformed handoff handle scope');
    const row = db.prepare(
      `SELECT summary FROM session_handoffs WHERE tenant_id = ? AND id = ? AND project_id = ?`
    ).get(tenantId, segments[1], scope.projectId) as { summary: string } | undefined;
    if (!row) throw new ResourceNotFoundError('eng4: handoff not found in this scope');
    return { kind: 'message', body: String(row.summary ?? '') };
  }
  throw new ResourceNotFoundError('eng4: unsupported resource URI');
}

export interface ChangesSincePage {
  items: Array<{
    stateId: string;
    revision: number;
    parentStateId: string | null;
    author: string;
    recordedAt: string;
    contentHash: string;
  }>;
  nextCursor: string | null;
}

/** Cursor-backed, complete, revision-ordered changes view. */
export function changesSince(
  db: DatabaseType.Database,
  directory: EntityDirectory,
  tenantId: string,
  query: ChangesSinceQuery,
  pageSize = 100
): ChangesSincePage {
  const resolved = resolveScope(directory, tenantId, query.scope);
  if (!resolved.scopeKey) throw new ResourceNotFoundError('eng4: changes-since scope did not resolve');
  let afterRevision = query.sinceRevision;
  if (query.cursor) {
    const parsed = Number(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed)) throw new ResourceNotFoundError('eng4: malformed changes cursor');
    afterRevision = parsed;
  }
  const rows = db.prepare(
    `SELECT state_id, revision, parent_state_id, author, recorded_at, content_hash
       FROM eng4_state_snapshots
      WHERE tenant_id = ? AND scope_key = ? AND revision > ?
      ORDER BY revision ASC LIMIT ?`
  ).all(tenantId, resolved.scopeKey, afterRevision, pageSize + 1) as any[];
  const page = rows.slice(0, pageSize);
  return {
    items: page.map((r) => ({
      stateId: r.state_id,
      revision: r.revision,
      parentStateId: r.parent_state_id,
      author: r.author,
      recordedAt: r.recorded_at,
      contentHash: r.content_hash,
    })),
    nextCursor: rows.length > pageSize
      ? Buffer.from(String(page[page.length - 1].revision), 'utf8').toString('base64url')
      : null,
  };
}
