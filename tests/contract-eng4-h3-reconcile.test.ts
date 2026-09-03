/**
 * ENG-4 H3 — atomic, integrity-bound reconciliation (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §4, §4.5, §6.3, §7 row H3; internal
 * increment of resultVersion 3 — not public until H5).
 *
 * CONTRACT
 * - `operation: 'reconcile'` (resultVersion 3) names the EXACT live-head set
 *   and the pointer (both CAS → `conflict` carrying heads + pointer), picks a
 *   survivor (its parent; expectedRevision must be the survivor's), retires
 *   every other head (recorded, never deleted; also recorded as merge
 *   inputs), sets the pointer to itself, and resolves every divergent
 *   terminal value CAUSALLY: a terminal is resolved only by a resolution
 *   recorded in a reconcile payload on the accepted lineage — never by
 *   revision.
 * - strict (default) refuses while any materialized terminal is unresolved;
 *   strict:false commits and reports counts. Opaque (unversioned) terminals
 *   can only be rejected and may never remain unresolved.
 * - `accept` must name this request's own change (acceptedOrdinal) for the
 *   same id whose comparable value equals the divergent terminal value.
 *   rejectLineages expands to per-terminal rejects; overlaps are refused.
 * - The reconciliation record is bound into the reconcile snapshot's payload
 *   (contentHash); replay and ordinary v3 resume verify the merge-input,
 *   retirement and resolution rows against it bidirectionally.
 * - liveHeads excludes retired snapshots; retired snapshots stay fetchable.
 *   A write extending a retired head is a live head that is never current
 *   (heads.parentRetired: true); under v3 it requires acknowledgeRetired.
 * - v1/v2 request and result shapes are unchanged; H-series fields fail
 *   validation there.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { CHECKPOINT_INPUT_SCHEMA, CHECKPOINT_OUTPUT_SCHEMA, RESUME_OUTPUT_SCHEMA_V3 } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointEmptyScopeError, CheckpointIntegrityError } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { requestFingerprint } from '../src/unified-server/eng4/canonical.js';
import { effectiveCurrentHead, liveHeads, readScopePointer } from '../src/unified-server/eng4/heads.js';
import { CheckpointReconcileError, CheckpointRetiredParentError, readReconciliation, verifyResolutionRowsOnLineage, verifyRetirementAttribution } from '../src/unified-server/eng4/reconcile.js';
import { verifyVersionParity } from '../src/unified-server/eng4/versions.js';
import { fetchResourceByUri } from '../src/unified-server/eng4/resource.js';
import { validateEng4Output } from '../src/unified-server/eng4/register.js';
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';

const ajv = new Ajv({ allErrors: true, $data: true });
const validInput = ajv.compile(CHECKPOINT_INPUT_SCHEMA as any);
const validResult = ajv.compile(CHECKPOINT_OUTPUT_SCHEMA as any);
const validV3 = ajv.compile(RESUME_OUTPUT_SCHEMA_V3 as any);

const TENANT = 't1';
const SCOPE = 'p:u-proj';
const directory: ResumeDirectory = {
  resolveEntityCandidatesExact: (name) =>
    name === 'Proj' ? [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }]
    : name === 'Other' ? [{ id: 'u-other', name: 'Other', matchedBy: 'canonical_name' }]
    : [],
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

const state = (status: string): WorkingState => ({ objective: 'H3', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [] });
let keyCounter = 0;
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe',
  scope: { project: 'Proj' },
  expectedRevision: null,
  idempotencyKey: `k-${String(++keyCounter).padStart(6, '0')}`,
  state: state('s'),
  resultVersion: 2,
  ...over,
});
const write = (db: any, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, cp(over)) as any;
/** A reconcile request; expectedRevision defaults to the survivor's revision. */
const reconcileParams = (db: any, over: Partial<CheckpointParams> & { survivor: string; expectedHeads: string[] }): CheckpointParams => {
  const survivorRev = (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, over.survivor) as any)?.revision ?? null;
  return cp({
    resultVersion: 3, operation: 'reconcile', expectedRevision: survivorRev, expectedPointer: readScopePointer(db, TENANT, SCOPE)?.stateId ?? null,
    reason: 'test reconcile', state: state('reconciled'), ...over,
  });
};
const reconcile = (db: any, over: Partial<CheckpointParams> & { survivor: string; expectedHeads: string[] }) =>
  performCheckpoint(db, directory, TENANT, reconcileParams(db, over)) as any;
const fact = (subject: string, over: Partial<FactChange> = {}): FactChange => ({
  assertion: { subject, predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: ['ev'], sourceRefs: ['src'], ...over,
});
const resume = (db: any, over: Record<string, unknown> = {}) =>
  performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 8000, ...over } as any) as any;
const pointerRow = (db: any) => db.prepare(`SELECT state_id, reason FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).get(TENANT, SCOPE) as any;
const retirements = (db: any) => db.prepare(`SELECT state_id, retired_by_state_id, reason FROM eng4_head_retirements WHERE tenant_id=? AND scope_key=? ORDER BY state_id`).all(TENANT, SCOPE) as any[];
const resolutionRows = (db: any) => db.prepare(`SELECT kind, change_id, divergent_state_id, resolved_by_state_id, decision, accepted_ordinal FROM eng4_divergence_resolutions WHERE tenant_id=? AND scope_key=? ORDER BY kind, change_id, divergent_state_id`).all(TENANT, SCOPE) as any[];
const liveIds = (db: any) => liveHeads(db, TENANT, SCOPE).map((h) => h.stateId);
const dropPointer = (db: any) => db.prepare(`DELETE FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE);

const TRIGGERS = ['trg_eng4_merge_inputs_immutable', 'trg_eng4_merge_inputs_no_delete', 'trg_eng4_retirements_immutable', 'trg_eng4_retirements_no_delete', 'trg_eng4_resolutions_immutable', 'trg_eng4_resolutions_no_delete', 'trg_eng4_snapshots_immutable', 'trg_eng4_version_coverage_immutable', 'trg_eng4_version_coverage_no_delete', 'trg_eng4_fact_versions_no_delete', 'trg_eng4_loop_versions_no_delete', 'trg_eng4_version_backfills_no_delete'];
const ddlFor = (name: string) => (DDL_STANDALONE as readonly string[]).find((s) => s.includes(name))!;
/** Out-of-band modification fixture: triggers off, FKs off, modify, restore. */
const bypass = (db: any, fn: () => void) => {
  for (const t of TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
  db.pragma('foreign_keys = OFF');
  try { fn(); } finally { db.pragma('foreign_keys = ON'); for (const t of TRIGGERS) db.exec(ddlFor(t)); }
};

/** root → A (pointer advances to A) and root → C (divergent, higher revision). */
const attack = (db: any) => {
  const root = write(db);
  const a = write(db, { expectedRevision: 1, state: state('a') });
  const c = write(db, { expectedRevision: 1, state: state('c') });
  return { root, a, c };
};
/** root(F=good) → A (state only, pointer) and root → C (F=bad). Survivor A. */
const forkWithFact = (db: any) => {
  const root = write(db, { factChanges: [fact('good')] });
  const F = root.changes.facts[0].factId;
  const a = write(db, { expectedRevision: 1, state: state('a') });
  const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] });
  return { root, a, c, F };
};

// ---------------------------------------------------------------------------

describe('H3 DDL — merge inputs, retirements, resolutions (§4.2, §6.3)', () => {
  it('tables and six append-only triggers exist; cross-scope references are rejected by composite FK', () => {
    const db = freshDb();
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','trigger')`).all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['eng4_snapshot_merge_inputs', 'eng4_head_retirements', 'eng4_divergence_resolutions', ...TRIGGERS.slice(0, 6)]));
    const { a, c } = attack(db);
    const other = performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'Other' } })) as any;
    expect(() => db.prepare(`INSERT INTO eng4_snapshot_merge_inputs VALUES (?, ?, ?, ?)`).run(TENANT, SCOPE, a.stateId, other.stateId)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO eng4_head_retirements VALUES (?, ?, ?, ?, 't', 'x', 'r')`).run(TENANT, SCOPE, other.stateId, a.stateId)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO eng4_head_retirements VALUES (?, ?, ?, ?, 't', 'x', 'r')`).run(TENANT, 'p:u-other', c.stateId, other.stateId)).toThrow(/FOREIGN KEY/);
    // accept needs a ledger row at (resolved_by, kind, ordinal); reject must not carry one.
    expect(() => db.prepare(`INSERT INTO eng4_divergence_resolutions VALUES (?, ?, 'fact', 'f', ?, ?, 'accept', 0)`).run(TENANT, SCOPE, c.stateId, a.stateId)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO eng4_divergence_resolutions VALUES (?, ?, 'fact', 'f', ?, ?, 'reject', 0)`).run(TENANT, SCOPE, c.stateId, a.stateId)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO eng4_divergence_resolutions VALUES (?, ?, 'fact', 'f', ?, ?, 'accept', NULL)`).run(TENANT, SCOPE, c.stateId, a.stateId)).toThrow(/CHECK/);
  });

  it('all three tables are append-only', () => {
    const db = freshDb();
    const { a, c } = forkWithFact(db);
    reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    for (const [table, col] of [['eng4_snapshot_merge_inputs', 'input_state_id'], ['eng4_head_retirements', 'reason'], ['eng4_divergence_resolutions', 'decision']] as const) {
      expect(() => db.prepare(`UPDATE ${table} SET ${col}='x'`).run(), table).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(/append-only/);
    }
  });
});

describe('H3 schemas and fingerprint (§2.2, §4.1, §5.1 rule)', () => {
  it('input: v3 reconcile requires expectedHeads/expectedPointer/survivor/reason; v1/v2 reject every H-series field; write rejects reconcile-only fields; accept needs acceptedOrdinal', () => {
    const base = cp({ resultVersion: 3 });
    expect(validInput(base)).toBe(true);
    expect(validInput({ ...base, operation: 'write' })).toBe(true);
    expect(validInput({ ...base, acknowledgeRetired: true })).toBe(true);
    expect(validInput({ ...base, operation: 'reconcile' })).toBe(false);
    const rec = { ...base, operation: 'reconcile', expectedHeads: ['x'], expectedPointer: null, survivor: 'x', reason: 'r' };
    expect(validInput(rec), ajv.errorsText(validInput.errors)).toBe(true);
    expect(validInput({ ...rec, strict: false, rejectLineages: ['y'], resolutions: [{ kind: 'fact', id: 'f', divergentStateId: 'y', decision: 'reject' }] })).toBe(true);
    expect(validInput({ ...rec, resolutions: [{ kind: 'fact', id: 'f', divergentStateId: 'y', decision: 'accept' }] })).toBe(false);
    expect(validInput({ ...rec, resolutions: [{ kind: 'fact', id: 'f', divergentStateId: 'y', decision: 'reject', acceptedOrdinal: 0 }] })).toBe(false);
    expect(validInput({ ...rec, expectedHeads: [] })).toBe(false);
    expect(validInput({ ...rec, expectedHeads: ['x', 'x'] })).toBe(false);
    expect(validInput({ ...rec, operation: 'record' })).toBe(false); // H5
    expect(validInput({ ...base, expectedHeads: ['x'] })).toBe(false); // reconcile-only field on a write
    expect(validInput({ ...base, survivor: 'x' })).toBe(false);
    for (const rv of [undefined, 1, 2]) {
      const v = rv ? { ...cp(), resultVersion: rv } : { ...cp(), resultVersion: undefined };
      delete (v as any).resultVersion; if (rv) (v as any).resultVersion = rv;
      expect(validInput({ ...v, operation: 'write' }), `rv ${rv}`).toBe(false);
      expect(validInput({ ...v, acknowledgeRetired: true }), `rv ${rv}`).toBe(false);
      expect(validInput({ ...v, expectedHeads: ['x'] }), `rv ${rv}`).toBe(false);
    }
  });

  it('fingerprint: permuted expectedHeads/rejectLineages are identical; v3 ≠ v2; operation write is not bound; reconcile params are', () => {
    const envelope = { scopeKey: SCOPE, state: state('x'), events: [], factChanges: [], loopChanges: [], evidenceRefs: [] };
    const base = { canonicalAgentId: 'a', scopeKey: SCOPE, expectedRevision: 2, resolvedParentStateId: 'S', envelope };
    const v2 = requestFingerprint({ ...base, resultVersion: 2 });
    const v3 = requestFingerprint({ ...base, resultVersion: 3 });
    expect(v3).not.toBe(v2);
    expect(requestFingerprint({ ...base, resultVersion: 3, operation: 'write' })).toBe(v3);
    const rec = (heads: string[], lineages: string[]) => requestFingerprint({
      ...base, resultVersion: 3, operation: 'reconcile',
      reconcile: { expectedHeads: [...heads].sort(), expectedPointer: 'S', survivor: 'S', reason: 'r', strict: true, resolutions: [], rejectLineages: [...lineages].sort() },
    });
    expect(rec(['S', 'C', 'D'], ['C', 'D'])).toBe(rec(['D', 'S', 'C'], ['D', 'C']));
    expect(rec(['S', 'C'], ['C'])).not.toBe(v3);
    expect(rec(['S', 'C'], ['C'])).not.toBe(rec(['S', 'C'], []));
  });

  it('output: v3 written/replay carry `reconciled`; v3 conflict carries `pointer`; v1/v2 shapes untouched; every runtime result validates', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const written = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId });
    expect(written.outcome).toBe('written');
    expect(Object.keys(written).sort()).toEqual(['changes', 'contentHash', 'outcome', 'parentStateId', 'reconciled', 'revision', 'scopeKey', 'stateId']);
    expect(validResult(written), ajv.errorsText(validResult.errors)).toBe(true);
    expect(() => validateEng4Output('checkpoint', written)).not.toThrow();
    const { reconciled: _r, ...asV2 } = written;
    expect(validResult(asV2)).toBe(true); // the v2/v3-write shape
    // v1 conflict has no pointer; v3 conflict has one.
    const v1c = write(db, { resultVersion: 1, expectedRevision: null });
    expect(Object.keys(v1c).sort()).toEqual(['heads', 'outcome']);
    const v3c = write(db, { resultVersion: 3, expectedRevision: null });
    expect(Object.keys(v3c).sort()).toEqual(['heads', 'outcome', 'pointer']);
    expect(v3c.pointer).toBe(written.stateId);
    for (const r of [v1c, v3c]) expect(validResult(r), ajv.errorsText(validResult.errors)).toBe(true);
    expect(validResult({ ...v1c, extra: 1 })).toBe(false);
    expect(validResult({ ...v1c, pointer: null })).toBe(true); // = the v3 conflict shape; exact objects, one branch each
  });
});

describe('H3 reconcile — CAS, survivor, retirement, pointer (§4.2 steps 1–5, 7)', () => {
  it('THE BASIC RECONCILE of the A→B/A→C fork: C retired and recorded as merge input, pointer set to the reconcile snapshot (reason reconcile), one live head, counts right, v1 working follows', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const r = reconcile(db, { expectedHeads: [c.stateId, a.stateId], survivor: a.stateId, reason: 'fold the audit branch' });
    expect(r.outcome).toBe('written');
    expect(r.parentStateId).toBe(a.stateId);
    expect(r.reconciled).toEqual({ survivor: a.stateId, retired: [c.stateId], pointer: r.stateId, resolutions: [], adoptedRetired: [], unresolvedDivergent: { facts: 0, loops: 0 } });
    expect(liveIds(db)).toEqual([r.stateId]);
    expect(retirements(db)).toEqual([{ state_id: c.stateId, retired_by_state_id: r.stateId, reason: 'fold the audit branch' }]);
    expect(db.prepare(`SELECT input_state_id FROM eng4_snapshot_merge_inputs WHERE state_id=?`).all(r.stateId)).toEqual([{ input_state_id: c.stateId }]);
    expect(pointerRow(db)).toEqual({ state_id: r.stateId, reason: 'reconcile' });
    expect(readReconciliation(db, TENANT, r.contentHash)).toMatchObject({ expectedHeads: [a.stateId, c.stateId].sort(), survivor: a.stateId, retired: [c.stateId], expectedPointer: a.stateId, strict: true });
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.working.status).toBe('reconciled');
    expect(v3.asOf).toMatchObject({ stateId: r.stateId, selection: 'pointer', liveHeadCount: 1, divergentHeadCount: 0, retiredHeadCount: 1, conflicts: [] });
    expect(v3.asOf.pointer).toMatchObject({ stateId: r.stateId, reason: 'reconcile' });
    expect(v3.heads).toEqual([expect.objectContaining({ stateId: r.stateId, isCurrent: true, parentRetired: false })]);
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
    expect(resume(db).working.status).toBe('reconciled'); // v1 follows the same resolver
    expect(verifyVersionParity(db, TENANT, SCOPE).snapshotsVerified).toBe(4); // the reconcile dual-writes like any write
  });

  it('CAS: a wrong head set or a wrong pointer conflicts, carrying the real heads AND pointer; nothing written', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get() as any;
    const missing = reconcile(db, { expectedHeads: [a.stateId], survivor: a.stateId });
    expect(missing.outcome).toBe('conflict');
    expect(missing.heads.map((h: any) => h.stateId).sort()).toEqual([a.stateId, c.stateId].sort());
    expect(missing.pointer).toBe(a.stateId);
    const extra = reconcile(db, { expectedHeads: [a.stateId, c.stateId, 'ghost'], survivor: a.stateId });
    expect(extra.outcome).toBe('conflict');
    const wrongPointer = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, expectedPointer: c.stateId });
    expect(wrongPointer).toMatchObject({ outcome: 'conflict', pointer: a.stateId });
    const nullPointer = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, expectedPointer: null });
    expect(nullPointer.outcome).toBe('conflict');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual(before);
    expect(retirements(db)).toEqual([]);
    expect(pointerRow(db).state_id).toBe(a.stateId);
  });

  it('survivor must be in expectedHeads and expectedRevision must be its revision; an empty scope cannot be reconciled', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: 'ghost' })).toThrow(CheckpointReconcileError);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, expectedRevision: c.revision })).toThrow(/survivor's revision/);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, reason: '' })).toThrow(CheckpointReconcileError);
    const empty = freshDb();
    expect(() => performCheckpoint(empty, directory, TENANT, cp({ resultVersion: 3, operation: 'reconcile', expectedRevision: null, expectedHeads: ['x'], expectedPointer: null, survivor: 'x', reason: 'r' }))).toThrow(CheckpointEmptyScopeError);
  });

  it('IDEMPOTENCY FIRST: the same key with permuted expectedHeads replays the same reconciled block even though the live set changed; a different survivor is a fingerprint mismatch', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const params = reconcileParams(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, idempotencyKey: 'k-reconcile-1' });
    const first = performCheckpoint(db, directory, TENANT, params) as any;
    const replay = performCheckpoint(db, directory, TENANT, { ...params, expectedHeads: [c.stateId, a.stateId] }) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.stateId).toBe(first.stateId);
    expect(replay.reconciled).toEqual(first.reconciled);
    expect(replay.changes).toEqual(first.changes);
    expect(validResult(replay), ajv.errorsText(validResult.errors)).toBe(true);
    const other = performCheckpoint(db, directory, TENANT, { ...params, survivor: c.stateId, expectedRevision: c.revision }) as any;
    expect(other.outcome).toBe('idempotency-mismatch');
    expect(liveIds(db)).toEqual([first.stateId]);
  });

  it('REPLAY PARITY (§4.3): a missing retirement row or an altered resolution makes the replay throw, never reconstruct', () => {
    const db = freshDb();
    const { a, c } = forkWithFact(db);
    const params = reconcileParams(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId], idempotencyKey: 'k-reconcile-2' });
    const first = performCheckpoint(db, directory, TENANT, params) as any;
    expect(first.reconciled.resolutions).toHaveLength(1);
    bypass(db, () => db.prepare(`DELETE FROM eng4_head_retirements WHERE state_id=?`).run(c.stateId));
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/retirement set differs/);
    const db2 = freshDb();
    const f2 = forkWithFact(db2);
    const p2 = reconcileParams(db2, { expectedHeads: [f2.a.stateId, f2.c.stateId], survivor: f2.a.stateId, rejectLineages: [f2.c.stateId], idempotencyKey: 'k-reconcile-3' });
    performCheckpoint(db2, directory, TENANT, p2);
    bypass(db2, () => db2.prepare(`UPDATE eng4_divergence_resolutions SET decision='accept', accepted_ordinal=0`).run());
    expect(() => performCheckpoint(db2, directory, TENANT, p2)).toThrow(CheckpointIntegrityError);
  });

  it('INVALID DESIGNATION is repaired only by a reconcile that names the broken pointer', () => {
    const db = freshDb();
    const root = write(db);
    const b = write(db, { expectedRevision: 1, state: state('b') });
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    expect(effectiveCurrentHead(db, TENANT, SCOPE).selection).toBe('invalid-designation');
    expect(reconcile(db, { expectedHeads: [b.stateId], survivor: b.stateId, expectedPointer: b.stateId }).outcome).toBe('conflict'); // must name the broken value
    const r = reconcile(db, { expectedHeads: [b.stateId], survivor: b.stateId, expectedPointer: root.stateId });
    expect(r.outcome).toBe('written');
    expect(r.reconciled.retired).toEqual([]);
    expect(effectiveCurrentHead(db, TENANT, SCOPE)).toMatchObject({ selection: 'pointer', head: expect.objectContaining({ stateId: r.stateId }) });
  });

  it('LEGACY 13-HEAD CANARY (§7 row H3): naming all heads and the null pointer → divergentHeadCount 0, retiredHeadCount 12, pointer = reconcile, every retired snapshot still resolves as a resource, replay parity holds', () => {
    const db = freshDb();
    write(db);
    const heads: any[] = [];
    for (let i = 0; i < 13; i++) heads.push(write(db, { expectedRevision: 1, state: state(`h${i}`) }));
    dropPointer(db);
    expect(resume(db, { resultVersion: 3 }).asOf).toMatchObject({ selection: 'max-revision', liveHeadCount: 13 });
    const survivor = heads[12];
    const params = reconcileParams(db, { expectedHeads: heads.map((h) => h.stateId), survivor: survivor.stateId, expectedPointer: null, idempotencyKey: 'k-canary' });
    const r = performCheckpoint(db, directory, TENANT, params) as any;
    expect(r.outcome).toBe('written');
    expect(r.reconciled.retired).toHaveLength(12);
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.asOf).toMatchObject({ stateId: r.stateId, selection: 'pointer', liveHeadCount: 1, divergentHeadCount: 0, retiredHeadCount: 12 });
    expect(v3.asOf.pointer).toMatchObject({ stateId: r.stateId, reason: 'reconcile' });
    for (const h of heads.slice(0, 12)) {
      const fetched = fetchResourceByUri(db, TENANT, `engram://snapshot/${encodeURIComponent(SCOPE)}/${encodeURIComponent(h.stateId)}`) as any;
      expect(fetched.kind).toBe('state-snapshot');
    }
    const replay = performCheckpoint(db, directory, TENANT, params) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.reconciled).toEqual(r.reconciled);
  });
});

describe('H3 causal divergence resolution (§6.3)', () => {
  it('STRICT (default) refuses while a materialized divergent terminal is unresolved, listing it; nothing is written', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    let err: any;
    try { reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CheckpointReconcileError);
    expect(err.unresolved).toEqual([{ kind: 'fact', id: F, divergentStateId: c.stateId, reason: 'unresolved divergent terminal under strict' }]);
    expect(liveIds(db).sort()).toEqual([a.stateId, c.stateId].sort());
    expect(retirements(db)).toEqual([]);
  });

  it('strict:false commits with the audited escape hatch: unresolvedDivergent counts it, no resolution row, value stays divergent for a later reconcile', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, strict: false });
    expect(r.reconciled).toMatchObject({ retired: [c.stateId], resolutions: [], unresolvedDivergent: { facts: 1, loops: 0 } });
    expect(readReconciliation(db, TENANT, r.contentHash)).toMatchObject({ strict: false, unresolvedDivergent: { facts: 1, loops: 0 } });
    // A LATER reconcile (single head, previously retired C still divergent) must still resolve F@C.
    expect(() => reconcile(db, { expectedHeads: [r.stateId], survivor: r.stateId })).toThrow(/unresolved divergent terminal/);
    const r2 = reconcile(db, { expectedHeads: [r.stateId], survivor: r.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
    expect(r2.reconciled.resolutions).toEqual([{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject', acceptedOrdinal: null }]);
    // And a third reconcile sees nothing left to resolve.
    expect(reconcile(db, { expectedHeads: [r2.stateId], survivor: r2.stateId }).reconciled.resolutions).toEqual([]);
  });

  it('REJECT records a payload-bound resolution; the accepted lineage\'s value stands', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
    expect(r.reconciled.resolutions).toEqual([{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject', acceptedOrdinal: null }]);
    expect(resolutionRows(db)).toEqual([{ kind: 'fact', change_id: F, divergent_state_id: c.stateId, resolved_by_state_id: r.stateId, decision: 'reject', accepted_ordinal: null }]);
    expect(readReconciliation(db, TENANT, r.contentHash)!.resolutions).toEqual(r.reconciled.resolutions);
  });

  it('ACCEPT is bound to a same-request change whose comparable value EQUALS the divergent terminal (facts and loops); every mismatch is a typed error', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const target = { kind: 'fact' as const, id: F, divergentStateId: c.stateId, decision: 'accept' as const, acceptedOrdinal: 0 };
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [target] })).toThrow(/does not contain/);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [target], factChanges: [fact('bad-ish', { factId: F })] })).toThrow(/does not equal/);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [target], factChanges: [fact('bad')] })).toThrow(/which changes/); // creates a new fact, not F
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [target], factChanges: [fact('bad', { factId: F })] });
    expect(r.reconciled.resolutions).toEqual([{ ...target, acceptedOrdinal: 0 }]);
    expect(db.prepare(`SELECT subject FROM eng4_fact_versions WHERE state_id=? AND fact_id=?`).get(r.stateId, F)).toEqual({ subject: 'bad' });
    expect(resolutionRows(db)[0]).toMatchObject({ decision: 'accept', accepted_ordinal: 0 });
    // Loops: a close written on the divergent branch; accept with an equal close (timestamps excluded from comparison).
    const db2 = freshDb();
    const root = write(db2, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'o' }] });
    const L = root.changes.loops[0].loopId;
    const a2 = write(db2, { expectedRevision: 1, state: state('a') });
    const c2 = write(db2, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'closed', nextAction: 'done', closeOutcome: 'shipped' }] });
    const lt = { kind: 'loop' as const, id: L, divergentStateId: c2.stateId, decision: 'accept' as const, acceptedOrdinal: 0 };
    expect(() => reconcile(db2, { expectedHeads: [a2.stateId, c2.stateId], survivor: a2.stateId })).toThrow(/loop .*unresolved divergent terminal/);
    expect(() => reconcile(db2, { expectedHeads: [a2.stateId, c2.stateId], survivor: a2.stateId, resolutions: [lt], loopChanges: [{ loopId: L, status: 'closed', nextAction: 'done', closeOutcome: 'different' }] })).toThrow(/does not equal/);
    const r2 = reconcile(db2, { expectedHeads: [a2.stateId, c2.stateId], survivor: a2.stateId, resolutions: [lt], loopChanges: [{ loopId: L, status: 'closed', nextAction: 'done', closeOutcome: 'shipped' }] });
    expect(r2.reconciled.resolutions).toEqual([lt]);
  });

  it('REVISION NEVER DECIDES: S good@higher / R bad@lower AND S good@lower / R bad@higher both leave bad unresolved', () => {
    // Case 1: the divergent write has the LOWER revision.
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] }); // rev 2, branch (pointer stayed? root is pointer; c extends root → pointer advances to c!)
    // c extended the pointed head, so it became current; make the survivor a *different* branch from root with a higher revision.
    const s = write(db, { expectedRevision: 1, state: state('s'), factChanges: [fact('good', { factId: F })] }); // rev 3, divergent from c
    expect(s.revision).toBeGreaterThan(c.revision);
    expect(() => reconcile(db, { expectedHeads: [c.stateId, s.stateId], survivor: s.stateId })).toThrow(/unresolved divergent terminal/);
    // Case 2 (the §6.3 attack): the divergent write has the HIGHER revision.
    const db2 = freshDb();
    const f = forkWithFact(db2); // c (bad) has the higher revision than a (survivor)
    expect(f.c.revision).toBeGreaterThan(f.a.revision);
    expect(() => reconcile(db2, { expectedHeads: [f.a.stateId, f.c.stateId], survivor: f.a.stateId })).toThrow(/unresolved divergent terminal/);
    // In both, a reject settles it and the survivor's lineage carries no bad value.
    const r = reconcile(db2, { expectedHeads: [f.a.stateId, f.c.stateId], survivor: f.a.stateId, rejectLineages: [f.c.stateId] });
    expect(r.reconciled.resolutions).toEqual([{ kind: 'fact', id: f.F, divergentStateId: f.c.stateId, decision: 'reject', acceptedOrdinal: null }]);
  });

  it('rejectLineages expands deterministically to per-terminal rejects; overlaps, the survivor, and non-heads are refused', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('g1'), fact('g2')], loopChanges: [{ status: 'open', nextAction: 'n' }] });
    const [F1, F2] = root.changes.facts.map((f: any) => f.factId);
    const L = root.changes.loops[0].loopId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c1 = write(db, { expectedRevision: 1, state: state('c1'), factChanges: [fact('b1', { factId: F1 })] });
    const c2 = write(db, { expectedRevision: c1.revision, state: state('c2'), factChanges: [fact('b2', { factId: F2 }), fact('b1-again', { factId: F1 })], loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] });
    const heads = [a.stateId, c2.stateId];
    const r = reconcile(db, { expectedHeads: heads, survivor: a.stateId, rejectLineages: [c2.stateId] });
    // Terminals on the c1→c2 chain: F1 @ c2 (newest, not @ c1), F2 @ c2, L @ c2.
    expect(r.reconciled.resolutions).toEqual([
      { kind: 'fact', id: F1, divergentStateId: c2.stateId, decision: 'reject', acceptedOrdinal: null },
      { kind: 'fact', id: F2, divergentStateId: c2.stateId, decision: 'reject', acceptedOrdinal: null },
      { kind: 'loop', id: L, divergentStateId: c2.stateId, decision: 'reject', acceptedOrdinal: null },
    ].sort((x, y) => (x.kind + x.id < y.kind + y.id ? -1 : 1))); // UTF-16 code-unit order, as the implementation sorts
    const db2 = freshDb();
    const f = forkWithFact(db2);
    const H = [f.a.stateId, f.c.stateId];
    expect(() => reconcile(db2, { expectedHeads: H, survivor: f.a.stateId, rejectLineages: [f.c.stateId], resolutions: [{ kind: 'fact', id: f.F, divergentStateId: f.c.stateId, decision: 'reject' }] })).toThrow(/overlaps/);
    expect(() => reconcile(db2, { expectedHeads: H, survivor: f.a.stateId, rejectLineages: [f.c.stateId], resolutions: [{ kind: 'fact', id: f.F, divergentStateId: f.c.stateId, decision: 'accept', acceptedOrdinal: 0 }], factChanges: [fact('bad', { factId: f.F })] })).toThrow(/overlaps/);
    expect(() => reconcile(db2, { expectedHeads: H, survivor: f.a.stateId, rejectLineages: [f.a.stateId] })).toThrow(/survivor/);
    expect(() => reconcile(db2, { expectedHeads: H, survivor: f.a.stateId, rejectLineages: ['ghost'] })).toThrow(/not a divergent head/);
    expect(() => reconcile(db2, { expectedHeads: H, survivor: f.a.stateId, resolutions: [{ kind: 'fact', id: 'nope', divergentStateId: f.c.stateId, decision: 'reject' }] })).toThrow(/not an unresolved divergent terminal/);
  });

  it('OPAQUE TERMINALS (unversioned coverage) can only be rejected — accept is refused and they may not remain unresolved even under strict:false', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] }); // owner omitted
    // Make the creation unknowable history and rebuild the version foundation → C's tuple is unversioned.
    bypass(db, () => {
      db.exec(`DELETE FROM eng4_version_coverage; DELETE FROM eng4_fact_versions; DELETE FROM eng4_loop_versions; DELETE FROM eng4_version_backfills; DELETE FROM eng4_version_cutover;`);
      db.prepare(`DELETE FROM eng4_snapshot_changes WHERE state_id=?`).run(root.stateId);
      db.prepare(`UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE state_id=?`).run(root.stateId);
    });
    applyEng4Schema(db);
    expect(db.prepare(`SELECT disposition FROM eng4_version_coverage WHERE state_id=?`).get(c.stateId)).toEqual({ disposition: 'unversioned' });
    const H = [a.stateId, c.stateId];
    expect(() => reconcile(db, { expectedHeads: H, survivor: a.stateId })).toThrow(/opaque terminal/);
    expect(() => reconcile(db, { expectedHeads: H, survivor: a.stateId, strict: false })).toThrow(/opaque terminal/);
    expect(() => reconcile(db, { expectedHeads: H, survivor: a.stateId, resolutions: [{ kind: 'loop', id: L, divergentStateId: c.stateId, decision: 'accept', acceptedOrdinal: 0 }], loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] })).toThrow(/can only be rejected/);
    const r = reconcile(db, { expectedHeads: H, survivor: a.stateId, resolutions: [{ kind: 'loop', id: L, divergentStateId: c.stateId, decision: 'reject' }] });
    expect(r.reconciled.resolutions).toEqual([{ kind: 'loop', id: L, divergentStateId: c.stateId, decision: 'reject', acceptedOrdinal: null }]);
  });

  it('a divergent value that EQUALS the accepted one still needs a resolution (divergence is causal, not value-based)', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('same')] });
    const F = root.changes.facts[0].factId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('same', { factId: F })] });
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId })).toThrow(/unresolved divergent terminal/);
    expect(reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] }).outcome).toBe('written');
  });
});

describe('H3 resurrection and retired heads (§4.4, §4.5)', () => {
  it('a v1 write extending a retired head is a live head that is never current (heads.parentRetired: true); under v3 it needs acknowledgeRetired; the pointer never moves', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId });
    const v1 = write(db, { resultVersion: 1, expectedRevision: c.revision, state: state('resurrected') });
    expect(v1.outcome).toBe('written');
    expect(pointerRow(db).state_id).toBe(r.stateId);
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.asOf).toMatchObject({ stateId: r.stateId, liveHeadCount: 2, divergentHeadCount: 1, retiredHeadCount: 1 });
    expect(v3.heads).toEqual([
      expect.objectContaining({ stateId: r.stateId, isCurrent: true, parentRetired: false }),
      expect.objectContaining({ stateId: v1.stateId, isCurrent: false, parentRetired: true }),
    ]);
    expect(() => write(db, { resultVersion: 3, expectedRevision: c.revision, state: state('again') })).toThrow(CheckpointRetiredParentError);
    const acked = write(db, { resultVersion: 3, expectedRevision: c.revision, state: state('again'), acknowledgeRetired: true });
    expect(acked.outcome).toBe('written');
    expect(pointerRow(db).state_id).toBe(r.stateId);
    expect(write(db, { resultVersion: 3, expectedRevision: r.revision, state: state('fine'), acknowledgeRetired: true }).outcome).toBe('written'); // harmless on a live parent
  });

  it('retired heads are excluded from liveHeads and from conflicts, but their state is still fetchable and changesSince-visible by revision', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId });
    const conflict = write(db, { expectedRevision: null });
    expect(conflict.heads.map((h: any) => h.stateId)).not.toContain(c.stateId);
    expect(fetchResourceByUri(db, TENANT, `engram://snapshot/${encodeURIComponent(SCOPE)}/${encodeURIComponent(c.stateId)}`).kind).toBe('state-snapshot');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots WHERE state_id=?`).get(c.stateId)).toEqual({ n: 1 }); // never deleted
  });
});

describe('H3 resume v3 — resolution rows verified against payloads on the accepted lineage (§4.3)', () => {
  it('an extra out-of-band resolution row attributed to a reconcile on the lineage, or a missing one, fails the v3 resume closed; v1/v2 are untouched; off-lineage rows do not count', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const r = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'reject' }] });
    expect(resume(db, { resultVersion: 3 }).asOf.stateId).toBe(r.stateId);
    // Extra row: claims a second resolution by the reconcile.
    bypass(db, () => db.prepare(`INSERT INTO eng4_divergence_resolutions VALUES (?, ?, 'fact', 'other', ?, ?, 'reject', NULL)`).run(TENANT, SCOPE, c.stateId, r.stateId));
    expect(() => resume(db, { resultVersion: 3 })).toThrow(/resolution rows differ/);
    expect(resume(db).working.status).toBe('reconciled');
    expect(resume(db, { resultVersion: 2 }).working.status).toBe('reconciled');
    bypass(db, () => db.prepare(`DELETE FROM eng4_divergence_resolutions WHERE change_id='other'`).run());
    expect(resume(db, { resultVersion: 3 }).asOf.stateId).toBe(r.stateId);
    // Off-lineage row: attributed to the retired snapshot C — not on the accepted lineage, ignored.
    bypass(db, () => db.prepare(`INSERT INTO eng4_divergence_resolutions VALUES (?, ?, 'fact', 'other', ?, ?, 'reject', NULL)`).run(TENANT, SCOPE, a.stateId, c.stateId));
    expect(resume(db, { resultVersion: 3 }).asOf.stateId).toBe(r.stateId);
    // Missing row.
    bypass(db, () => db.prepare(`DELETE FROM eng4_divergence_resolutions WHERE resolved_by_state_id=?`).run(r.stateId));
    expect(() => resume(db, { resultVersion: 3 })).toThrow(/resolution rows differ/);
    // An ordinary snapshot carrying reconcile rows is corruption too.
    const db2 = freshDb();
    const f2 = attack(db2);
    bypass(db2, () => db2.prepare(`INSERT INTO eng4_head_retirements VALUES (?, ?, ?, ?, 't', 'x', 'r')`).run(TENANT, SCOPE, f2.c.stateId, f2.a.stateId));
    expect(() => resume(db2, { resultVersion: 3 })).toThrow(/does not record retiring it|records no reconciliation/); // both fail closed; attribution is checked first
  });

  it('after a reconcile the version foundation verifier and the resume resolution verifier both pass; a second reconcile chains on the first', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const r1 = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    const d = write(db, { expectedRevision: r1.revision, state: state('d') }); // advances
    const e = write(db, { expectedRevision: r1.revision, state: state('e'), factChanges: [fact('e-val', { factId: F })] }); // divergent from d
    const r2 = reconcile(db, { expectedHeads: [d.stateId, e.stateId], survivor: d.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: e.stateId, decision: 'accept', acceptedOrdinal: 0 }], factChanges: [fact('e-val', { factId: F })] });
    expect(r2.outcome).toBe('written');
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.asOf).toMatchObject({ stateId: r2.stateId, liveHeadCount: 1, retiredHeadCount: 2 });
    expect(verifyVersionParity(db, TENANT, SCOPE).snapshotsVerified).toBe(7);
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
  });
});

describe('H3 independent review round 1 — fail-closed evidence, sequential owners, amendments, re-adoption, hidden heads', () => {
  it('FINDING 1: a ledger tuple without a coverage row on a divergent chain is corruption — reconcile refuses instead of missing the terminal', () => {
    const db = freshDb();
    const { a, c } = forkWithFact(db);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId })).toThrow(CheckpointReconcileError); // healthy: refused for the divergent value
    bypass(db, () => db.prepare(`DELETE FROM eng4_version_coverage WHERE state_id=?`).run(c.stateId));
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId })).toThrow(CheckpointIntegrityError);
    expect(() => reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, strict: false })).toThrow(CheckpointIntegrityError);
    expect(retirements(db)).toEqual([]);
    expect(liveIds(db)).toHaveLength(2);
  });

  it('FINDING 2: an accept compares against the owner the dual write will record — sequential same-loop changes in one request', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] }); // terminal owner orig
    const H = [a.stateId, c.stateId];
    const acc = { kind: 'loop' as const, id: L, divergentStateId: c.stateId, decision: 'accept' as const, acceptedOrdinal: 1 };
    // Ordinal 0 changes the owner; ordinal 1 (omitted owner) therefore records 'someone-else' — not equal to the terminal.
    expect(() => reconcile(db, { expectedHeads: H, survivor: a.stateId, resolutions: [acc], loopChanges: [{ loopId: L, status: 'open', nextAction: 'n', owner: 'someone-else' }, { loopId: L, status: 'blocked', nextAction: 'x' }] })).toThrow(/does not equal/);
    // With the owner chain preserved, the accept is valid, commits, replays and verifies.
    const params = reconcileParams(db, { expectedHeads: H, survivor: a.stateId, resolutions: [acc], loopChanges: [{ loopId: L, status: 'open', nextAction: 'n', owner: 'orig' }, { loopId: L, status: 'blocked', nextAction: 'x' }], idempotencyKey: 'k-seq-owner' });
    const r = performCheckpoint(db, directory, TENANT, params) as any;
    expect(r.outcome).toBe('written');
    expect(db.prepare(`SELECT owner FROM eng4_loop_versions WHERE state_id=? AND ordinal=1`).get(r.stateId)).toEqual({ owner: 'orig' });
    expect((performCheckpoint(db, directory, TENANT, params) as any).outcome).toBe('idempotent-replay');
    expect(resume(db, { resultVersion: 3 }).asOf.stateId).toBe(r.stateId);
  });

  it('FINDING 3: accept must name the FINAL change for that id in the request ("accept with amendment" is reject + a fresh change)', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const H = [a.stateId, c.stateId];
    expect(() => reconcile(db, { expectedHeads: H, survivor: a.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'accept', acceptedOrdinal: 0 }], factChanges: [fact('bad', { factId: F }), fact('amended', { factId: F })] })).toThrow(/must name the final change/);
    const r = reconcile(db, { expectedHeads: H, survivor: a.stateId, resolutions: [{ kind: 'fact', id: F, divergentStateId: c.stateId, decision: 'accept', acceptedOrdinal: 1 }], factChanges: [fact('interim', { factId: F }), fact('bad', { factId: F })] });
    expect(r.reconciled.resolutions[0]).toMatchObject({ decision: 'accept', acceptedOrdinal: 1 });
    // The amendment path the design prescribes:
    const db2 = freshDb();
    const f = forkWithFact(db2);
    const r2 = reconcile(db2, { expectedHeads: [f.a.stateId, f.c.stateId], survivor: f.a.stateId, resolutions: [{ kind: 'fact', id: f.F, divergentStateId: f.c.stateId, decision: 'reject' }], factChanges: [fact('amended', { factId: f.F })] });
    expect(r2.outcome).toBe('written');
  });

  it('FINDING 4: a resurrected survivor re-adopts retired history — refused without acknowledgeRetired, recorded as adoptedRetired with it', () => {
    const db = freshDb();
    const { a, c, F } = forkWithFact(db);
    const r1 = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    const d = write(db, { resultVersion: 3, expectedRevision: c.revision, state: state('d'), acknowledgeRetired: true }); // resurrection of C
    expect(() => reconcile(db, { expectedHeads: [r1.stateId, d.stateId], survivor: d.stateId })).toThrow(/re-adopting them requires acknowledgeRetired/);
    const params = reconcileParams(db, { expectedHeads: [r1.stateId, d.stateId], survivor: d.stateId, acknowledgeRetired: true, idempotencyKey: 'k-readopt' });
    const r2 = performCheckpoint(db, directory, TENANT, params) as any;
    expect(r2.outcome).toBe('written');
    expect(r2.reconciled.adoptedRetired).toEqual([c.stateId]);
    expect(readReconciliation(db, TENANT, r2.contentHash)!.adoptedRetired).toEqual([c.stateId]);
    // R1 is now off-lineage; its rejection of F@C no longer governs, and the record shows why.
    expect((performCheckpoint(db, directory, TENANT, params) as any).reconciled).toEqual(r2.reconciled);
    expect(resume(db, { resultVersion: 3 }).asOf).toMatchObject({ stateId: r2.stateId, retiredHeadCount: 2 });
    // acknowledgeRetired changes intent → a different fingerprint under the same key.
    expect((performCheckpoint(db, directory, TENANT, { ...params, acknowledgeRetired: false }) as any).outcome).toBe('idempotency-mismatch');
    void F;
  });

  it('FINDING 6: a retirement row not recorded by its attributed snapshot\'s payload cannot hide a live head — v3 resume and reconcile refuse; v1 is unchanged', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    bypass(db, () => db.prepare(`INSERT INTO eng4_head_retirements VALUES (?, ?, ?, ?, 't', 'x', 'r')`).run(TENANT, SCOPE, c.stateId, c.stateId));
    expect(liveIds(db)).toEqual([a.stateId]); // the raw query alone would hide C…
    expect(() => resume(db, { resultVersion: 3 })).toThrow(/does not record retiring it/); // …but v3 refuses
    expect(() => verifyRetirementAttribution(db, TENANT, SCOPE)).toThrow(CheckpointIntegrityError);
    expect(() => reconcile(db, { expectedHeads: [a.stateId], survivor: a.stateId })).toThrow(CheckpointIntegrityError);
    expect(resume(db).working.status).toBe('a');
    // Attributed to a REAL reconcile that did not retire it: still refused.
    const db2 = freshDb();
    const f = attack(db2);
    const r = reconcile(db2, { expectedHeads: [f.a.stateId, f.c.stateId], survivor: f.a.stateId });
    const e = write(db2, { expectedRevision: f.c.revision, state: state('e') }); // resurrection, live
    bypass(db2, () => db2.prepare(`INSERT INTO eng4_head_retirements VALUES (?, ?, ?, ?, 't', 'x', 'r')`).run(TENANT, SCOPE, e.stateId, r.stateId));
    expect(() => resume(db2, { resultVersion: 3 })).toThrow(/does not record retiring it/);
  });

  it('shared prefix: two divergent heads on one branch — each chain has its own terminals; rejecting one lineage leaves the other\'s owed', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('f0'), fact('g0')] });
    const [F, G] = root.changes.facts.map((f: any) => f.factId);
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const x = write(db, { expectedRevision: 1, state: state('x'), factChanges: [fact('fx', { factId: F })] });
    const c1 = write(db, { expectedRevision: x.revision, state: state('c1'), factChanges: [fact('fc1', { factId: F })] });
    const c2 = write(db, { expectedRevision: x.revision, state: state('c2'), factChanges: [fact('gc2', { factId: G })] });
    const H = [a.stateId, c1.stateId, c2.stateId];
    let err: any;
    try { reconcile(db, { expectedHeads: H, survivor: a.stateId, rejectLineages: [c1.stateId] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CheckpointReconcileError);
    // A lineage is the head's chain from its fork point: chain(C1) = {C1, X}, so rejecting C1 also
    // rejects the shared F@X (chain C2's terminal for F). Only G@C2 remains owed.
    expect(err.unresolved.map((u: any) => [u.id, u.divergentStateId])).toEqual([[G, c2.stateId]]);
    const r = reconcile(db, { expectedHeads: H, survivor: a.stateId, rejectLineages: [c1.stateId, c2.stateId] });
    expect(r.reconciled.resolutions.map((x: any) => [x.id, x.divergentStateId]).sort()).toEqual([[F, c1.stateId], [F, x.stateId], [G, c2.stateId]].sort());
    expect(r.reconciled.retired.sort()).toEqual([c1.stateId, c2.stateId].sort());
  });

  it('one request may accept one terminal and reject a whole other lineage; a reconcile may also create NEW facts; loop count under strict:false', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('f0')], loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const F = root.changes.facts[0].factId;
    const L = root.changes.loops[0].loopId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('fc', { factId: F })] });
    const d = write(db, { expectedRevision: 1, state: state('d'), loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'x' }] }); // owner omitted → materialized owner orig
    const H = [a.stateId, c.stateId, d.stateId];
    const soft = reconcile(db, { expectedHeads: H, survivor: a.stateId, strict: false, rejectLineages: [c.stateId] });
    expect(soft.reconciled.unresolvedDivergent).toEqual({ facts: 0, loops: 1 });
    // Fresh store, same shape: accept the loop terminal (owner omitted, in-place chain) and reject C's lineage, while creating a new fact.
    const db2 = freshDb();
    const root2 = write(db2, { factChanges: [fact('f0')], loopChanges: [{ status: 'open', nextAction: 'n', owner: 'orig' }] });
    const F2 = root2.changes.facts[0].factId; const L2 = root2.changes.loops[0].loopId;
    const a2 = write(db2, { expectedRevision: 1, state: state('a') });
    const c2 = write(db2, { expectedRevision: 1, state: state('c'), factChanges: [fact('fc', { factId: F2 })] });
    const d2 = write(db2, { expectedRevision: 1, state: state('d'), loopChanges: [{ loopId: L2, status: 'blocked', nextAction: 'x' }] });
    const r = reconcile(db2, {
      expectedHeads: [a2.stateId, c2.stateId, d2.stateId], survivor: a2.stateId, rejectLineages: [c2.stateId],
      resolutions: [{ kind: 'loop', id: L2, divergentStateId: d2.stateId, decision: 'accept', acceptedOrdinal: 0 }],
      loopChanges: [{ loopId: L2, status: 'blocked', nextAction: 'x' }],
      factChanges: [fact('brand-new')],
    });
    expect(r.outcome).toBe('written');
    expect(r.changes.facts[0].created).toBe(true);
    expect(r.reconciled.resolutions).toEqual([
      { kind: 'fact', id: F2, divergentStateId: c2.stateId, decision: 'reject', acceptedOrdinal: null },
      { kind: 'loop', id: L2, divergentStateId: d2.stateId, decision: 'accept', acceptedOrdinal: 0 },
    ]);
    expect(verifyVersionParity(db2, TENANT, SCOPE).unversioned).toBe(0);
    expect(resume(db2, { resultVersion: 3 }).asOf.stateId).toBe(r.stateId);
  });

  it('resume verification covers every reconcile on the accepted lineage (two chained reconciles → 2 verified)', () => {
    const db = freshDb();
    const { a, c } = forkWithFact(db);
    const r1 = reconcile(db, { expectedHeads: [a.stateId, c.stateId], survivor: a.stateId, rejectLineages: [c.stateId] });
    const d = write(db, { expectedRevision: r1.revision, state: state('d') });
    const e = write(db, { expectedRevision: r1.revision, state: state('e') });
    const r2 = reconcile(db, { expectedHeads: [d.stateId, e.stateId], survivor: d.stateId });
    expect(verifyResolutionRowsOnLineage(db, TENANT, SCOPE, r2.stateId)).toEqual({ reconcilesVerified: 2 });
    expect(verifyRetirementAttribution(db, TENANT, SCOPE)).toEqual({ retirementsVerified: 2 });
  });
});
