/**
 * ENG-4 checkpoint runtime (sub-step 2(b), authorized by engram-sol
 * 8ac7457b on base 023a339) — branch-preserving CAS behind the frozen
 * contracts (engram-eng4-spec; contract layer approved @ 89fc422).
 *
 * FROZEN SEMANTICS (review e0d81d4d #1):
 * - expectedRevision identifies an EXISTING IMMUTABLE SAME-SCOPE PARENT;
 *   liveness is NOT required. Extending any existing parent — stale
 *   included — WRITES a branch child with a new unique-per-scope revision.
 * - expectedRevision=null asserts "first write in this scope";
 *   outcome=conflict is reserved for a missing/wrong-scope parent or null
 *   when the scope already has snapshots. Conflicts list ALL live heads.
 * - Idempotency (b2e6fc7c #4 + 5868b61b #3): same (tenant, scope, key) with
 *   the SAME requestFingerprint replays the original result; a DIFFERENT
 *   fingerprint fails closed as outcome=idempotency-mismatch. The
 *   fingerprint binds canonical author + CAS position + content; the
 *   resource contentHash binds the envelope bytes alone — never conflated.
 * - ONE TRANSACTION: idempotency check, CAS validation, revision
 *   allocation, payload insert, and snapshot insert all run inside a single
 *   better-sqlite3 transaction — there is no read-then-write window, and a
 *   mid-write failure leaves no partial scope/payload/snapshot/idempotency
 *   rows.
 * - ONE AUTHOR RULE (5868b61b #2): author = exact opaque agent principal;
 *   assertedAgentId is audit metadata only. recordedAt is server-owned.
 * - Payload integrity is verified against the persisted bytes on replay and
 *   on within-tenant dedup (sha256(body) must equal content_hash and
 *   byte_length must equal the true byte count) — a corrupted payload fails
 *   closed instead of replaying garbage.
 *
 * DEFERRED (explicitly, not silently): factChanges/loopChanges are bound
 * into the content envelope (hashed + persisted losslessly in the payload),
 * but their MATERIALIZATION into eng4_facts/eng4_open_loops ships with the
 * resume bundle in 2(c) — resume is the only reader of those tables.
 * Tenant identity comes from the server-side request context parameter,
 * NEVER from caller params. No tool is registered here (2(c)/(d) gates).
 *
 * CHANGE LEDGER (PR A, 2026-09-03): the ids each factChange/loopChange
 * materialized to are recorded in eng4_snapshot_changes inside the same
 * transaction and returned as result.changes (positional). Replay reads the
 * ledger; it never recomputes. The ledger is result-side only — the
 * canonical envelope, contentHash and requestFingerprint are unchanged.
 */
import { createHash, randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { CheckpointChanges, CheckpointParams, CheckpointResult, FactChange, LoopChange } from './contracts.js';
import { canonicalEnvelopeBytes, envelopeContentHash, requestFingerprint } from './canonical.js';
import { resolveScope, type EntityDirectory } from './resolver.js';

/** Unresolved/ambiguous scope fails CLOSED as a typed error — the four
 * CheckpointResult outcomes are reserved for resolved-scope semantics. */
export class CheckpointScopeError extends Error {
  readonly ambiguousCandidates: string[];
  constructor(message: string, ambiguousCandidates: string[] = []) {
    super(message);
    this.name = 'CheckpointScopeError';
    this.ambiguousCandidates = ambiguousCandidates;
  }
}

/** Persisted payload bytes that no longer match their hash fail CLOSED. */
export class CheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointIntegrityError';
  }
}

/**
 * Non-null expectedRevision against a scope with NO history fails CLOSED as
 * a typed error (sol review b5a96bb2): snapshots are immutable and never
 * deleted, so this can never be a CAS race — the caller is referencing the
 * wrong scope (or an invented revision). outcome=conflict is reserved for
 * scopes WITH history, where the frozen contract guarantees heads >= 1 so
 * the caller can always pick a real parent.
 */
export class CheckpointEmptyScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointEmptyScopeError';
  }
}

/**
 * A factChange/loopChange referencing an unknown id (same tenant + scope
 * only) or a close without an outcome fails CLOSED as a typed error — the
 * surrounding transaction rolls back, so a bad change never half-applies
 * (2(c) materialization, sol ruling 5866fa85).
 */
export class CheckpointChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointChangeError';
  }
}

interface SnapshotRow {
  state_id: string;
  scope_key: string;
  revision: number;
  parent_state_id: string | null;
  content_hash: string;
  request_fingerprint: string;
  author: string;
  recorded_at: string;
}

/**
 * 2(c) materialization (sol ruling 5866fa85: writer+reader in one slice).
 * Runs INSIDE the checkpoint transaction, AFTER the snapshot insert; the
 * envelope was hashed before any of this, so hashing/fingerprint semantics
 * are untouched. recordedAt/updatedAt are server-owned throughout;
 * effectiveAt is caller-supplied verbatim or absent — never invented.
 */
function applyFactChanges(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  author: string,
  recordedAt: string,
  changes: readonly FactChange[]
): CheckpointChanges['facts'] {
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES (?, ?, ?, ?)`
  );
  const out: CheckpointChanges['facts'] = [];
  for (const change of changes) {
    let factId = change.factId ?? null;
    const created = !factId;
    if (factId) {
      const existing = db.prepare(
        `SELECT fact_id FROM eng4_facts WHERE tenant_id = ? AND scope_key = ? AND fact_id = ?`
      ).get(tenantId, scopeKey, factId);
      if (!existing) {
        throw new CheckpointChangeError(`eng4: factChange references unknown factId ${factId} in this scope`);
      }
      db.prepare(
        `UPDATE eng4_facts SET subject = ?, predicate = ?, object = ?, status = ?,
                author = ?, recorded_at = ?, effective_at = ?
          WHERE tenant_id = ? AND fact_id = ?`
      ).run(
        change.assertion.subject, change.assertion.predicate, change.assertion.object,
        change.status, author, recordedAt, change.effectiveAt ?? null, tenantId, factId
      );
      db.prepare(`DELETE FROM eng4_fact_refs WHERE tenant_id = ? AND fact_id = ?`).run(tenantId, factId);
    } else {
      factId = randomUUID();
      db.prepare(
        `INSERT INTO eng4_facts
           (tenant_id, fact_id, scope_key, subject, predicate, object, status, author, recorded_at, effective_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        tenantId, factId, scopeKey, change.assertion.subject, change.assertion.predicate,
        change.assertion.object, change.status, author, recordedAt, change.effectiveAt ?? null
      );
    }
    for (const ref of change.evidenceRefs) insertRef.run(tenantId, factId, 'evidence', ref);
    for (const ref of change.sourceRefs) insertRef.run(tenantId, factId, 'source', ref);
    // Dangling contradicts refs are LEGAL AT WRITE (deferred-resolution
    // rule) — they surface at read time as unresolved contradictions.
    for (const ref of change.contradicts ?? []) insertRef.run(tenantId, factId, 'contradicts', ref);
    out.push({ factId, created });
  }
  return out;
}

function applyLoopChanges(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  author: string,
  recordedAt: string,
  changes: readonly LoopChange[]
): CheckpointChanges['loops'] {
  const out: CheckpointChanges['loops'] = [];
  for (const change of changes) {
    if (change.status === 'closed' && !change.closeOutcome) {
      throw new CheckpointChangeError('eng4: closing a loop requires closeOutcome');
    }
    const closeJson = change.status === 'closed'
      ? JSON.stringify({ closedAt: recordedAt, closedBy: author, outcome: change.closeOutcome })
      : null;
    if (change.loopId) {
      const existing = db.prepare(
        `SELECT owner FROM eng4_open_loops WHERE tenant_id = ? AND scope_key = ? AND loop_id = ?`
      ).get(tenantId, scopeKey, change.loopId) as { owner: string } | undefined;
      if (!existing) {
        throw new CheckpointChangeError(`eng4: loopChange references unknown loopId ${change.loopId} in this scope`);
      }
      db.prepare(
        `UPDATE eng4_open_loops SET status = ?, next_action = ?, owner = ?, due_at = ?,
                blocked_on = ?, close_json = ?, updated_at = ?, revision = revision + 1
          WHERE tenant_id = ? AND loop_id = ?`
      ).run(
        change.status, change.nextAction, change.owner ?? existing.owner,
        change.dueAt ?? null, change.blockedOn ?? null, closeJson, recordedAt,
        tenantId, change.loopId
      );
      out.push({ loopId: change.loopId, created: false });
    } else {
      const loopId = randomUUID();
      db.prepare(
        `INSERT INTO eng4_open_loops
           (tenant_id, loop_id, scope_key, owner, status, opened_at, updated_at,
            due_at, blocked_on, next_action, close_json, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).run(
        tenantId, loopId, scopeKey, change.owner ?? author, change.status,
        recordedAt, recordedAt, change.dueAt ?? null, change.blockedOn ?? null,
        change.nextAction, closeJson
      );
      out.push({ loopId, created: true });
    }
  }
  return out;
}

/** Persist the per-snapshot change ledger (same transaction as the snapshot). */
function recordSnapshotChanges(
  db: DatabaseType.Database,
  tenantId: string,
  stateId: string,
  changes: CheckpointChanges
): void {
  const insert = db.prepare(
    `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  changes.facts.forEach((f, i) => insert.run(tenantId, stateId, 'fact', i, f.factId, f.created ? 1 : 0));
  changes.loops.forEach((l, i) => insert.run(tenantId, stateId, 'loop', i, l.loopId, l.created ? 1 : 0));
}

/**
 * Read back a snapshot's ledger for idempotent-replay. A snapshot recorded
 * before the ledger existed has no rows: if its persisted envelope carried
 * fact/loop changes the ids are unknowable → null (never invented); if it
 * carried none, empty arrays are the truthful answer.
 */
function readSnapshotChanges(
  db: DatabaseType.Database,
  tenantId: string,
  stateId: string,
  contentHash: string
): CheckpointChanges | null {
  const rows = db.prepare(
    `SELECT kind, ordinal, change_id, created FROM eng4_snapshot_changes
      WHERE tenant_id = ? AND state_id = ? ORDER BY kind, ordinal`
  ).all(tenantId, stateId) as Array<{ kind: string; ordinal: number; change_id: string; created: number }>;
  const facts = rows.filter((r) => r.kind === 'fact').map((r) => ({ factId: String(r.change_id), created: r.created === 1 }));
  const loops = rows.filter((r) => r.kind === 'loop').map((r) => ({ loopId: String(r.change_id), created: r.created === 1 }));
  if (rows.length > 0) return { facts, loops };
  const payload = db.prepare(
    `SELECT body FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`
  ).get(tenantId, contentHash) as { body: Buffer } | undefined;
  if (!payload) return null;
  try {
    const envelope = JSON.parse(payload.body.toString('utf-8')) as { factChanges?: unknown[]; loopChanges?: unknown[] };
    const carried = (envelope.factChanges?.length ?? 0) + (envelope.loopChanges?.length ?? 0);
    return carried === 0 ? { facts: [], loops: [] } : null;
  } catch {
    return null;
  }
}

/** Heads = snapshots no other snapshot in the scope claims as parent. Shared with resume. */
export function liveHeads(db: DatabaseType.Database, tenantId: string, scopeKey: string) {
  return db.prepare(
    `SELECT s.state_id, s.revision, s.author, s.recorded_at
       FROM eng4_state_snapshots s
      WHERE s.tenant_id = ? AND s.scope_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM eng4_state_snapshots c
           WHERE c.tenant_id = s.tenant_id AND c.scope_key = s.scope_key
             AND c.parent_state_id = s.state_id)
      ORDER BY s.revision ASC`
  ).all(tenantId, scopeKey).map((r: any) => ({
    stateId: String(r.state_id),
    revision: Number(r.revision),
    author: String(r.author),
    recordedAt: String(r.recorded_at),
  }));
}

/** Fail-closed hash+size check of persisted payload bytes. Shared with the
 * engram:// resource layer — every resource fetch re-verifies (2(d)). */
export function verifyPayloadIntegrity(
  db: DatabaseType.Database,
  tenantId: string,
  contentHash: string
): void {
  const row = db.prepare(
    `SELECT body, byte_length FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`
  ).get(tenantId, contentHash) as { body: Buffer; byte_length: number } | undefined;
  if (!row) {
    throw new CheckpointIntegrityError(`eng4: payload missing for content hash ${contentHash}`);
  }
  const actualHash = createHash('sha256').update(row.body).digest('hex');
  if (actualHash !== contentHash || row.byte_length !== row.body.length) {
    throw new CheckpointIntegrityError(
      `eng4: persisted payload failed hash/size verification for ${contentHash}`
    );
  }
}

/**
 * Perform one checkpoint write. `tenantId` MUST come from the server-side
 * request context (never a caller parameter). The entire decision + write
 * path runs in ONE transaction on the provided connection.
 */
export function performCheckpoint(
  db: DatabaseType.Database,
  directory: EntityDirectory,
  tenantId: string,
  params: CheckpointParams
): CheckpointResult {
  const resolved = resolveScope(directory, tenantId, params.scope);
  if (!resolved.scopeKey) {
    throw new CheckpointScopeError(
      resolved.ambiguousCandidates?.length
        ? 'eng4: checkpoint scope is ambiguous'
        : 'eng4: checkpoint scope did not resolve',
      resolved.ambiguousCandidates ?? []
    );
  }
  const scopeKey = resolved.scopeKey;
  const canonicalAgentId = directory.resolveCanonicalAgent(params.agentId, tenantId).canonical;
  if (!canonicalAgentId) throw new Error('Invalid agent identity');

  const envelope = {
    scopeKey,
    state: params.state,
    events: params.events ?? [],
    factChanges: params.factChanges ?? [],
    loopChanges: params.loopChanges ?? [],
    evidenceRefs: params.evidenceRefs ?? [],
  };
  // Canonicalization (RFC 8785, fail-closed on malformed input) happens
  // before the transaction opens — a rejected envelope writes nothing.
  const payloadBytes = canonicalEnvelopeBytes(envelope);
  const contentHash = envelopeContentHash(envelope);

  const run = db.transaction((): CheckpointResult => {
    // Parent resolution is a same-scope revision lookup; a revision from
    // another scope is unreachable by construction (wrong-scope = missing).
    const parentRow = params.expectedRevision === null
      ? undefined
      : db.prepare(
          `SELECT state_id FROM eng4_state_snapshots
            WHERE tenant_id = ? AND scope_key = ? AND revision = ?`
        ).get(tenantId, scopeKey, params.expectedRevision) as { state_id: string } | undefined;
    const resolvedParentStateId = parentRow ? String(parentRow.state_id) : null;

    const fingerprint = requestFingerprint({
      canonicalAgentId,
      scopeKey,
      expectedRevision: params.expectedRevision,
      resolvedParentStateId,
      envelope,
    });

    // Idempotency FIRST (before CAS validation): a retry of the initial
    // write must replay even though the scope now has snapshots.
    const existing = db.prepare(
      `SELECT state_id, scope_key, revision, parent_state_id, content_hash,
              request_fingerprint, author, recorded_at
         FROM eng4_state_snapshots
        WHERE tenant_id = ? AND scope_key = ? AND idempotency_key = ?`
    ).get(tenantId, scopeKey, params.idempotencyKey) as SnapshotRow | undefined;

    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        return {
          outcome: 'idempotency-mismatch',
          stateId: String(existing.state_id),
          expectedRequestFingerprint: String(existing.request_fingerprint),
          receivedRequestFingerprint: fingerprint,
        };
      }
      verifyPayloadIntegrity(db, tenantId, String(existing.content_hash));
      return {
        outcome: 'idempotent-replay',
        stateId: String(existing.state_id),
        scopeKey: String(existing.scope_key),
        revision: Number(existing.revision),
        contentHash: String(existing.content_hash),
        changes: readSnapshotChanges(db, tenantId, String(existing.state_id), String(existing.content_hash)),
      };
    }

    // Branch-preserving CAS validation (frozen semantics).
    if (params.expectedRevision === null) {
      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM eng4_state_snapshots WHERE tenant_id = ? AND scope_key = ?`
      ).get(tenantId, scopeKey) as { n: number };
      if (count.n > 0) {
        return { outcome: 'conflict', heads: liveHeads(db, tenantId, scopeKey) };
      }
    } else if (!parentRow) {
      const heads = liveHeads(db, tenantId, scopeKey);
      if (heads.length === 0) {
        // Empty scope: there is no head to offer and no race to lose —
        // conflict (heads >= 1, frozen schema) cannot express this.
        throw new CheckpointEmptyScopeError(
          `eng4: expectedRevision ${params.expectedRevision} references a scope with no history — use expectedRevision=null for the first write in a scope`
        );
      }
      return { outcome: 'conflict', heads };
    }

    // Scope row, payload, revision allocation, snapshot — all in THIS
    // transaction; any failure below rolls all of it back.
    db.prepare(
      `INSERT OR IGNORE INTO eng4_scopes (tenant_id, scope_key, project_id, task_id)
       VALUES (?, ?, ?, ?)`
    ).run(tenantId, scopeKey, resolved.projectId, resolved.taskId);

    const payloadInsert = db.prepare(
      `INSERT OR IGNORE INTO eng4_payloads
         (tenant_id, content_hash, kind, media_type, encoding, byte_length, body)
       VALUES (?, ?, 'state-snapshot', 'application/json', 'utf-8', ?, ?)`
    ).run(tenantId, contentHash, payloadBytes.length, payloadBytes);
    if (payloadInsert.changes === 0) {
      // Within-tenant dedup hit: the persisted bytes must still verify.
      verifyPayloadIntegrity(db, tenantId, contentHash);
    }

    const maxRevision = db.prepare(
      `SELECT COALESCE(MAX(revision), 0) AS r FROM eng4_state_snapshots
        WHERE tenant_id = ? AND scope_key = ?`
    ).get(tenantId, scopeKey) as { r: number };
    const revision = maxRevision.r + 1;

    const stateId = randomUUID();
    const recordedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO eng4_state_snapshots
         (tenant_id, state_id, scope_key, revision, parent_state_id, content_hash,
          request_fingerprint, idempotency_key, author, asserted_agent_id,
          recorded_at, state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantId, stateId, scopeKey, revision, resolvedParentStateId, contentHash,
      fingerprint, params.idempotencyKey, canonicalAgentId, params.agentId,
      recordedAt, JSON.stringify(params.state)
    );

    // 2(c) materialization — same transaction, after the snapshot; a bad
    // change throws and rolls back the ENTIRE checkpoint.
    const changes: CheckpointChanges = {
      facts: applyFactChanges(db, tenantId, scopeKey, canonicalAgentId, recordedAt, params.factChanges ?? []),
      loops: applyLoopChanges(db, tenantId, scopeKey, canonicalAgentId, recordedAt, params.loopChanges ?? []),
    };
    recordSnapshotChanges(db, tenantId, stateId, changes);

    return {
      outcome: 'written',
      stateId,
      scopeKey,
      revision,
      parentStateId: resolvedParentStateId,
      contentHash,
      changes,
    };
  });

  return run();
}
