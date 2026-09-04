/**
 * ENG-4 H2 — the version foundation (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §6.2 and §7 row H2, merged 3429000;
 * internal increment of resultVersion 3). DATA ONLY: nothing here changes a
 * public read model — H4 reads these rows through resume; H2 writes them,
 * backfills them, and verifies them.
 *
 * THE DEFECT THIS PREPARES TO CLOSE (§6.1): facts and loops are scope-global
 * rows updated in place, last-writer-wins. A write from an abandoned branch
 * destroys the accepted value immediately and nothing records which snapshot
 * wrote what. Versions keyed by (writing snapshot, change ordinal) keep every
 * value; the coverage manifest gives every digest-bound ledger tuple exactly
 * one explicit disposition, so a deliberately unversioned historical tuple is
 * distinguishable from a deleted or missing version row.
 *
 * INVARIANTS (executable-tested in tests/contract-eng4-h2-version-foundation.test.ts):
 * - The durable cutover marker is the immutable eng4_state_snapshots.changes_hash:
 *   NOT NULL ⇒ one coverage row per ledger tuple, exact; NULL ⇒ zero ledger,
 *   coverage and version rows (a row under a null digest is corruption).
 * - Every post-H2 write emits `materialized` coverage plus an exact version
 *   for every change, in the checkpoint transaction (source 'write').
 * - The backfill (run once per uncovered ledger-bound snapshot, at schema
 *   apply, all-or-nothing) reconstructs versions ONLY from immutable data:
 *   the hash-verified payload, the digest-verified ledger and the snapshot
 *   row. Fact changes and loop creations are always reconstructible. A loop
 *   UPDATE that omitted `owner` inherited the in-place owner at write time;
 *   that value is provable only when the loop's immediately preceding ledger
 *   tuple has a materialized version and no null-digest (unknowable) snapshot
 *   lies between them. Otherwise the tuple is `unversioned` with reason
 *   'pre-h2-inherited-owner' — never a guess.
 * - The verifier (verifyVersionParity) recomputes the expected coverage and
 *   version set for every snapshot in a scope from those immutable sources
 *   and compares BIDIRECTIONALLY by cardinality, keys, disposition,
 *   deterministic reason and values. Missing, extra or mismatched rows are
 *   CheckpointIntegrityError. The ledger and the payload must agree on every
 *   tuple's id and created flag (a version can never attach to a fact/loop
 *   the payload did not name). For a writer-recorded (source 'write')
 *   materialized version whose owner was omitted and whose predecessor chain
 *   is unprovable, the recorded owner is accepted as the writer's exact
 *   knowledge; every other value must match the recomputation.
 * - Cutover evidence is immutable, not inferred: eng4_version_backfills marks
 *   every backfilled snapshot (the verifier derives the expected coverage
 *   `source` from it, so a relabelled row is detected) and
 *   eng4_version_cutover records per scope the revision through which
 *   coverage is known complete (an uncovered ledger-bound snapshot at or
 *   below it is erased coverage and refuses the apply; above it, a snapshot
 *   written by a pre-H2 binary after a rollback is legitimately backfilled).
 *
 * RESIDUAL (stated, not hidden): for a genuine post-cutover write whose
 * omitted owner has an unprovable chain, the payload cannot contradict a
 * later out-of-band change to that ONE field; every other field, and every
 * backfilled tuple, is fully recomputable.
 */
import type DatabaseType from 'better-sqlite3';
import type { CheckpointChanges, FactChange, LoopChange } from './contracts.js';
import { canonicalize } from './canonical.js';
import { CheckpointIntegrityError, readSnapshotChanges, verifyPayloadIntegrity } from './checkpoint.js';

export const UNVERSIONED_REASON_INHERITED_OWNER = 'pre-h2-inherited-owner';

interface Envelope {
  factChanges: FactChange[];
  loopChanges: LoopChange[];
}

interface SnapshotMeta {
  state_id: string;
  scope_key: string;
  revision: number;
  content_hash: string;
  changes_hash: string | null;
  author: string;
  recorded_at: string;
}

export interface FactVersionValue {
  subject: string;
  predicate: string;
  object: string;
  status: string;
  effectiveAt: string | null;
  refsJson: string;
}

export interface LoopVersionValue {
  owner: string;
  status: string;
  nextAction: string;
  dueAt: string | null;
  blockedOn: string | null;
  closeJson: string | null;
}

/** The exact post-change fact value a change asserts (fully determined by the payload). */
export function factVersionValue(change: FactChange): FactVersionValue {
  return {
    subject: change.assertion.subject,
    predicate: change.assertion.predicate,
    object: change.assertion.object,
    status: change.status,
    effectiveAt: change.effectiveAt ?? null,
    refsJson: canonicalize({
      evidenceRefs: change.evidenceRefs ?? [],
      sourceRefs: change.sourceRefs ?? [],
      contradicts: change.contradicts ?? [],
    }),
  };
}

/** The exact post-change loop value, given the owner in effect (mirrors applyLoopChanges). */
export function loopVersionValue(change: LoopChange, owner: string, author: string, recordedAt: string): LoopVersionValue {
  return {
    owner,
    status: change.status,
    nextAction: change.nextAction,
    dueAt: change.dueAt ?? null,
    blockedOn: change.blockedOn ?? null,
    closeJson: change.status === 'closed'
      ? JSON.stringify({ closedAt: recordedAt, closedBy: author, outcome: change.closeOutcome })
      : null,
  };
}

/**
 * The two immutable sources must agree on WHICH row each tuple is about: an
 * update names its id in the payload and must match the ledger's change_id
 * with created=false; a creation has no id in the payload and must be
 * created=true (independent review of PR #12, finding 1).
 */
export function assertLedgerAgreesWithEnvelope(stateId: string, changes: CheckpointChanges, env: Envelope): void {
  const fail = (why: string): never => {
    throw new CheckpointIntegrityError(`eng4: ledger/payload disagreement for ${stateId}: ${why}`);
  };
  if (env.factChanges.length !== changes.facts.length || env.loopChanges.length !== changes.loops.length) {
    fail('cardinality mismatch');
  }
  changes.facts.forEach((f, i) => {
    const named = env.factChanges[i].factId;
    if (named !== undefined ? (named !== f.factId || f.created) : !f.created) fail(`fact[${i}] id/created mismatch`);
  });
  changes.loops.forEach((l, i) => {
    const named = env.loopChanges[i].loopId;
    if (named !== undefined ? (named !== l.loopId || l.created) : !l.created) fail(`loop[${i}] id/created mismatch`);
  });
}

function readEnvelope(db: DatabaseType.Database, tenantId: string, contentHash: string, stateId: string): Envelope {
  const payload = db.prepare(`SELECT body FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`)
    .get(tenantId, contentHash) as { body: Buffer } | undefined;
  if (!payload) throw new CheckpointIntegrityError(`eng4: payload missing for content hash ${contentHash}`);
  try {
    const env = JSON.parse(payload.body.toString('utf-8')) as Partial<Envelope>;
    return { factChanges: env.factChanges ?? [], loopChanges: env.loopChanges ?? [] };
  } catch {
    throw new CheckpointIntegrityError(`eng4: persisted envelope for ${stateId} is not parseable`);
  }
}

// ---------------------------------------------------------------------------
// Row writers (shared by the checkpoint dual write and the backfill)
// ---------------------------------------------------------------------------

function insertCoverage(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  stateId: string,
  kind: 'fact' | 'loop',
  ordinal: number,
  changeId: string,
  disposition: 'materialized' | 'unversioned',
  reason: string | null,
  source: 'write' | 'backfill'
): void {
  db.prepare(
    `INSERT INTO eng4_version_coverage
       (tenant_id, scope_key, state_id, kind, ordinal, change_id, disposition, reason, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tenantId, scopeKey, stateId, kind, ordinal, changeId, disposition, reason, source);
}

function insertFactVersion(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  factId: string,
  stateId: string,
  ordinal: number,
  v: FactVersionValue,
  author: string,
  recordedAt: string
): void {
  db.prepare(
    `INSERT INTO eng4_fact_versions
       (tenant_id, scope_key, fact_id, state_id, ordinal, subject, predicate, object, status,
        effective_at, refs_json, author, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tenantId, scopeKey, factId, stateId, ordinal, v.subject, v.predicate, v.object, v.status,
    v.effectiveAt, v.refsJson, author, recordedAt);
}

function insertLoopVersion(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  loopId: string,
  stateId: string,
  ordinal: number,
  v: LoopVersionValue,
  author: string,
  recordedAt: string
): void {
  db.prepare(
    `INSERT INTO eng4_loop_versions
       (tenant_id, scope_key, loop_id, state_id, ordinal, owner, status, next_action, due_at,
        blocked_on, close_json, author, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tenantId, scopeKey, loopId, stateId, ordinal, v.owner, v.status, v.nextAction, v.dueAt,
    v.blockedOn, v.closeJson, author, recordedAt);
}

/**
 * Dual write — runs INSIDE the checkpoint transaction after the ledger and
 * digest are written (coverage rows FK the ledger). The writer KNOWS every
 * materialized result (loopOwners[i] is the owner applyLoopChanges resolved
 * for loopChanges[i]), so every tuple is `materialized` with an exact version.
 */
export function writeVersionRows(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  stateId: string,
  author: string,
  recordedAt: string,
  envelope: Envelope,
  changes: CheckpointChanges,
  loopOwners: readonly string[]
): void {
  changes.facts.forEach((f, i) => {
    insertCoverage(db, tenantId, scopeKey, stateId, 'fact', i, f.factId, 'materialized', null, 'write');
    insertFactVersion(db, tenantId, scopeKey, f.factId, stateId, i, factVersionValue(envelope.factChanges[i]), author, recordedAt);
  });
  changes.loops.forEach((l, i) => {
    insertCoverage(db, tenantId, scopeKey, stateId, 'loop', i, l.loopId, 'materialized', null, 'write');
    insertLoopVersion(db, tenantId, scopeKey, l.loopId, stateId, i,
      loopVersionValue(envelope.loopChanges[i], loopOwners[i], author, recordedAt), author, recordedAt);
  });
}

// ---------------------------------------------------------------------------
// Inherited-owner provenance (the one thing a payload does not pin down)
// ---------------------------------------------------------------------------

interface PredecessorInfo {
  /** The loop's latest prior ledger tuple in (revision, ordinal) order, any lineage. */
  found: boolean;
  /** Its materialized version's owner, or null if that tuple is unversioned. */
  owner: string | null;
  /** True when a null-digest (unknowable) snapshot lies strictly between the predecessor and `revision`. */
  gap: boolean;
}

function predecessorOwner(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  loopId: string,
  revision: number,
  ordinal: number
): PredecessorInfo {
  const pred = db.prepare(
    `SELECT c.state_id, c.ordinal, s.revision
       FROM eng4_snapshot_changes c
       JOIN eng4_state_snapshots s ON s.tenant_id = c.tenant_id AND s.state_id = c.state_id
      WHERE c.tenant_id = ? AND s.scope_key = ? AND c.kind = 'loop' AND c.change_id = ?
        AND (s.revision < ? OR (s.revision = ? AND c.ordinal < ?))
      ORDER BY s.revision DESC, c.ordinal DESC LIMIT 1`
  ).get(tenantId, scopeKey, loopId, revision, revision, ordinal) as { state_id: string; ordinal: number; revision: number } | undefined;
  if (!pred) return { found: false, owner: null, gap: false };
  const version = db.prepare(
    `SELECT owner FROM eng4_loop_versions
      WHERE tenant_id = ? AND scope_key = ? AND loop_id = ? AND state_id = ? AND ordinal = ?`
  ).get(tenantId, scopeKey, loopId, pred.state_id, pred.ordinal) as { owner: string } | undefined;
  const gapRow = db.prepare(
    `SELECT COUNT(*) AS n FROM eng4_state_snapshots
      WHERE tenant_id = ? AND scope_key = ? AND revision > ? AND revision < ? AND changes_hash IS NULL`
  ).get(tenantId, scopeKey, pred.revision, revision) as { n: number };
  return { found: true, owner: version ? String(version.owner) : null, gap: gapRow.n > 0 };
}

type LoopExpectation =
  | { disposition: 'materialized'; owner: string }
  | { disposition: 'materialized'; owner: null /* accepted as recorded (source write, unprovable chain) */ }
  | { disposition: 'unversioned'; reason: typeof UNVERSIONED_REASON_INHERITED_OWNER };

/**
 * Deterministic expectation for one loop tuple from immutable data only.
 * `source` matters solely for the unprovable omitted-owner case: a writer
 * knew the exact value ('write' → materialized, owner accepted as recorded);
 * a backfill must not guess ('backfill' → unversioned).
 */
function expectLoop(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  snap: SnapshotMeta,
  ordinal: number,
  change: LoopChange,
  created: boolean,
  loopId: string,
  source: 'write' | 'backfill'
): LoopExpectation {
  if (created) return { disposition: 'materialized', owner: change.owner ?? snap.author };
  if (change.owner) return { disposition: 'materialized', owner: change.owner };
  const pred = predecessorOwner(db, tenantId, scopeKey, loopId, snap.revision, ordinal);
  if (pred.found && pred.owner !== null && !pred.gap) return { disposition: 'materialized', owner: pred.owner };
  if (source === 'write') return { disposition: 'materialized', owner: null };
  return { disposition: 'unversioned', reason: UNVERSIONED_REASON_INHERITED_OWNER };
}

// ---------------------------------------------------------------------------
// Backfill (schema-apply time; all-or-nothing inside the caller's transaction)
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  scopesScanned: number;
  snapshotsScanned: number;
  snapshotsBackfilled: number;
  materialized: number;
  unversioned: number;
}

const snapshotsOfScope = (db: DatabaseType.Database, tenantId: string, scopeKey: string): SnapshotMeta[] =>
  db.prepare(
    `SELECT state_id, scope_key, revision, content_hash, changes_hash, author, recorded_at
       FROM eng4_state_snapshots WHERE tenant_id = ? AND scope_key = ? ORDER BY revision ASC`
  ).all(tenantId, scopeKey) as SnapshotMeta[];

const countRows = (db: DatabaseType.Database, table: string, tenantId: string, stateId: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND state_id = ?`).get(tenantId, stateId) as { n: number }).n;

function assertNullDigestIsBare(db: DatabaseType.Database, tenantId: string, snap: SnapshotMeta): void {
  const ledger = countRows(db, 'eng4_snapshot_changes', tenantId, snap.state_id);
  const coverage = countRows(db, 'eng4_version_coverage', tenantId, snap.state_id);
  const versions = countRows(db, 'eng4_fact_versions', tenantId, snap.state_id) + countRows(db, 'eng4_loop_versions', tenantId, snap.state_id);
  if (ledger || coverage || versions) {
    throw new CheckpointIntegrityError(
      `eng4: snapshot ${snap.state_id} has no change digest but carries ${ledger} ledger, ${coverage} coverage and ${versions} version rows — corruption, not legacy history`
    );
  }
}

/** Effective per-scope cutover mark: the revision through which coverage is known complete, or null. */
export function coverageCutover(db: DatabaseType.Database, tenantId: string, scopeKey: string): number | null {
  const row = db.prepare(
    `SELECT MAX(through_revision) AS r FROM eng4_version_cutover WHERE tenant_id = ? AND scope_key = ?`
  ).get(tenantId, scopeKey) as { r: number | null };
  return row.r === null ? null : Number(row.r);
}

/** Whether a snapshot's coverage was produced by a backfill (immutable mark). */
export function wasBackfilled(db: DatabaseType.Database, tenantId: string, scopeKey: string, stateId: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM eng4_version_backfills WHERE tenant_id = ? AND scope_key = ? AND state_id = ?`
  ).get(tenantId, scopeKey, stateId);
}

/**
 * Verified backfill of every ledger-bound snapshot that has no coverage yet,
 * plus structural checks on everything else. Throws CheckpointIntegrityError
 * on any failure so the caller's transaction rolls the whole apply back.
 *
 * Idempotent and cheap on a healthy store: a covered snapshot only gets a
 * COUNT parity check (ledger rows vs coverage rows) — no payload read, no
 * hashing; full value parity is verifyVersionParity's job (tests now, resume
 * in H4). An uncovered ledger-bound snapshot is backfilled only if it lies
 * ABOVE the scope's immutable cutover mark (a pre-H2 binary wrote it after a
 * rollback); at or below the mark its coverage was erased → refuse. Each
 * backfilled snapshot gets an append-only backfill mark, and the scope's
 * cutover mark advances to its max revision.
 */
export function backfillVersionFoundation(db: DatabaseType.Database): BackfillSummary {
  const summary: BackfillSummary = { scopesScanned: 0, snapshotsScanned: 0, snapshotsBackfilled: 0, materialized: 0, unversioned: 0 };
  const scopes = db.prepare(`SELECT DISTINCT tenant_id, scope_key FROM eng4_state_snapshots ORDER BY tenant_id, scope_key`)
    .all() as Array<{ tenant_id: string; scope_key: string }>;
  const appliedAt = new Date().toISOString();
  for (const { tenant_id: tenantId, scope_key: scopeKey } of scopes) {
    summary.scopesScanned++;
    const cutover = coverageCutover(db, tenantId, scopeKey);
    let maxRevision = 0;
    for (const snap of snapshotsOfScope(db, tenantId, scopeKey)) {
      summary.snapshotsScanned++;
      maxRevision = Math.max(maxRevision, snap.revision);
      if (snap.changes_hash === null) {
        assertNullDigestIsBare(db, tenantId, snap);
        continue;
      }
      const ledgerRows = countRows(db, 'eng4_snapshot_changes', tenantId, snap.state_id);
      const coverage = countRows(db, 'eng4_version_coverage', tenantId, snap.state_id);
      if (coverage > 0 || ledgerRows === 0) {
        // Covered (or nothing to cover): structural parity only.
        if (coverage !== ledgerRows) {
          throw new CheckpointIntegrityError(
            `eng4: snapshot ${snap.state_id} has ${coverage} coverage rows for ${ledgerRows} ledger tuples`
          );
        }
        continue;
      }
      if (cutover !== null && snap.revision <= cutover) {
        throw new CheckpointIntegrityError(
          `eng4: snapshot ${snap.state_id} (revision ${snap.revision}) is below the scope's coverage cutover ${cutover} yet has no coverage — erased, not legacy`
        );
      }
      // Uncovered ledger-bound snapshot above the cutover: reconstruct from
      // immutable data only, after full verification of that data.
      verifyPayloadIntegrity(db, tenantId, snap.content_hash);
      const changes = readSnapshotChanges(db, tenantId, snap.state_id, snap.content_hash, snap.changes_hash, true) as CheckpointChanges;
      const env = readEnvelope(db, tenantId, snap.content_hash, snap.state_id);
      assertLedgerAgreesWithEnvelope(snap.state_id, changes, env);
      db.prepare(
        `INSERT INTO eng4_version_backfills (tenant_id, scope_key, state_id, applied_at) VALUES (?, ?, ?, ?)`
      ).run(tenantId, scopeKey, snap.state_id, appliedAt);
      changes.facts.forEach((f, i) => {
        insertCoverage(db, tenantId, scopeKey, snap.state_id, 'fact', i, f.factId, 'materialized', null, 'backfill');
        insertFactVersion(db, tenantId, scopeKey, f.factId, snap.state_id, i, factVersionValue(env.factChanges[i]), snap.author, snap.recorded_at);
        summary.materialized++;
      });
      changes.loops.forEach((l, i) => {
        const exp = expectLoop(db, tenantId, scopeKey, snap, i, env.loopChanges[i], l.created, l.loopId, 'backfill');
        if (exp.disposition === 'unversioned') {
          insertCoverage(db, tenantId, scopeKey, snap.state_id, 'loop', i, l.loopId, 'unversioned', exp.reason, 'backfill');
          summary.unversioned++;
          return;
        }
        // A backfill expectation is never owner:null (that branch is source='write' only).
        insertCoverage(db, tenantId, scopeKey, snap.state_id, 'loop', i, l.loopId, 'materialized', null, 'backfill');
        insertLoopVersion(db, tenantId, scopeKey, l.loopId, snap.state_id, i,
          loopVersionValue(env.loopChanges[i], exp.owner as string, snap.author, snap.recorded_at), snap.author, snap.recorded_at);
        summary.materialized++;
      });
      summary.snapshotsBackfilled++;
    }
    // Advance the immutable cutover: everything at or below maxRevision is now
    // known covered (or bare). Only when it actually moves (idempotent).
    if (maxRevision > 0 && (cutover === null || maxRevision > cutover)) {
      db.prepare(
        `INSERT INTO eng4_version_cutover (tenant_id, scope_key, through_revision, applied_at) VALUES (?, ?, ?, ?)`
      ).run(tenantId, scopeKey, maxRevision, appliedAt);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Verifier (bidirectional, before any selection — H4 calls this from resume)
// ---------------------------------------------------------------------------

export interface ParitySummary {
  snapshotsVerified: number;
  tuplesVerified: number;
  materialized: number;
  unversioned: number;
}

interface CoverageRow {
  kind: 'fact' | 'loop';
  ordinal: number;
  change_id: string;
  disposition: 'materialized' | 'unversioned';
  reason: string | null;
  source: 'write' | 'backfill';
}

/**
 * Recompute the expected coverage + version set for EVERY snapshot in a
 * scope from the hash-verified payloads, the digest-verified ledger and the
 * snapshot rows, and compare it bidirectionally with what the tables hold.
 * Any missing, extra or mismatched row → CheckpointIntegrityError. Never
 * falls back, never repairs.
 */
export function verifyVersionParity(db: DatabaseType.Database, tenantId: string, scopeKey: string): ParitySummary {
  const summary: ParitySummary = { snapshotsVerified: 0, tuplesVerified: 0, materialized: 0, unversioned: 0 };
  const fail = (stateId: string, why: string): never => {
    throw new CheckpointIntegrityError(`eng4: version parity failed for snapshot ${stateId}: ${why}`);
  };
  for (const snap of snapshotsOfScope(db, tenantId, scopeKey)) {
    summary.snapshotsVerified++;
    if (snap.changes_hash === null) {
      assertNullDigestIsBare(db, tenantId, snap);
      continue;
    }
    verifyPayloadIntegrity(db, tenantId, snap.content_hash);
    const changes = readSnapshotChanges(db, tenantId, snap.state_id, snap.content_hash, snap.changes_hash, true) as CheckpointChanges;
    const env = readEnvelope(db, tenantId, snap.content_hash, snap.state_id);
    assertLedgerAgreesWithEnvelope(snap.state_id, changes, env);
    // The expected coverage source comes from the immutable backfill mark,
    // never from the coverage row itself (review finding 2).
    const expectedSource: 'write' | 'backfill' = wasBackfilled(db, tenantId, scopeKey, snap.state_id) ? 'backfill' : 'write';
    const coverage = db.prepare(
      `SELECT kind, ordinal, change_id, disposition, reason, source, scope_key FROM eng4_version_coverage
        WHERE tenant_id = ? AND state_id = ? ORDER BY kind, ordinal`
    ).all(tenantId, snap.state_id) as Array<CoverageRow & { scope_key: string }>;
    // Every coverage row must belong to THIS scope: selection keys coverage by
    // (tenant, state_id) exactly like this verifier, so an out-of-band
    // scope_key change is detected here rather than silently un-covering a
    // tuple (independent review of PR #14, finding 1).
    for (const c of coverage) if (c.scope_key !== scopeKey) fail(snap.state_id, `coverage ${c.kind}[${c.ordinal}] carries scope '${c.scope_key}'`);
    const expectedTuples = changes.facts.length + changes.loops.length;
    if (coverage.length !== expectedTuples) fail(snap.state_id, `expected ${expectedTuples} coverage rows, found ${coverage.length}`);
    const covOf = (kind: 'fact' | 'loop', ordinal: number, changeId: string): CoverageRow => {
      const row = coverage.find((c) => c.kind === kind && c.ordinal === ordinal);
      if (!row) return fail(snap.state_id, `missing coverage for ${kind}[${ordinal}]`);
      if (row.change_id !== changeId) return fail(snap.state_id, `coverage change_id mismatch for ${kind}[${ordinal}]`);
      if (row.source !== expectedSource) return fail(snap.state_id, `coverage source for ${kind}[${ordinal}] is '${row.source}' but the backfill mark says '${expectedSource}'`);
      return row;
    };

    let expectedFactVersions = 0;
    changes.facts.forEach((f, i) => {
      const cov = covOf('fact', i, f.factId);
      if (cov.disposition !== 'materialized' || cov.reason !== null) fail(snap.state_id, `fact[${i}] must be materialized`);
      const row = db.prepare(
        `SELECT subject, predicate, object, status, effective_at, refs_json, author, recorded_at
           FROM eng4_fact_versions WHERE tenant_id = ? AND scope_key = ? AND fact_id = ? AND state_id = ? AND ordinal = ?`
      ).get(tenantId, scopeKey, f.factId, snap.state_id, i) as any;
      if (!row) fail(snap.state_id, `missing fact version for fact[${i}] ${f.factId}`);
      const exp = factVersionValue(env.factChanges[i]);
      const actual: FactVersionValue = {
        subject: row.subject, predicate: row.predicate, object: row.object, status: row.status,
        effectiveAt: row.effective_at ?? null, refsJson: row.refs_json,
      };
      if (canonicalize(actual) !== canonicalize(exp) || row.author !== snap.author || row.recorded_at !== snap.recorded_at) {
        fail(snap.state_id, `fact version value mismatch for fact[${i}] ${f.factId}`);
      }
      expectedFactVersions++;
      summary.materialized++;
      summary.tuplesVerified++;
    });

    let expectedLoopVersions = 0;
    changes.loops.forEach((l, i) => {
      const cov = covOf('loop', i, l.loopId);
      const exp = expectLoop(db, tenantId, scopeKey, snap, i, env.loopChanges[i], l.created, l.loopId, expectedSource);
      const row = db.prepare(
        `SELECT owner, status, next_action, due_at, blocked_on, close_json, author, recorded_at
           FROM eng4_loop_versions WHERE tenant_id = ? AND scope_key = ? AND loop_id = ? AND state_id = ? AND ordinal = ?`
      ).get(tenantId, scopeKey, l.loopId, snap.state_id, i) as any;
      if (exp.disposition === 'unversioned') {
        if (cov.disposition !== 'unversioned' || cov.reason !== exp.reason) {
          fail(snap.state_id, `loop[${i}] ${l.loopId} must be unversioned (${exp.reason})`);
        }
        if (row) fail(snap.state_id, `loop[${i}] ${l.loopId} is unversioned but has a version row`);
        summary.unversioned++;
        summary.tuplesVerified++;
        return;
      }
      if (cov.disposition !== 'materialized' || cov.reason !== null) fail(snap.state_id, `loop[${i}] ${l.loopId} must be materialized`);
      if (!row) fail(snap.state_id, `missing loop version for loop[${i}] ${l.loopId}`);
      const owner = exp.owner ?? String(row.owner); // null = accepted as recorded (source write, unprovable chain)
      const expected = loopVersionValue(env.loopChanges[i], owner, snap.author, snap.recorded_at);
      const actual: LoopVersionValue = {
        owner: row.owner, status: row.status, nextAction: row.next_action,
        dueAt: row.due_at ?? null, blockedOn: row.blocked_on ?? null, closeJson: row.close_json ?? null,
      };
      if (canonicalize(actual) !== canonicalize(expected) || row.author !== snap.author || row.recorded_at !== snap.recorded_at) {
        fail(snap.state_id, `loop version value mismatch for loop[${i}] ${l.loopId}`);
      }
      expectedLoopVersions++;
      summary.materialized++;
      summary.tuplesVerified++;
    });

    // Reverse direction: no version rows beyond the ones coverage accounts for.
    const factVersions = countRows(db, 'eng4_fact_versions', tenantId, snap.state_id);
    const loopVersions = countRows(db, 'eng4_loop_versions', tenantId, snap.state_id);
    if (factVersions !== expectedFactVersions) fail(snap.state_id, `expected ${expectedFactVersions} fact versions, found ${factVersions}`);
    if (loopVersions !== expectedLoopVersions) fail(snap.state_id, `expected ${expectedLoopVersions} loop versions, found ${loopVersions}`);
  }
  return summary;
}
