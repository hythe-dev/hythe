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
 * CHANGE LEDGER (PR A, 2026-09-03; review 5e486718): the ids each
 * factChange/loopChange materialized to are ALWAYS recorded in
 * eng4_snapshot_changes inside the same transaction, digest-bound via
 * eng4_state_snapshots.changes_hash. They are RETURNED as result.changes
 * (positional) only when the request opts in with resultVersion=2 — the v1
 * result shape is frozen and stays the default. resultVersion=2 is bound
 * into requestFingerprint; absent/1 leaves legacy fingerprints byte-identical.
 * Replay verifies the ledger against the verified envelope and fails CLOSED
 * on any partial/tampered ledger; it never recomputes or returns a subset.
 * The canonical envelope and contentHash are unchanged.
 *
 * CURRENT-HEAD POINTER (ENG-4 H1, design 3429000 §3.2a/§3.4): inside the
 * same transaction, immediately after the snapshot insert, the scope's
 * pointer (eng4_scope_current) is set on the FIRST write in a scope and
 * ADVANCED when the new snapshot's parent IS the pointed head; a write from
 * any other parent keeps its branch but never moves the pointer. This is
 * unconditional on result version — a legacy v1 write on the pointed head
 * advances it too. The frozen CAS, fingerprints, envelope and every result
 * shape are unchanged; the pointer is what resume's ONE resolver (heads.ts)
 * reads to define "current" instead of max revision.
 */
import { createHash, randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type { CheckpointChanges, CheckpointOperation, CheckpointParams, CheckpointResult, FactChange, LoopChange, ReconciledBlock, ReconciliationRecord } from './contracts.js';
import { canonicalEnvelopeBytes, canonicalize, envelopeContentHash, requestFingerprint } from './canonical.js';
import { resolveScope, type EntityDirectory } from './resolver.js';
import { advancePointerAfterInsert, isRetired, liveHeads, readScopePointer, setPointerOnReconcile } from './heads.js';
import { writeVersionRows } from './versions.js';
import {
  CheckpointReconcileError,
  CheckpointRetiredParentError,
  evaluateDivergence,
  normalizeReconcileRequest,
  readReconciliation,
  verifyReconcileParity,
  writeReconcileRows,
} from './reconcile.js';

/** Re-exported for existing importers; the definition lives in heads.ts (H1). */
export { liveHeads } from './heads.js';

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
  changes_hash: string | null;
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
): { loops: CheckpointChanges['loops']; owners: string[] } {
  const out: CheckpointChanges['loops'] = [];
  // H2: the owner in effect for each change — exact at write time, and the
  // one loop field the payload alone does not pin down (an omitted `owner`
  // inherits the in-place value). Fed to the version dual write.
  const owners: string[] = [];
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
      owners.push(change.owner ?? existing.owner);
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
      owners.push(change.owner ?? author);
    }
  }
  return { loops: out, owners };
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
  db.prepare(`UPDATE eng4_state_snapshots SET changes_hash = ? WHERE tenant_id = ? AND state_id = ?`)
    .run(changesHash(changes), tenantId, stateId);
}

/** sha256 over the RFC 8785 canonical form of the changes object. */
export function changesHash(changes: CheckpointChanges): string {
  return createHash('sha256').update(Buffer.from(canonicalize(changes), 'utf8')).digest('hex');
}

/**
 * Read back a snapshot's ledger for idempotent-replay and VERIFY it against
 * the (already hash-verified) persisted envelope — fail CLOSED (review
 * 5e486718 blocker 2): a partial, duplicated, mis-ordered, or tampered
 * ledger throws CheckpointIntegrityError; it never returns a subset.
 * PRE-LEDGER ESCAPE IS VERSION-AWARE (re-review 882d39c7): a snapshot whose
 * requestFingerprint matched a resultVersion=2 request was necessarily
 * written by the ledger-aware writer (v2 is bound into the fingerprint), so
 * "no rows AND no digest" under v2 is erasure/corruption and THROWS — even
 * for a zero-change write. Only a matched v1 replay may treat that state as
 * a legitimate pre-ledger snapshot: null when the envelope carried fact/loop
 * changes, empty arrays when it did not (the v1 result omits it anyway).
 */
export function readSnapshotChanges(
  db: DatabaseType.Database,
  tenantId: string,
  stateId: string,
  contentHash: string,
  storedHash: string | null,
  requireLedger: boolean
): CheckpointChanges | null {
  const payload = db.prepare(
    `SELECT body FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`
  ).get(tenantId, contentHash) as { body: Buffer } | undefined;
  if (!payload) throw new CheckpointIntegrityError(`eng4: payload missing for content hash ${contentHash}`);
  let expectedFacts = 0;
  let expectedLoops = 0;
  try {
    const envelope = JSON.parse(payload.body.toString('utf-8')) as { factChanges?: unknown[]; loopChanges?: unknown[] };
    expectedFacts = envelope.factChanges?.length ?? 0;
    expectedLoops = envelope.loopChanges?.length ?? 0;
  } catch {
    throw new CheckpointIntegrityError(`eng4: persisted envelope for ${stateId} is not parseable`);
  }

  const rows = db.prepare(
    `SELECT kind, ordinal, change_id, created FROM eng4_snapshot_changes
      WHERE tenant_id = ? AND state_id = ? ORDER BY kind, ordinal`
  ).all(tenantId, stateId) as Array<{ kind: string; ordinal: number; change_id: string; created: number }>;

  const fail = (why: string): never => {
    throw new CheckpointIntegrityError(`eng4: snapshot change ledger failed verification for ${stateId}: ${why}`);
  };

  if (rows.length === 0 && storedHash === null) {
    if (requireLedger) fail('ledger and digest absent for a snapshot written by the ledger-aware (resultVersion=2) writer');
    // Matched v1 replay: possibly a genuine pre-ledger snapshot — truthful answer only.
    return expectedFacts + expectedLoops === 0 ? { facts: [], loops: [] } : null;
  }
  const factRows = rows.filter((r) => r.kind === 'fact');
  const loopRows = rows.filter((r) => r.kind === 'loop');
  if (factRows.length !== expectedFacts) fail(`expected ${expectedFacts} fact rows, found ${factRows.length}`);
  if (loopRows.length !== expectedLoops) fail(`expected ${expectedLoops} loop rows, found ${loopRows.length}`);
  const contiguous = (list: Array<{ ordinal: number }>) => list.every((r, i) => r.ordinal === i);
  if (!contiguous(factRows)) fail('fact ordinals are not contiguous from 0');
  if (!contiguous(loopRows)) fail('loop ordinals are not contiguous from 0');
  for (const r of rows) {
    if (typeof r.change_id !== 'string' || r.change_id.length === 0) fail('empty change_id');
    if (r.created !== 0 && r.created !== 1) fail('created flag out of range');
  }
  const changes: CheckpointChanges = {
    facts: factRows.map((r) => ({ factId: String(r.change_id), created: r.created === 1 })),
    loops: loopRows.map((r) => ({ loopId: String(r.change_id), created: r.created === 1 })),
  };
  if (storedHash === null) fail('ledger rows present but no stored digest');
  if (changesHash(changes) !== storedHash) fail('ledger digest mismatch');
  return changes;
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

  const baseEnvelope = {
    scopeKey,
    state: params.state,
    events: params.events ?? [],
    factChanges: params.factChanges ?? [],
    loopChanges: params.loopChanges ?? [],
    evidenceRefs: params.evidenceRefs ?? [],
  };
  const resultVersion: 1 | 2 | 3 = params.resultVersion === 3 ? 3 : params.resultVersion === 2 ? 2 : 1;
  const operation: CheckpointOperation = resultVersion === 3 && params.operation === 'reconcile' ? 'reconcile' : 'write';
  // Canonicalization (RFC 8785, fail-closed on malformed input) happens
  // before the transaction opens — a rejected envelope writes nothing. A
  // reconcile's envelope additionally carries the reconciliation record,
  // which is derived INSIDE the transaction (§4.2 step 4), so its final bytes
  // and contentHash are computed there; the base envelope is validated here.
  canonicalEnvelopeBytes(baseEnvelope);
  const normalized = operation === 'reconcile' ? normalizeReconcileRequest(params) : undefined;

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
      envelope: baseEnvelope,
      resultVersion,
      operation,
      reconcile: normalized,
    });
    const pointerNow = (): string | null => readScopePointer(db, tenantId, scopeKey)?.stateId ?? null;
    // v3 conflicts also carry the pointer, so a reconcile caller can restate
    // both CAS values; v1/v2 conflict shapes are frozen.
    const conflict = (heads: ReturnType<typeof liveHeads>): CheckpointResult => ({
      outcome: 'conflict',
      heads,
      ...(resultVersion === 3 ? { pointer: pointerNow() } : {}),
    });

    // Idempotency FIRST (before CAS validation): a retry of the initial
    // write must replay even though the scope now has snapshots — and a
    // retry of a successful reconcile must replay even though it changed the
    // live-head set (§4.2 step 1).
    const existing = db.prepare(
      `SELECT state_id, scope_key, revision, parent_state_id, content_hash,
              request_fingerprint, author, recorded_at, changes_hash
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
      // Ledger verification is unconditional (fail closed) — the shape opt-in
      // only decides whether the verified answer is RETURNED.
      const replayChanges = readSnapshotChanges(
        db, tenantId, String(existing.state_id), String(existing.content_hash),
        existing.changes_hash === null || existing.changes_hash === undefined ? null : String(existing.changes_hash),
        resultVersion >= 2
      );
      let reconciled: ReconciledBlock | undefined;
      if (operation === 'reconcile') {
        // §4.3 replay integrity: the payload record is the authority; the
        // merge-input / retirement / resolution rows must match it exactly.
        const record = readReconciliation(db, tenantId, String(existing.content_hash));
        if (!record) throw new CheckpointIntegrityError(`eng4: matched reconcile replay for ${existing.state_id} but its payload carries no reconciliation record`);
        verifyReconcileParity(db, tenantId, scopeKey, String(existing.state_id), record);
        reconciled = {
          survivor: record.survivor, retired: record.retired, pointer: String(existing.state_id),
          resolutions: record.resolutions, unresolvedDivergent: record.unresolvedDivergent,
        };
      }
      return {
        outcome: 'idempotent-replay',
        stateId: String(existing.state_id),
        scopeKey: String(existing.scope_key),
        revision: Number(existing.revision),
        contentHash: String(existing.content_hash),
        // A matched v2/v3 replay can never be pre-ledger (fingerprint-bound),
        // so replayChanges is non-null here; the throw above guarantees it.
        ...(resultVersion >= 2 ? { changes: replayChanges as CheckpointChanges } : {}),
        ...(reconciled ? { reconciled } : {}),
      };
    }

    // Branch-preserving CAS validation (frozen semantics for `write`).
    if (params.expectedRevision === null) {
      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM eng4_state_snapshots WHERE tenant_id = ? AND scope_key = ?`
      ).get(tenantId, scopeKey) as { n: number };
      if (count.n > 0) {
        return conflict(liveHeads(db, tenantId, scopeKey));
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
      return conflict(heads);
    }

    // H3: reconcile CAS + causal divergence evaluation (§4.2 steps 2, 3, 6),
    // or the v3 resurrection acknowledgement for a plain write (§4.5).
    let reconciliation: ReconciliationRecord | undefined;
    if (operation === 'reconcile' && normalized) {
      const live = liveHeads(db, tenantId, scopeKey);
      if (live.length === 0) {
        throw new CheckpointEmptyScopeError('eng4: reconcile on a scope with no history');
      }
      const liveIds = live.map((h) => h.stateId).sort();
      if (canonicalize(liveIds) !== canonicalize(normalized.expectedHeads)) return conflict(live);
      if (pointerNow() !== normalized.expectedPointer) return conflict(live);
      if (resolvedParentStateId !== normalized.survivor) {
        throw new CheckpointReconcileError('eng4: expectedRevision must be the survivor\'s revision');
      }
      const outcome = evaluateDivergence(
        db, tenantId, scopeKey, normalized,
        { factChanges: params.factChanges ?? [], loopChanges: params.loopChanges ?? [] },
        canonicalAgentId
      );
      reconciliation = {
        expectedHeads: normalized.expectedHeads,
        survivor: normalized.survivor,
        retired: outcome.retired,
        expectedPointer: normalized.expectedPointer,
        reason: normalized.reason,
        strict: normalized.strict,
        resolutions: outcome.resolutions,
        unresolvedDivergent: outcome.unresolvedDivergent,
      };
    } else if (
      resultVersion === 3 && resolvedParentStateId !== null &&
      isRetired(db, tenantId, scopeKey, resolvedParentStateId) && params.acknowledgeRetired !== true
    ) {
      throw new CheckpointRetiredParentError(
        `eng4: parent ${resolvedParentStateId} is a retired head — a resultVersion 3 write must set acknowledgeRetired: true to extend it (the pointer will not move)`
      );
    }

    // The hashed envelope: base for a write; base + reconciliation record for
    // a reconcile (bound by contentHash; the resource is self-contained).
    const envelope = reconciliation ? { ...baseEnvelope, reconciliation } : baseEnvelope;
    const payloadBytes = canonicalEnvelopeBytes(envelope);
    const contentHash = envelopeContentHash(envelope);

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

    if (reconciliation) {
      // §4.2 step 7: a reconcile sets the pointer to itself, explicitly.
      setPointerOnReconcile(db, tenantId, scopeKey, stateId, canonicalAgentId, recordedAt);
    } else {
      // H1 advance rule (§3.2a/§3.4) — same transaction, right after the
      // insert: first write sets the pointer; parent == live pointer advances
      // it; anything else is a branch and leaves it alone.
      advancePointerAfterInsert(db, tenantId, scopeKey, {
        stateId,
        parentStateId: resolvedParentStateId,
        advancedBy: canonicalAgentId,
        advancedAt: recordedAt,
      });
    }

    // 2(c) materialization — same transaction, after the snapshot; a bad
    // change throws and rolls back the ENTIRE checkpoint.
    const appliedFacts = applyFactChanges(db, tenantId, scopeKey, canonicalAgentId, recordedAt, params.factChanges ?? []);
    const appliedLoops = applyLoopChanges(db, tenantId, scopeKey, canonicalAgentId, recordedAt, params.loopChanges ?? []);
    const changes: CheckpointChanges = { facts: appliedFacts, loops: appliedLoops.loops };
    recordSnapshotChanges(db, tenantId, stateId, changes);
    // H2 dual write (§6.2): exact `materialized` coverage + version rows for
    // every change, after the ledger they FK. The in-place rows above remain
    // the frozen v1/v2 view; these are the v3 view (read in H4).
    writeVersionRows(db, tenantId, scopeKey, stateId, canonicalAgentId, recordedAt,
      { factChanges: params.factChanges ?? [], loopChanges: params.loopChanges ?? [] }, changes, appliedLoops.owners);

    let reconciled: ReconciledBlock | undefined;
    if (reconciliation) {
      // §4.2 steps 5–6 rows, after the ledger (accepts FK their own ledger row).
      writeReconcileRows(db, tenantId, scopeKey, stateId, reconciliation, canonicalAgentId, recordedAt);
      reconciled = {
        survivor: reconciliation.survivor, retired: reconciliation.retired, pointer: stateId,
        resolutions: reconciliation.resolutions, unresolvedDivergent: reconciliation.unresolvedDivergent,
      };
    }

    return {
      outcome: 'written',
      stateId,
      scopeKey,
      revision,
      parentStateId: resolvedParentStateId,
      contentHash,
      ...(resultVersion >= 2 ? { changes } : {}),
      ...(reconciled ? { reconciled } : {}),
    };
  });

  return run();
}
