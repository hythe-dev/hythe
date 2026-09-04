/**
 * ENG-4 H4 — the resultVersion 3 read model (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §6.3–§6.5, §7 row H4; internal
 * increment of resultVersion 3 — not public until H5).
 *
 * CONTRACT
 * - Under v3, currentFacts/openLoops come ONLY from verified `materialized`
 *   versions whose writing snapshot is on the ACCEPTED lineage (the pointed
 *   head's parent chain): newest per (kind, id) by (revision, ordinal) within
 *   the lineage. Every item carries provenance.
 * - An id whose newest accepted-lineage tuple is `unversioned`, or that has
 *   no accepted-lineage change at all, is SUPPRESSED (§6.4): omitted from
 *   the authoritative sections, accounted as omittedReason 'unversioned'
 *   with totalCount including it and nextCursor null, and exposed only in
 *   `legacyValues` as the in-place row with provenance null, accepted false.
 * - A scope with no pointer or an invalid designation has NO accepted
 *   lineage (§6.5): both sections empty with omittedReason 'undesignated';
 *   every in-place row in legacyValues; nothing divergent.
 * - `divergentValues` lists every materialized divergent TERMINAL (newest per
 *   (kind, id) per divergent lineage) with lineageHead, provenance, value,
 *   isV1CurrentValue and whether a reconcile on the accepted lineage has
 *   resolved it. Revision never decides.
 * - A loop close written off the lineage leaves the loop OPEN in v3.
 * - resume v3 verifies the version foundation and every reconcile's rows
 *   (both directions) BEFORE selection and fails closed.
 * - v1/v2 bundles are byte-for-byte the last-writer-wins in-place view.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { RESUME_INPUT_SCHEMA, RESUME_OUTPUT_SCHEMA, RESUME_OUTPUT_SCHEMA_V1, RESUME_OUTPUT_SCHEMA_V2, RESUME_OUTPUT_SCHEMA_V3 } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointIntegrityError } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { readScopePointer } from '../src/unified-server/eng4/heads.js';
import { acceptedLineage, historicalAncestry } from '../src/unified-server/eng4/selection.js';
import { validateEng4Output } from '../src/unified-server/eng4/register.js';
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';

const ajv = new Ajv({ allErrors: true, $data: true });
const validInput = ajv.compile(RESUME_INPUT_SCHEMA as any);
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);
const validV1 = ajv.compile(RESUME_OUTPUT_SCHEMA_V1 as any);
const validV2 = ajv.compile(RESUME_OUTPUT_SCHEMA_V2 as any);
const validV3 = ajv.compile(RESUME_OUTPUT_SCHEMA_V3 as any);

const TENANT = 't1';
const SCOPE = 'p:u-proj';
const directory: ResumeDirectory = {
  resolveEntityCandidatesExact: (name) => (name === 'Proj' ? [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }] : []),
  resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
  getEntityDefinition: () => null,
  getCapsuleObservations: () => ({ capsules: [], candidatesConsidered: 0 }),
};

const freshDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT,
    priority TEXT DEFAULT 'normal', created_at TEXT, read_at TEXT, delivered_at TEXT,
    tenant_id TEXT DEFAULT 'default'
  )`);
  db.exec(`CREATE TABLE session_handoffs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_agent TEXT NOT NULL,
    summary TEXT NOT NULL, open_items_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    consumed_at TEXT, active INTEGER NOT NULL DEFAULT 1, last_confirmed TEXT,
    tenant_id TEXT DEFAULT 'default', user_id TEXT
  )`);
  applyEng4Schema(db);
  return db;
};
const state = (status: string): WorkingState => ({ objective: 'H4', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [] });
let keyCounter = 0;
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe', scope: { project: 'Proj' }, expectedRevision: null,
  idempotencyKey: `k-${String(++keyCounter).padStart(6, '0')}`, state: state('s'), resultVersion: 2, ...over,
});
const write = (db: any, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, cp(over)) as any;
const reconcile = (db: any, over: Partial<CheckpointParams> & { survivor: string; expectedHeads: string[] }) => {
  const rev = (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, over.survivor) as any)?.revision ?? null;
  return performCheckpoint(db, directory, TENANT, cp({
    resultVersion: 3, operation: 'reconcile', expectedRevision: rev, expectedPointer: readScopePointer(db, TENANT, SCOPE)?.stateId ?? null,
    reason: 'test', state: state('reconciled'), ...over,
  })) as any;
};
const fact = (subject: string, over: Partial<FactChange> = {}): FactChange => ({
  assertion: { subject, predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: ['ev'], sourceRefs: ['src'], ...over,
});
const resume = (db: any, over: Record<string, unknown> = {}) =>
  performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 20000, ...over } as any) as any;
const v3 = (db: any, over: Record<string, unknown> = {}) => resume(db, { resultVersion: 3, ...over });
const dropPointer = (db: any) => db.prepare(`DELETE FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE);

const TRIGGERS = ['trg_eng4_snapshots_immutable', 'trg_eng4_fact_versions_immutable', 'trg_eng4_fact_versions_no_delete', 'trg_eng4_loop_versions_immutable', 'trg_eng4_loop_versions_no_delete', 'trg_eng4_version_coverage_immutable', 'trg_eng4_version_coverage_no_delete', 'trg_eng4_version_backfills_immutable', 'trg_eng4_version_backfills_no_delete', 'trg_eng4_version_cutover_immutable', 'trg_eng4_version_cutover_no_delete', 'trg_eng4_merge_inputs_immutable', 'trg_eng4_merge_inputs_no_delete', 'trg_eng4_retirements_immutable', 'trg_eng4_retirements_no_delete', 'trg_eng4_resolutions_immutable', 'trg_eng4_resolutions_no_delete'];
const ddlFor = (name: string) => (DDL_STANDALONE as readonly string[]).find((s) => s.includes(name))!;
/** Out-of-band modification fixture: triggers off, FKs off, modify, restore. */
const bypass = (db: any, fn: () => void) => {
  for (const t of TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
  db.pragma('foreign_keys = OFF');
  try { fn(); } finally { db.pragma('foreign_keys = ON'); for (const t of TRIGGERS) db.exec(ddlFor(t)); }
};
/** Turn a snapshot into unknowable pre-ledger history and rebuild the version foundation. */
const makePreLedger = (db: any, ...stateIds: string[]) => {
  bypass(db, () => {
    db.exec(`DELETE FROM eng4_version_coverage; DELETE FROM eng4_fact_versions; DELETE FROM eng4_loop_versions; DELETE FROM eng4_version_backfills; DELETE FROM eng4_version_cutover;`);
    for (const id of stateIds) {
      db.prepare(`DELETE FROM eng4_snapshot_changes WHERE state_id=?`).run(id);
      db.prepare(`UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE state_id=?`).run(id);
    }
  });
  applyEng4Schema(db);
};

/** root(F=good) → A (state only; pointer) and root → C (F=bad, higher revision). */
const fork = (db: any) => {
  const root = write(db, { factChanges: [fact('good')] });
  const F = root.changes.facts[0].factId;
  const a = write(db, { expectedRevision: 1, state: state('a') });
  const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] });
  return { root, a, c, F };
};

// ---------------------------------------------------------------------------

describe('H4 accepted-lineage selection (§6.3)', () => {
  it('THE §6.1 SHAPE: the frozen v1 view shows the last writer (bad); v3 shows the accepted-lineage value (good) with provenance, and lists bad as a divergent terminal', () => {
    const db = freshDb();
    const { root, a, c, F } = fork(db);
    const v1 = resume(db);
    expect(v1.currentFacts.map((f: any) => f.assertion.subject)).toEqual(['bad']); // last-writer-wins, frozen
    expect('provenance' in v1.currentFacts[0]).toBe(false);
    const b = v3(db);
    expect(b.asOf).toMatchObject({ stateId: a.stateId, selection: 'pointer' });
    expect(b.currentFacts).toEqual([expect.objectContaining({
      factId: F, assertion: { subject: 'good', predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: ['ev'], sourceRefs: ['src'], contradicts: [],
      provenance: { stateId: root.stateId, revision: 1, ordinal: 0, outsideAcceptedLineage: false },
    })]);
    expect(b.coverage.currentFacts).toMatchObject({ includedCount: 1, totalCount: 1, contentComplete: true, omittedReason: 'none' });
    expect(b.divergentValues).toEqual([{
      kind: 'fact', id: F, lineageHead: c.stateId, stateId: c.stateId, revision: c.revision, ordinal: 0,
      value: expect.objectContaining({ assertion: { subject: 'bad', predicate: 'p', object: 'o' }, author: 'claude-hythe' }),
      isV1CurrentValue: true, resolved: false, opaque: false,
    }]);
    expect(b.legacyValues).toEqual([]);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    expect(() => validateEng4Output('resume', b)).not.toThrow();
  });

  it('§6.1 ATTACK: a legacy write on a RETIRED head overwrites the in-place row; the accepted value is untouched and the write is a divergent value', () => {
    const db = freshDb();
    const { root, a, c, F } = fork(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    const bad2 = write(db, { resultVersion: 1, expectedRevision: c.revision, state: state('resurrected'), factChanges: [fact('bad-again', { factId: F })] });
    expect(resume(db).currentFacts[0].assertion.subject).toBe('bad-again'); // v1 destroyed it
    const b = v3(db);
    expect(b.asOf.stateId).toBe(r.stateId);
    expect(b.currentFacts).toEqual([expect.objectContaining({ assertion: expect.objectContaining({ subject: 'good' }), provenance: expect.objectContaining({ stateId: root.stateId }) })]);
    // Two divergent lineages now: the retired C (its terminal F@C, resolved by R) and the resurrection (F@bad2, unresolved).
    expect(b.divergentValues.map((d: any) => [d.stateId, d.value.assertion.subject, d.resolved, d.lineageHead]).sort()).toEqual(
      [[c.stateId, 'bad', true, c.stateId], [bad2.stateId, 'bad-again', false, bad2.stateId]].sort());
    expect(b.heads.find((h: any) => h.stateId === bad2.stateId)).toMatchObject({ parentRetired: true, isCurrent: false });
  });

  it('§6.3 MERGE-INPUT ATTACK under strict:false: good stays accepted, bad is listed divergent and unresolved until a reconcile resolves it', () => {
    const db = freshDb();
    const { a, c, F } = fork(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, strict: false });
    let b = v3(db);
    expect(b.asOf.stateId).toBe(r.stateId);
    expect(b.currentFacts[0].assertion.subject).toBe('good');
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: F, stateId: c.stateId, resolved: false, isV1CurrentValue: true })]);
    const r2 = reconcile(db, { expectedHeads: [r.stateId], survivor: r.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
    b = v3(db);
    expect(b.asOf.stateId).toBe(r2.stateId);
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: F, stateId: c.stateId, resolved: true })]);
    expect(b.currentFacts[0].assertion.subject).toBe('good');
  });

  it('REVISION NEVER DECIDES: S good@higher / R bad@lower still lists bad as unresolved divergent; accepted is good', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] }); // rev 2 (advances pointer)
    const s = write(db, { expectedRevision: 1, state: state('s'), factChanges: [fact('good', { factId: F })] }); // rev 3, divergent
    // Make S the accepted head: reconcile survivor S, leaving C divergent (strict:false).
    const r = reconcile(db, { expectedHeads: [c.stateId, s.stateId], survivor: s.stateId, strict: false });
    const b = v3(db);
    expect(b.asOf.stateId).toBe(r.stateId);
    expect(b.currentFacts[0]).toMatchObject({ assertion: expect.objectContaining({ subject: 'good' }), provenance: expect.objectContaining({ stateId: s.stateId, revision: 3 }) });
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: F, stateId: c.stateId, revision: 2, resolved: false })]);
  });

  it('a loop close written off the lineage leaves the loop OPEN in v3 (v1 shows it closed); accepting the close makes it closed', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'o' }] });
    const L = root.changes.loops[0].loopId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'closed', nextAction: 'done', closeOutcome: 'shipped' }] });
    expect(resume(db).openLoops[0].status).toBe('closed');
    let b = v3(db);
    expect(b.openLoops).toEqual([expect.objectContaining({ loopId: L, status: 'open', owner: 'o', nextAction: 'n', provenance: { stateId: root.stateId, revision: 1, ordinal: 0, outsideAcceptedLineage: false } })]);
    expect('closeEvent' in b.openLoops[0]).toBe(false);
    expect(b.divergentValues).toEqual([expect.objectContaining({ kind: 'loop', id: L, stateId: c.stateId, value: expect.objectContaining({ status: 'closed', closeEvent: expect.objectContaining({ outcome: 'shipped' }) }), isV1CurrentValue: true })]);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId,
      resolutions: [{ kind: 'loop', id: L, divergentStateId: c.stateId, decision: 'accept', acceptedOrdinal: 0 }],
      loopChanges: [{ loopId: L, status: 'closed', nextAction: 'done', closeOutcome: 'shipped' }] });
    b = v3(db);
    expect(b.openLoops[0]).toMatchObject({ status: 'closed', closeEvent: expect.objectContaining({ outcome: 'shipped' }), provenance: expect.objectContaining({ stateId: r.stateId }) });
    expect(b.divergentValues[0]).toMatchObject({ id: L, resolved: true });
  });

  it('newest within the lineage: the same factId twice in one checkpoint selects ordinal 1; a later accepted write beats an earlier one; superseded facts are excluded (not suppressed)', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('v1'), fact('other')] });
    const [F, G] = root.changes.facts.map((f: any) => f.factId);
    const u = write(db, { expectedRevision: 1, factChanges: [fact('v2', { factId: F }), fact('v3', { factId: F })] });
    let b = v3(db);
    expect(b.currentFacts.find((f: any) => f.factId === F)).toMatchObject({ assertion: expect.objectContaining({ subject: 'v3' }), provenance: { stateId: u.stateId, revision: 2, ordinal: 1, outsideAcceptedLineage: false } });
    write(db, { expectedRevision: u.revision, factChanges: [fact('gone', { factId: G, status: 'superseded' })] });
    b = v3(db);
    expect(b.currentFacts.map((f: any) => f.factId)).toEqual([F]);
    expect(b.coverage.currentFacts).toMatchObject({ includedCount: 1, totalCount: 1, contentComplete: true, omittedReason: 'none' });
    expect(b.legacyValues).toEqual([]);
  });

  it('isV1CurrentValue is false once the in-place row no longer equals the divergent value', () => {
    const db = freshDb();
    const { a, F } = fork(db);
    write(db, { expectedRevision: a.revision, factChanges: [fact('good-2', { factId: F })] }); // accepted lineage rewrites F in place
    const b = v3(db);
    expect(b.currentFacts[0].assertion.subject).toBe('good-2');
    expect(b.divergentValues[0]).toMatchObject({ value: expect.objectContaining({ assertion: expect.objectContaining({ subject: 'bad' }) }), isV1CurrentValue: false });
  });

  it('acceptedLineage is the parent chain only; historicalAncestry also follows merge inputs', () => {
    const db = freshDb();
    const { root, a, c } = fork(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    expect(acceptedLineage(db, TENANT, SCOPE, r.stateId).map((s) => s.stateId)).toEqual([r.stateId, a.stateId, root.stateId]);
    expect(historicalAncestry(db, TENANT, SCOPE, r.stateId).sort()).toEqual([r.stateId, a.stateId, root.stateId, c.stateId].sort());
  });
});

describe('H4 suppression: unversioned ids and undesignated scopes (§6.4, §6.5)', () => {
  it('UNVERSIONED-AFTER-RECONCILE ATTACK: the survivor\'s pre-ledger F=good and the losing branch\'s in-place F=bad — after a strict reconcile with no F change, F is ABSENT from accepted facts and bad sits in legacyValues', () => {
    const db = freshDb();
    const root = write(db);
    const a = write(db, { expectedRevision: 1, state: state('a'), factChanges: [fact('good')] });
    const F = a.changes.facts[0].factId;
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] });
    makePreLedger(db, a.stateId, c.stateId); // both writes are unknowable history
    dropPointer(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, expectedPointer: null });
    expect(r.reconciled.resolutions).toEqual([]); // nothing versioned to see
    const b = v3(db);
    expect(b.asOf).toMatchObject({ stateId: r.stateId, selection: 'pointer' });
    expect(b.currentFacts).toEqual([]);
    expect(b.coverage.currentFacts).toEqual(expect.objectContaining({ includedCount: 0, totalCount: 1, contentComplete: false, omittedReason: 'unversioned', nextCursor: null }));
    expect(b.legacyValues).toEqual([{ kind: 'fact', id: F, value: expect.objectContaining({ assertion: expect.objectContaining({ subject: 'bad' }) }), provenance: null, accepted: false }]);
    expect(b.divergentValues).toEqual([]);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    // A re-assertion on the accepted lineage makes F authoritative again.
    write(db, { expectedRevision: r.revision, factChanges: [fact('good-again', { factId: F })] });
    const b2 = v3(db);
    expect(b2.currentFacts[0].assertion.subject).toBe('good-again');
    expect(b2.coverage.currentFacts).toMatchObject({ includedCount: 1, totalCount: 1, contentComplete: true, omittedReason: 'none' });
    expect(b2.legacyValues).toEqual([]);
  });

  it('a loop whose newest accepted tuple is unversioned (unprovable inherited owner) is suppressed with the in-place row in legacyValues; other ids stay authoritative', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }], factChanges: [fact('f')] });
    const L = root.changes.loops[0].loopId;
    const u = write(db, { expectedRevision: 1, loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] });
    makePreLedger(db, root.stateId); // L's creation unknowable → u's tuple unversioned; the fact's creation is gone too
    const b = v3(db);
    expect(b.asOf.stateId).toBe(u.stateId);
    expect(b.openLoops).toEqual([]);
    expect(b.coverage.openLoops).toMatchObject({ includedCount: 0, totalCount: 1, contentComplete: false, omittedReason: 'unversioned' });
    expect(b.currentFacts).toEqual([]); // the fact's only change was pre-ledger → no accepted-lineage tuple → suppressed
    expect(b.coverage.currentFacts).toMatchObject({ includedCount: 0, totalCount: 1, omittedReason: 'unversioned' });
    expect(b.legacyValues.map((l: any) => [l.kind, l.id])).toEqual(expect.arrayContaining([['loop', L]]));
    expect(b.legacyValues).toHaveLength(2);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('LEGACY scope (no pointer): no accepted values — both sections empty with omittedReason undesignated, every in-place row in legacyValues, nothing divergent; v1 unchanged', () => {
    const db = freshDb();
    const { F } = fork(db);
    write(db, { expectedRevision: 1, loopChanges: [{ status: 'open', nextAction: 'n' }] });
    dropPointer(db);
    const b = v3(db);
    expect(b.asOf.selection).toBe('max-revision');
    expect(b.working).not.toBeNull(); // whole-snapshot legacy selection still governs working (§6.5)
    expect(b.currentFacts).toEqual([]);
    expect(b.openLoops).toEqual([]);
    expect(b.coverage.currentFacts).toEqual(expect.objectContaining({ includedCount: 0, totalCount: 1, contentComplete: false, omittedReason: 'undesignated', nextCursor: null }));
    expect(b.coverage.openLoops).toEqual(expect.objectContaining({ includedCount: 0, totalCount: 1, contentComplete: false, omittedReason: 'undesignated' }));
    expect(b.legacyValues.map((l: any) => l.kind).sort()).toEqual(['fact', 'loop']);
    expect(b.legacyValues.find((l: any) => l.kind === 'fact')).toMatchObject({ id: F, provenance: null, accepted: false });
    expect(b.divergentValues).toEqual([]);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    expect(resume(db).currentFacts).toHaveLength(1);
    expect(resume(db, { resultVersion: 2 }).openLoops).toHaveLength(1);
  });

  it('INVALID DESIGNATION: like an undesignated scope for values (nothing accepted), working null', () => {
    const db = freshDb();
    const { root, F } = fork(db);
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    const b = v3(db);
    expect(b.asOf.selection).toBe('invalid-designation');
    expect(b.working).toBeNull();
    expect(b.currentFacts).toEqual([]);
    expect(b.coverage.currentFacts).toMatchObject({ omittedReason: 'undesignated', totalCount: 1 });
    expect(b.legacyValues).toEqual([expect.objectContaining({ id: F })]);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('a fresh scope after H1 (pointer from the first write) has nothing suppressed and nothing legacy', () => {
    const db = freshDb();
    write(db, { factChanges: [fact('a')], loopChanges: [{ status: 'open', nextAction: 'n' }] });
    const b = v3(db);
    expect(b.currentFacts).toHaveLength(1);
    expect(b.openLoops).toHaveLength(1);
    expect(b.legacyValues).toEqual([]);
    expect(b.coverage.legacyValues).toMatchObject({ includedCount: 0, totalCount: 0, contentComplete: true, omittedReason: 'none' });
  });
});

describe('H4 fail-closed: the verifiers run before selection (§6.2, §4.3)', () => {
  it('a deleted coverage row, a deleted version row, or an altered version fails the v3 resume; v1/v2 are unaffected', () => {
    for (const [sql, pattern] of [
      [`DELETE FROM eng4_version_coverage WHERE kind='fact'`, /coverage rows/],
      [`DELETE FROM eng4_fact_versions`, /missing fact version/],
      [`UPDATE eng4_fact_versions SET object='x'`, /fact version value mismatch/],
    ] as const) {
      const db = freshDb();
      fork(db);
      expect(v3(db).currentFacts).toHaveLength(1);
      bypass(db, () => db.exec(sql));
      expect(() => v3(db), sql).toThrow(pattern);
      expect(() => v3(db), sql).toThrow(CheckpointIntegrityError);
      expect(resume(db).currentFacts).toHaveLength(1);
      expect(resume(db, { resultVersion: 2 }).currentFacts).toHaveLength(1);
    }
  });

  it('a deleted retirement row of an OFF-lineage reconcile (re-review LOW 1) fails the v3 resume — retirement evidence is bidirectional scope-wide', () => {
    const db = freshDb();
    const { a, c, F } = fork(db);
    const r1 = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] }); // retires C
    const e = write(db, { expectedRevision: a.revision, state: state('e') });
    // Survivor E makes R1 off-lineage; F@C is owed again (its resolver R1 no longer counts) and R1 itself is retired.
    const r2 = reconcile(db, { expectedHeads: [e.stateId, r1.stateId], survivor: e.stateId, rejectLineages: [r1.stateId], resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
    expect(v3(db).asOf.stateId).toBe(r2.stateId);
    bypass(db, () => db.prepare(`DELETE FROM eng4_head_retirements WHERE state_id=?`).run(c.stateId));
    expect(() => v3(db)).toThrow(/retirement rows attributed to reconcile .* differ/);
    const db2 = freshDb();
    const f2 = fork(db2);
    const q1 = reconcile(db2, { expectedHeads: [f2.a.stateId, f2.c.stateId], survivor: f2.a.stateId, rejectLineages: [f2.c.stateId] });
    bypass(db2, () => db2.prepare(`DELETE FROM eng4_snapshot_merge_inputs WHERE state_id=?`).run(q1.stateId));
    expect(() => v3(db2)).toThrow(/merge-input rows of reconcile .* differ/);
  });
});

describe('H4 bundle shape, ordering, budget (§2.7, §9.3)', () => {
  it('v3 validates in every mode and is exclusive with v1/v2; v1/v2 carry no provenance and no new sections', () => {
    const db = freshDb();
    fork(db);
    const bundles = [resume(db), resume(db, { resultVersion: 2 }), v3(db)];
    [validV1, validV2, validV3].forEach((v, j) => bundles.forEach((b, i) => expect(v(b), `v${i + 1} vs schema ${j + 1}: ${ajv.errorsText(v.errors)}`).toBe(i === j)));
    bundles.forEach((b) => expect(validBundle(b)).toBe(true));
    for (const b of bundles.slice(0, 2)) {
      expect('divergentValues' in b).toBe(false);
      expect('legacyValues' in b).toBe(false);
      expect(b.currentFacts.every((f: any) => !('provenance' in f))).toBe(true);
    }
    const b3 = bundles[2];
    expect(validV3({ ...b3, currentFacts: [{ ...b3.currentFacts[0], provenance: undefined }] })).toBe(false);
    expect(validV3({ ...b3, legacyValues: [{ kind: 'fact', id: 'x', value: b3.currentFacts[0], provenance: null, accepted: true }] })).toBe(false);
  });

  it('section order: heads after capsule; divergentValues then legacyValues last', () => {
    const db = freshDb();
    fork(db);
    const order = Object.keys(v3(db).coverage).filter((k) => k !== 'totalTokenEstimate' && k !== 'budget');
    expect(order).toEqual(['working', 'capsule', 'heads', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers', 'divergentValues', 'legacyValues']);
  });

  it('input schema: divergentValues/legacyValues in sections require resultVersion 3', () => {
    const base = { agentId: 'a', scope: { project: 'Proj' }, budget: 1024 };
    for (const s of ['divergentValues', 'legacyValues']) {
      expect(validInput({ ...base, sections: [s] })).toBe(false);
      expect(validInput({ ...base, resultVersion: 2, sections: [s] })).toBe(false);
      expect(validInput({ ...base, resultVersion: 3, sections: [s] })).toBe(true);
    }
  });

  it('divergentValues is BUDGETED: a tight budget omits it with a cursor (legacyValues omitted first); walking the cursor delivers every terminal exactly once', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    write(db, { expectedRevision: 1, state: state('a') }); // pointer
    const N = 30;
    for (let i = 0; i < N; i++) write(db, { expectedRevision: 1, state: state(`b${i}`), factChanges: [fact(`bad-${i}`, { factId: F })] });
    dropPointer(db); // …but keep the pointer at A: re-point explicitly
    const a = (db.prepare(`SELECT state_id FROM eng4_state_snapshots WHERE revision=2`).get() as any).state_id;
    db.prepare(`INSERT INTO eng4_scope_current VALUES (?, ?, ?, 't', 'x', 'first-write')`).run(TENANT, SCOPE, a);
    const full = v3(db, { budget: 200000 });
    expect(full.divergentValues).toHaveLength(N);
    expect(full.coverage.divergentValues).toMatchObject({ includedCount: N, totalCount: N, contentComplete: true });

    const budget = 2600;
    const first = v3(db, { budget });
    expect(first.coverage.totalTokenEstimate).toBeLessThanOrEqual(budget);
    expect(first.currentFacts).toHaveLength(1);
    expect(first.coverage.divergentValues.totalCount).toBe(N);
    expect(first.coverage.divergentValues.includedCount).toBeLessThan(N);
    expect(first.coverage.divergentValues).toMatchObject({ contentComplete: false, omittedReason: 'budget' });
    expect(first.coverage.divergentValues.nextCursor).toEqual(expect.any(String));
    expect(first.coverage.legacyValues).toMatchObject({ includedCount: 0, totalCount: 0 }); // nothing legacy here; still accounted, last
    const seen: string[] = first.divergentValues.map((d: any) => d.stateId);
    let cursor = first.coverage.divergentValues.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = v3(db, { budget, cursor });
      expect(page.coverage.totalTokenEstimate).toBeLessThanOrEqual(budget);
      seen.push(...page.divergentValues.map((d: any) => d.stateId));
      cursor = page.coverage.divergentValues.nextCursor;
      expect(++pages).toBeLessThan(N + 2);
    }
    expect(new Set(seen).size).toBe(N);
    expect(seen).toHaveLength(N);
  });

  it('sections filter: only legacyValues; the suppressed accounting on currentFacts still reports not-requested with the full total', () => {
    const db = freshDb();
    fork(db);
    dropPointer(db);
    const b = v3(db, { sections: ['legacyValues'] });
    expect(b.legacyValues).toHaveLength(1);
    expect(b.currentFacts).toEqual([]);
    expect(b.coverage.currentFacts).toMatchObject({ omittedReason: 'not-requested', totalCount: 1 });
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
  });
});

describe('H4 independent review round 1 — coverage key parity, paged suppression, flags and metadata', () => {
  it('FINDING 1: an out-of-band scope_key change on a coverage row fails the v3 resume instead of un-covering the tuple and falling back to an older value', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('v1')] });
    const F = root.changes.facts[0].factId;
    const u = write(db, { expectedRevision: 1, factChanges: [fact('v2', { factId: F })] });
    expect(v3(db).currentFacts[0].assertion.subject).toBe('v2');
    bypass(db, () => db.prepare(`UPDATE eng4_version_coverage SET scope_key='p:elsewhere' WHERE state_id=?`).run(u.stateId));
    expect(() => v3(db)).toThrow(/carries scope 'p:elsewhere'/);
    expect(() => v3(db)).toThrow(CheckpointIntegrityError);
    expect(resume(db).currentFacts[0].assertion.subject).toBe('v2'); // v1 untouched
  });

  it('FINDING 2: suppression stays visible across pages — suppressedCount on every page, and the suppression reason once every deliverable item is out', () => {
    const db = freshDb();
    const root = write(db, { factChanges: Array.from({ length: 12 }, (_, i) => fact(`f${i}`)) });
    // One more fact whose only change is pre-ledger → suppressed.
    const extra = write(db, { expectedRevision: root.revision, factChanges: [fact('legacy-only')] });
    const S = extra.changes.facts[0].factId;
    makePreLedger(db, extra.stateId);
    const full = v3(db, { budget: 50000 });
    expect(full.coverage.currentFacts).toMatchObject({ includedCount: 12, totalCount: 13, suppressedCount: 1, contentComplete: false, omittedReason: 'unversioned', nextCursor: null });
    expect(full.legacyValues).toEqual([expect.objectContaining({ id: S })]);
    const budget = 520; // enough for working + heads, not for all twelve facts
    const p1 = v3(db, { budget });
    expect(p1.coverage.currentFacts).toMatchObject({ totalCount: 13, suppressedCount: 1, omittedReason: 'budget', contentComplete: false });
    expect(p1.coverage.currentFacts.includedCount).toBeLessThan(12);
    expect(p1.coverage.currentFacts.nextCursor).toEqual(expect.any(String));
    let cursor = p1.coverage.currentFacts.nextCursor; let last: any = p1; let delivered = p1.currentFacts.length;
    while (cursor) { last = v3(db, { budget, cursor }); delivered += last.currentFacts.length; cursor = last.coverage.currentFacts.nextCursor; }
    expect(delivered).toBe(12);
    // The final page has delivered everything deliverable: the reason is the suppression, cursor null, count still 1.
    expect(last.coverage.currentFacts).toMatchObject({ totalCount: 13, suppressedCount: 1, omittedReason: 'unversioned', contentComplete: false, nextCursor: null });
    // A later page (section already delivered) still carries the count.
    const later = v3(db, { budget, cursor: Buffer.from(JSON.stringify({ s: 'legacyValues', o: 0 }), 'utf8').toString('base64url') });
    expect(later.coverage.currentFacts).toMatchObject({ omittedReason: 'cursor', suppressedCount: 1, totalCount: 13 });
    for (const b of [full, p1, last, later]) expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    expect(validV3({ ...full, coverage: { ...full.coverage, currentFacts: { ...full.coverage.currentFacts, suppressedCount: 99 } } })).toBe(false); // ≤ totalCount
  });

  it('FINDING 3: isV1CurrentValue tolerates ref order and duplicates (the in-place refs table sorts and dedupes)', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    write(db, { expectedRevision: 1, state: state('a') });
    write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F, evidenceRefs: ['z', 'a'], sourceRefs: ['s', 's'] })] });
    const b = v3(db);
    expect(b.divergentValues[0]).toMatchObject({ isV1CurrentValue: true, value: expect.objectContaining({ evidenceRefs: ['z', 'a'], sourceRefs: ['s', 's'] }) });
    expect(resume(db).currentFacts[0].evidenceRefs).toEqual(['a', 'z']);
  });

  it('FINDING 4: loop openedAt is the in-place creation time even when the creation is pre-ledger', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'o' }] });
    const L = root.changes.loops[0].loopId;
    const openedAt = (db.prepare(`SELECT opened_at FROM eng4_open_loops WHERE loop_id=?`).get(L) as any).opened_at;
    const u = write(db, { expectedRevision: 1, loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x', owner: 'o' }] });
    makePreLedger(db, root.stateId);
    const b = v3(db);
    const uRecordedAt = (db.prepare(`SELECT recorded_at FROM eng4_state_snapshots WHERE state_id=?`).get(u.stateId) as any).recorded_at;
    expect(b.openLoops).toEqual([expect.objectContaining({ loopId: L, status: 'blocked', openedAt, updatedAt: uRecordedAt, provenance: expect.objectContaining({ stateId: u.stateId }) })]);
  });

  it('FINDING 5: an altered actor, time or reason on an OFF-lineage reconcile\'s retirement row fails the v3 resume', () => {
    for (const sql of [`UPDATE eng4_head_retirements SET retired_by='intruder'`, `UPDATE eng4_head_retirements SET retired_at='1970-01-01T00:00:00Z'`, `UPDATE eng4_head_retirements SET reason='rewritten'`]) {
      const db = freshDb();
      const { a, c, F } = fork(db);
      const r1 = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
      const e = write(db, { expectedRevision: a.revision, state: state('e') });
      reconcile(db, { expectedHeads: [e.stateId, r1.stateId], survivor: e.stateId, rejectLineages: [r1.stateId], resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
      bypass(db, () => db.prepare(`${sql} WHERE state_id=?`).run(c.stateId)); // C's retirement belongs to R1, now off-lineage
      expect(() => v3(db), sql).toThrow(/actor, time or reason that differs/);
    }
  });

  it('FINDING 6: opaque divergent terminals are counted on asOf (not listed), so a pending mandatory rejection is visible', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] });
    makePreLedger(db, root.stateId); // C's tuple becomes unversioned (opaque)
    const b = v3(db);
    expect(b.asOf.opaqueDivergentCount).toBe(1);
    // Listed with value null and opaque:true (codex-hythe finding 1): never hidden behind an accepted value for the same id.
    expect(b.divergentValues).toEqual([{ kind: 'loop', id: L, lineageHead: c.stateId, stateId: c.stateId, revision: c.revision, ordinal: 0, value: null, isV1CurrentValue: false, resolved: false, opaque: true }]);
    expect(b.legacyValues).toEqual([expect.objectContaining({ kind: 'loop', id: L })]); // in-place row shows C's write
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    expect(validV3({ ...b, divergentValues: [{ ...b.divergentValues[0], opaque: false }] })).toBe(false); // opaque:false needs a value object
    expect(validV3({ ...b, divergentValues: [{ ...b.divergentValues[0], isV1CurrentValue: true }] })).toBe(false);
    // Once a reconcile rejects it, it stays listed (resolved) but no longer counts as owed (delta re-review LOW 1).
    const aHead = b.asOf.stateId;
    reconcile(db, { expectedHeads: [aHead, c.stateId], survivor: aHead, rejectLineages: [c.stateId] });
    const after = v3(db);
    expect(after.asOf.opaqueDivergentCount).toBe(0);
    expect(after.divergentValues).toEqual([expect.objectContaining({ id: L, stateId: c.stateId, opaque: true, resolved: true })]);
  });

  it('more cases: suppressed id with divergent versions; divergent value equal to the accepted one; superseded on a divergent branch; closed loop in legacyValues; empty scope', () => {
    // Suppressed id that also has a divergent version: the accepted side is unknowable, the divergent side is listed.
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] });
    makePreLedger(db, root.stateId);
    let b = v3(db);
    expect(b.currentFacts).toEqual([]);
    expect(b.coverage.currentFacts).toMatchObject({ suppressedCount: 1, omittedReason: 'unversioned' });
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: F, stateId: c.stateId })]);
    expect(b.legacyValues).toEqual([expect.objectContaining({ id: F })]);
    // Equal value on a divergent branch still needs a resolution and is listed (causal, not value-based).
    const db2 = freshDb();
    const r2 = write(db2, { factChanges: [fact('same')] });
    const G = r2.changes.facts[0].factId;
    write(db2, { expectedRevision: 1, state: state('a') });
    write(db2, { expectedRevision: 1, state: state('c'), factChanges: [fact('same', { factId: G })] });
    b = v3(db2);
    expect(b.currentFacts[0].assertion.subject).toBe('same');
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: G, isV1CurrentValue: true, resolved: false })]);
    // Superseded on a divergent branch: accepted value stands; the superseding write is a divergent value.
    const db3 = freshDb();
    const r3 = write(db3, { factChanges: [fact('keep')] });
    const H = r3.changes.facts[0].factId;
    write(db3, { expectedRevision: 1, state: state('a') });
    write(db3, { expectedRevision: 1, state: state('c'), factChanges: [fact('keep', { factId: H, status: 'superseded' })] });
    b = v3(db3);
    expect(b.currentFacts).toEqual([expect.objectContaining({ factId: H, status: 'asserted' })]);
    expect(b.divergentValues).toEqual([expect.objectContaining({ id: H, value: expect.objectContaining({ status: 'superseded' }) })]);
    expect(resume(db3).currentFacts).toEqual([]); // v1: superseded in place
    // Closed loop in legacyValues under an undesignated scope; empty scope under v3.
    const db4 = freshDb();
    const r4 = write(db4, { loopChanges: [{ status: 'closed', nextAction: 'done', closeOutcome: 'ok' }] });
    dropPointer(db4);
    b = v3(db4);
    expect(b.legacyValues).toEqual([expect.objectContaining({ kind: 'loop', id: r4.changes.loops[0].loopId, value: expect.objectContaining({ status: 'closed' }) })]);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    const empty = v3(freshDb());
    expect(empty.asOf).toMatchObject({ selection: 'empty-scope', opaqueDivergentCount: 0 });
    expect(empty.coverage.currentFacts).toMatchObject({ totalCount: 0, suppressedCount: 0, contentComplete: true });
    expect(validV3(empty), ajv.errorsText(validV3.errors)).toBe(true);
  });
});

describe('H4 codex-hythe review d3333310 — opaque terminal beside an accepted value; superseded rows in legacyValues', () => {
  it('FINDING 1: an opaque off-lineage terminal whose id ALSO has an accepted materialized value is still listed (value null, opaque true) and counted', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    // C first (owner omitted; its only predecessor will be the unknowable creation → opaque), then A on the other branch with an explicit owner (materialized).
    const c = write(db, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] });
    const a = write(db, { expectedRevision: 1, state: state('a'), loopChanges: [{ loopId: L, status: 'open', nextAction: 'accepted-update', owner: 'orig' }] });
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(a.stateId, TENANT, SCOPE); // make A the accepted head (a live head → valid designation)
    makePreLedger(db, root.stateId);
    const b = v3(db);
    expect(b.asOf.selection).toBe('pointer');
    expect(b.openLoops).toEqual([expect.objectContaining({ loopId: L, nextAction: 'accepted-update', provenance: expect.objectContaining({ stateId: a.stateId }) })]);
    expect(b.divergentValues).toEqual([expect.objectContaining({ kind: 'loop', id: L, stateId: c.stateId, value: null, opaque: true, resolved: false })]);
    expect(b.asOf.opaqueDivergentCount).toBe(1);
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    // And a strict reconcile indeed demands its rejection.
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId })).toThrow(/opaque terminal/);
  });

  it('FINDING 3: a persisted superseded in-place fact reaches legacyValues under an undesignated scope and is counted; v1/v2 still filter it', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('live'), fact('old')] });
    const [F, G] = root.changes.facts.map((f: any) => f.factId);
    write(db, { expectedRevision: 1, factChanges: [fact('old', { factId: G, status: 'superseded' })] });
    dropPointer(db);
    const b = v3(db);
    expect(b.currentFacts).toEqual([]);
    expect(b.coverage.currentFacts).toMatchObject({ totalCount: 2, suppressedCount: 2, omittedReason: 'undesignated' });
    expect(b.legacyValues.map((l: any) => [l.id, l.value.status]).sort()).toEqual([[F, 'asserted'], [G, 'superseded']].sort());
    expect(validV3(b), ajv.errorsText(validV3.errors)).toBe(true);
    expect(resume(db).currentFacts.map((f: any) => f.factId)).toEqual([F]);
    expect(resume(db, { resultVersion: 2 }).currentFacts.map((f: any) => f.factId)).toEqual([F]);
    // Under a pointer, an accepted superseded fact is excluded by rule, not suppressed, and not legacy.
    const db2 = freshDb();
    const r2 = write(db2, { factChanges: [fact('x')] });
    write(db2, { expectedRevision: 1, factChanges: [fact('x', { factId: r2.changes.facts[0].factId, status: 'superseded' })] });
    const b2 = v3(db2);
    expect(b2.currentFacts).toEqual([]);
    expect(b2.coverage.currentFacts).toMatchObject({ totalCount: 0, suppressedCount: 0, contentComplete: true });
    expect(b2.legacyValues).toEqual([]);
  });
});
