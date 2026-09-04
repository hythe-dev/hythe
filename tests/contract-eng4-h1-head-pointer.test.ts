/**
 * ENG-4 H1 — the advancing current-head pointer, the ONE resolver, snapshot
 * immutability, and resume v3 `asOf` + `heads` (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §3 and §7 row H1, merged 3429000;
 * internal increment of resultVersion 3 — not public until H5).
 *
 * THE DEFECT: resume picked the max-revision live head as current, so a
 * writer extending an OLDER parent produced a higher revision and silently
 * became "current" (four displacements on hythe-rehydration-loop, 2026-09-03).
 *
 * CONTRACT
 * - eng4_scope_current is a POINTER to the current head itself, same-scope by
 *   composite FK. First write in a scope sets it ('first-write'); a write
 *   whose parent IS the pointed head advances it ('advance'); any other
 *   parent writes a branch that is live but NOT current. Unconditional on
 *   result version (a v1 write on the pointed head advances it too).
 * - A→B / A→C: pointer at A; A→B moves it to B; a later stale A→C leaves it
 *   at B. C has the higher revision and is NOT current. Revision never
 *   decides once a pointer exists.
 * - effectiveCurrentHead is the single definition of "current" for EVERY
 *   bundle version: 'pointer' | 'max-revision' (legacy undesignated scopes
 *   only) | 'empty-scope' | 'invalid-designation' (fail closed: working null,
 *   never a fallback to max revision).
 * - Snapshots are immutable: every UPDATE except the single PR #8 digest
 *   write (changes_hash NULL → NOT NULL, all else identical) and every DELETE
 *   are rejected by trigger. The trigger's column list equals the table's.
 * - v1/v2 bundle SHAPES are unchanged. resultVersion:3 → schemaVersion 3:
 *   asOf gains fixed-size selection/pointer/liveHeadCount/divergentHeadCount/
 *   retiredHeadCount; `heads` is a BUDGETED section right after capsule with
 *   closed coverage and a cursor; parentRetired is required and always false
 *   under H1.
 * - v1/v2 requests carrying H-series fields fail input validation; checkpoint
 *   does not yet accept resultVersion 3 (its v3 request arrives with H3/H5).
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, WorkingState } from '../src/unified-server/eng4/contracts.js';
import {
  RESUME_INPUT_SCHEMA,
  RESUME_OUTPUT_SCHEMA,
  RESUME_OUTPUT_SCHEMA_V1,
  RESUME_OUTPUT_SCHEMA_V2,
  RESUME_OUTPUT_SCHEMA_V3,
  CHECKPOINT_INPUT_SCHEMA,
} from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointChangeError } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { effectiveCurrentHead, liveHeads, readScopePointer } from '../src/unified-server/eng4/heads.js';
import { validateEng4Output } from '../src/unified-server/eng4/register.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validResumeInput = ajv.compile(RESUME_INPUT_SCHEMA as any);
const validCheckpointInput = ajv.compile(CHECKPOINT_INPUT_SCHEMA as any);
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);
const validV1 = ajv.compile(RESUME_OUTPUT_SCHEMA_V1 as any);
const validV2 = ajv.compile(RESUME_OUTPUT_SCHEMA_V2 as any);
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

const state = (status: string): WorkingState => ({
  objective: 'H1', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [],
});
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe',
  scope: { project: 'Proj' },
  expectedRevision: null,
  idempotencyKey: 'k-root-0001',
  state: state('root'),
  ...over,
});
const write = (db: any, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, cp(over)) as any;
const resume = (db: any, over: Record<string, unknown> = {}) =>
  performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 4000, ...over } as any) as any;
const pointerRow = (db: any) =>
  db.prepare(`SELECT state_id, advanced_at, advanced_by, reason FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).get(TENANT, SCOPE) as any;
const snapshotRow = (db: any, stateId: string) =>
  db.prepare(`SELECT * FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, stateId) as any;
const dropPointer = (db: any) => db.prepare(`DELETE FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE);

/** root → a (advances) → stale root → c (branches). Returns the three writes. */
const attack = (db: any) => {
  const root = write(db);
  const a = write(db, { expectedRevision: 1, idempotencyKey: 'k-a-000001', state: state('a') });
  const c = write(db, { expectedRevision: 1, idempotencyKey: 'k-c-000001', state: state('c') });
  return { root, a, c };
};

const V1_ASOF_KEYS = ['assembledAt', 'conflicts', 'revision', 'stale', 'stateAgeSec', 'stateId'];
const V3_ASOF_KEYS = [...V1_ASOF_KEYS, 'divergentHeadCount', 'liveHeadCount', 'pointer', 'retiredHeadCount', 'selection'].sort();

// ---------------------------------------------------------------------------

describe('H1 DDL — structural prerequisites (§3.1, §3.2)', () => {
  it('unique index (tenant_id, scope_key, state_id), both triggers, and eng4_scope_current exist; apply is idempotent', () => {
    const db = freshDb();
    const names = (type: string) =>
      db.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name LIKE 'eng4_%' OR type=? AND name LIKE '%eng4_snapshots%'`).all(type, type).map((r: any) => r.name);
    expect(names('index')).toContain('idx_eng4_snapshots_scope_state');
    const idxCols = db.prepare(`PRAGMA index_info(idx_eng4_snapshots_scope_state)`).all().map((r: any) => r.name);
    expect(idxCols).toEqual(['tenant_id', 'scope_key', 'state_id']);
    expect(db.prepare(`SELECT "unique" AS u FROM pragma_index_list('eng4_state_snapshots') WHERE name='idx_eng4_snapshots_scope_state'`).get()).toEqual({ u: 1 });
    expect(names('trigger')).toEqual(expect.arrayContaining(['trg_eng4_snapshots_immutable', 'trg_eng4_snapshots_no_delete']));
    const cols = db.prepare(`PRAGMA table_info(eng4_scope_current)`).all().map((r: any) => r.name);
    expect(cols).toEqual(['tenant_id', 'scope_key', 'state_id', 'advanced_at', 'advanced_by', 'reason']);
    // Idempotent re-apply: no duplicate objects, no throw.
    applyEng4Schema(db);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='trg_eng4_snapshots_immutable'`).get()).toEqual({ n: 1 });
  });

  it('a pointer can only name a snapshot in the SAME tenant and scope — cross-scope pointer rejected by composite FK', () => {
    const db = freshDb();
    write(db);
    const other = performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'Other' }, idempotencyKey: 'k-other-0001' })) as any;
    expect(other.outcome).toBe('written');
    expect(() =>
      db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(other.stateId, TENANT, SCOPE)
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(`INSERT INTO eng4_scope_current VALUES (?, 'p:u-nope', ?, 't', 'x', 'advance')`).run(TENANT, other.stateId)
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(`UPDATE eng4_scope_current SET state_id='not-a-snapshot' WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE)
    ).toThrow(/FOREIGN KEY/);
  });

  it('reason is constrained to first-write | advance | reconcile', () => {
    const db = freshDb();
    write(db);
    expect(() =>
      db.prepare(`UPDATE eng4_scope_current SET reason='bogus' WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE)
    ).toThrow(/CHECK/);
  });
});

describe('H1 immutability — snapshots are never updated (except the digest write) or deleted (§3.1)', () => {
  it('one UPDATE per column is rejected, including changes_hash once set', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [{ assertion: { subject: 's', predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: [], sourceRefs: [] }] });
    const columns = db.prepare(`PRAGMA table_info(eng4_state_snapshots)`).all() as Array<{ name: string; type: string }>;
    expect(columns.length).toBeGreaterThan(10);
    for (const col of columns) {
      const value = col.type === 'INTEGER' ? 999 : 'tampered';
      expect(() =>
        db.prepare(`UPDATE eng4_state_snapshots SET ${col.name}=? WHERE tenant_id=? AND state_id=?`).run(value, TENANT, w.stateId),
        `column ${col.name}`
      ).toThrow(/snapshots are immutable/);
    }
    // Setting the digest back to NULL is also an illegal transition.
    expect(() =>
      db.prepare(`UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`).run(TENANT, w.stateId)
    ).toThrow(/snapshots are immutable/);
    expect(snapshotRow(db, w.stateId).state_json).toBe(JSON.stringify(state('root')));
  });

  it('the single legal transition (changes_hash NULL → NOT NULL, all else identical) succeeds exactly once', () => {
    const db = freshDb();
    write(db);
    // A raw pre-ledger row (as PR #8's writer produces it before its digest step).
    db.prepare(
      `INSERT INTO eng4_state_snapshots
         (tenant_id, state_id, scope_key, revision, parent_state_id, content_hash, request_fingerprint,
          idempotency_key, author, asserted_agent_id, recorded_at, state_json)
       VALUES (?, 'raw-1', ?, 2, NULL, 'h', 'f', 'raw-key-0001', 'a', 'a', '2026-09-03T00:00:00Z', '{}')`
    ).run(TENANT, SCOPE);
    expect(() => db.prepare(`UPDATE eng4_state_snapshots SET changes_hash='d1' WHERE tenant_id=? AND state_id='raw-1'`).run(TENANT)).not.toThrow();
    expect(snapshotRow(db, 'raw-1').changes_hash).toBe('d1');
    // Second digest write, digest+other column, or digest to NULL: rejected.
    expect(() => db.prepare(`UPDATE eng4_state_snapshots SET changes_hash='d2' WHERE tenant_id=? AND state_id='raw-1'`).run(TENANT)).toThrow(/immutable/);
    db.prepare(
      `INSERT INTO eng4_state_snapshots
         (tenant_id, state_id, scope_key, revision, parent_state_id, content_hash, request_fingerprint,
          idempotency_key, author, asserted_agent_id, recorded_at, state_json)
       VALUES (?, 'raw-2', ?, 3, NULL, 'h', 'f', 'raw-key-0002', 'a', 'a', '2026-09-03T00:00:00Z', '{}')`
    ).run(TENANT, SCOPE);
    expect(() =>
      db.prepare(`UPDATE eng4_state_snapshots SET changes_hash='d1', author='b' WHERE tenant_id=? AND state_id='raw-2'`).run(TENANT)
    ).toThrow(/immutable/);
    expect(snapshotRow(db, 'raw-2').changes_hash).toBeNull();
  });

  it('DELETE is rejected', () => {
    const db = freshDb();
    const w = write(db);
    expect(() => db.prepare(`DELETE FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).run(TENANT, w.stateId)).toThrow(/never deleted/);
    expect(() => db.prepare(`DELETE FROM eng4_state_snapshots`).run()).toThrow(/never deleted/);
    expect(snapshotRow(db, w.stateId)).toBeTruthy();
  });

  it('the immutability trigger names EVERY column of eng4_state_snapshots (a new column must extend the trigger in the same PR)', () => {
    const db = freshDb();
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_eng4_snapshots_immutable'`).get() as any).sql as string;
    const named = new Set([...sql.matchAll(/NEW\.(\w+)/g)].map((m) => m[1]));
    const columns = new Set((db.prepare(`PRAGMA table_info(eng4_state_snapshots)`).all() as any[]).map((r) => r.name));
    expect([...named].sort()).toEqual([...columns].sort());
  });

  it('the ledger writer still uses the legal transition: a write with changes gets its digest and replays cleanly', () => {
    const db = freshDb();
    const params = cp({ resultVersion: 2, factChanges: [{ assertion: { subject: 's', predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: [], sourceRefs: [] }] });
    const w = performCheckpoint(db, directory, TENANT, params) as any;
    expect(snapshotRow(db, w.stateId).changes_hash).toMatch(/^[0-9a-f]{64}$/);
    const r = performCheckpoint(db, directory, TENANT, params) as any;
    expect(r.outcome).toBe('idempotent-replay');
    expect(r.changes).toEqual(w.changes);
  });
});

describe('H1 pointer — first write and the advance rule (§3.2a, §3.4)', () => {
  it('the first snapshot in a scope sets the pointer to itself (reason first-write, by the canonical author, at recordedAt)', () => {
    const db = freshDb();
    expect(pointerRow(db)).toBeUndefined();
    const w = write(db);
    const p = pointerRow(db);
    expect(p).toMatchObject({ state_id: w.stateId, reason: 'first-write', advanced_by: 'claude-hythe' });
    expect(p.advanced_at).toBe(snapshotRow(db, w.stateId).recorded_at);
    expect(readScopePointer(db, TENANT, SCOPE)).toMatchObject({ stateId: w.stateId, revision: 1, reason: 'first-write' });
  });

  it('a write whose parent IS the pointed head advances the pointer (reason advance)', () => {
    const db = freshDb();
    write(db);
    const b = write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    expect(pointerRow(db)).toMatchObject({ state_id: b.stateId, reason: 'advance', advanced_by: 'claude-hythe' });
    expect(pointerRow(db).advanced_at).toBe(snapshotRow(db, b.stateId).recorded_at);
  });

  it('THE A→B / A→C ATTACK (89c01374): the stale higher-revision write branches and is NOT current', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    expect(c.outcome).toBe('written');
    expect(c.revision).toBeGreaterThan(a.revision); // C has the higher revision...
    expect(pointerRow(db).state_id).toBe(a.stateId); // ...and the pointer did not move.
    const eff = effectiveCurrentHead(db, TENANT, SCOPE);
    expect(eff.selection).toBe('pointer');
    expect(eff.head?.stateId).toBe(a.stateId);
    expect(eff.live.map((h) => h.stateId)).toEqual([a.stateId, c.stateId]); // revision ASC, both live
    const bundle = resume(db, { resultVersion: 3 });
    expect(bundle.working.status).toBe('a');
    expect(bundle.asOf).toMatchObject({
      stateId: a.stateId, revision: a.revision, stale: false,
      selection: 'pointer', liveHeadCount: 2, divergentHeadCount: 1, retiredHeadCount: 0,
    });
    expect(bundle.asOf.pointer).toMatchObject({ stateId: a.stateId, revision: a.revision, reason: 'advance', advancedBy: 'claude-hythe' });
    expect(bundle.heads).toEqual([
      expect.objectContaining({ stateId: a.stateId, revision: a.revision, isCurrent: true, parentRetired: false }),
      expect.objectContaining({ stateId: c.stateId, revision: c.revision, isCurrent: false, parentRetired: false }),
    ]);
    // v1 meaning of conflicts is unchanged: every live head when forked.
    expect(bundle.asOf.conflicts.map((h: any) => h.stateId).sort()).toEqual([a.stateId, c.stateId].sort());
  });

  it('the ONE resolver governs v1 and v2 too: their working follows the pointer while their shapes stay frozen', () => {
    const db = freshDb();
    const { a } = attack(db);
    for (const over of [{}, { resultVersion: 1 }, { resultVersion: 2 }]) {
      const bundle = resume(db, over);
      expect(bundle.working.status).toBe('a');
      expect(bundle.asOf.stateId).toBe(a.stateId);
      expect(Object.keys(bundle.asOf).sort()).toEqual(V1_ASOF_KEYS);
      expect('heads' in bundle).toBe(false);
      expect('heads' in bundle.coverage).toBe(false);
    }
  });

  it('extending the divergent head never moves the pointer; extending the pointed head does', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    const d = write(db, { expectedRevision: c.revision, idempotencyKey: 'k-d-000001', state: state('d') });
    expect(pointerRow(db).state_id).toBe(a.stateId);
    expect(liveHeads(db, TENANT, SCOPE).map((h) => h.stateId)).toEqual([a.stateId, d.stateId]);
    expect(resume(db, { resultVersion: 3 }).asOf).toMatchObject({ stateId: a.stateId, liveHeadCount: 2, divergentHeadCount: 1 });
    const e = write(db, { expectedRevision: a.revision, idempotencyKey: 'k-e-000001', state: state('e') });
    expect(pointerRow(db)).toMatchObject({ state_id: e.stateId, reason: 'advance' });
    expect(resume(db, { resultVersion: 3 }).working.status).toBe('e');
  });

  it('concurrent children of the pointed head: the first advances, the second branches (single-process serial transactions)', () => {
    const db = freshDb();
    write(db);
    const first = write(db, { expectedRevision: 1, idempotencyKey: 'k-w1-00001', state: state('w1') });
    const second = write(db, { expectedRevision: 1, idempotencyKey: 'k-w2-00001', state: state('w2') });
    expect(second.outcome).toBe('written'); // frozen CAS: a branch, never a conflict
    expect(pointerRow(db).state_id).toBe(first.stateId);
    expect(liveHeads(db, TENANT, SCOPE)).toHaveLength(2);
  });

  it('idempotent replay, conflict, and a rolled-back write leave the pointer untouched', () => {
    const db = freshDb();
    write(db);
    const bReq = cp({ expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    const b = performCheckpoint(db, directory, TENANT, bReq) as any;
    const e = write(db, { expectedRevision: b.revision, idempotencyKey: 'k-e-000001', state: state('e') });
    expect(pointerRow(db).state_id).toBe(e.stateId);
    // Replay of the A→B write after the pointer moved on: replays, no pointer change.
    expect((performCheckpoint(db, directory, TENANT, bReq) as any).outcome).toBe('idempotent-replay');
    expect(pointerRow(db).state_id).toBe(e.stateId);
    // conflict writes nothing.
    expect(write(db, { expectedRevision: null, idempotencyKey: 'k-x-000001' }).outcome).toBe('conflict');
    expect(pointerRow(db).state_id).toBe(e.stateId);
    // A failed change rolls back snapshot AND pointer advance.
    expect(() => write(db, {
      expectedRevision: e.revision, idempotencyKey: 'k-bad-0001', state: state('bad'),
      loopChanges: [{ loopId: 'nope', status: 'open', nextAction: 'x' }],
    })).toThrow(CheckpointChangeError);
    expect(pointerRow(db).state_id).toBe(e.stateId);
    expect(liveHeads(db, TENANT, SCOPE).map((h) => h.stateId)).toEqual([e.stateId]);
  });
});

describe('H1 resolver — every selection mode (§3.3)', () => {
  it('empty scope: selection empty-scope, working null, stale, no pointer, zero counts, empty complete heads', () => {
    const db = freshDb();
    expect(effectiveCurrentHead(db, TENANT, SCOPE)).toMatchObject({ head: null, selection: 'empty-scope', pointer: null, live: [] });
    const bundle = resume(db, { resultVersion: 3 });
    expect(bundle.working).toBeNull();
    expect(bundle.asOf).toMatchObject({ stateId: null, stale: true, selection: 'empty-scope', pointer: null, liveHeadCount: 0, divergentHeadCount: 0, retiredHeadCount: 0, conflicts: [] });
    expect(bundle.heads).toEqual([]);
    expect(bundle.coverage.heads).toMatchObject({ includedCount: 0, totalCount: 0, contentComplete: true, omittedReason: 'none' });
    expect(validV3(bundle), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('unresolved scope under v3: schemaVersion 3, empty-scope fields, empty accounted heads — never a missing key', () => {
    const db = freshDb();
    const bundle = resume(db, { resultVersion: 3, scope: { project: 'unknown-thing' } });
    expect(bundle.schemaVersion).toBe(3);
    expect(bundle.resolvedScope.scopeKey).toBeNull();
    expect(bundle.asOf).toMatchObject({ selection: 'empty-scope', pointer: null, liveHeadCount: 0, divergentHeadCount: 0, retiredHeadCount: 0 });
    expect(bundle.heads).toEqual([]);
    expect(bundle.coverage.heads.contentComplete).toBe(true);
    expect(validV3(bundle), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('LEGACY scope (snapshots, no pointer — predates H1): selection max-revision, explicitly flagged, pointer null; identical to pre-H1 for v1', () => {
    const db = freshDb();
    const { a, c } = attack(db);
    dropPointer(db); // simulate a scope written before H1 existed
    const eff = effectiveCurrentHead(db, TENANT, SCOPE);
    expect(eff).toMatchObject({ selection: 'max-revision', pointer: null });
    expect(eff.head?.stateId).toBe(c.stateId);
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.working.status).toBe('c');
    expect(v3.asOf).toMatchObject({ stateId: c.stateId, selection: 'max-revision', pointer: null, liveHeadCount: 2, divergentHeadCount: 1 });
    expect(v3.heads.map((h: any) => [h.stateId, h.isCurrent])).toEqual([[a.stateId, false], [c.stateId, true]]);
    const v1 = resume(db);
    expect(v1.working.status).toBe('c'); // the legacy answer, unchanged
    expect(v1.asOf.stateId).toBe(c.stateId);
  });

  it('a legacy scope stays undesignated on ordinary writes (only a reconcile gives it a pointer — §6.5)', () => {
    const db = freshDb();
    const { c } = attack(db);
    dropPointer(db);
    const d = write(db, { expectedRevision: c.revision, idempotencyKey: 'k-d-000001', state: state('d') });
    expect(pointerRow(db)).toBeUndefined();
    const eff = effectiveCurrentHead(db, TENANT, SCOPE);
    expect(eff.selection).toBe('max-revision');
    expect(eff.head?.stateId).toBe(d.stateId);
  });

  it('INVALID DESIGNATION (pointer names a non-live snapshot, direct SQL): fails CLOSED for every version — working null, never max revision', () => {
    const db = freshDb();
    const root = write(db);
    const b = write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    // root is not live (b is its child) — point at it anyway, out of band.
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    const eff = effectiveCurrentHead(db, TENANT, SCOPE);
    expect(eff.selection).toBe('invalid-designation');
    expect(eff.head).toBeNull();
    expect(eff.pointer?.stateId).toBe(root.stateId);
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.working).toBeNull();
    expect(v3.asOf).toMatchObject({ stateId: null, revision: null, stale: true, selection: 'invalid-designation', liveHeadCount: 1, divergentHeadCount: 1, retiredHeadCount: 0 });
    expect(v3.asOf.pointer).toMatchObject({ stateId: root.stateId, revision: 1 }); // the broken row, shown
    expect(v3.heads).toEqual([expect.objectContaining({ stateId: b.stateId, isCurrent: false })]);
    expect(v3.decisions).toEqual([]);
    expect(v3.evidence).toEqual([]);
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
    for (const over of [{}, { resultVersion: 2 }]) {
      const bundle = resume(db, over);
      expect(bundle.working).toBeNull();
      expect(bundle.asOf).toMatchObject({ stateId: null, stale: true });
    }
  });

  it('REGRESSION (codex 186e1f91 HIGH 1): a write extending a CORRUPT pointer target never repairs the pointer — invalid-designation persists until reconcile', () => {
    const db = freshDb();
    const root = write(db);
    const b = write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    // Out-of-band corruption: point back at root, which has child b (not live).
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    expect(effectiveCurrentHead(db, TENANT, SCOPE).selection).toBe('invalid-designation');
    // A frozen legacy write A→C: parent == pointer, but the pointer was NOT live.
    const c = write(db, { expectedRevision: 1, idempotencyKey: 'k-c-000001', state: state('c') });
    expect(c.outcome).toBe('written'); // the branch itself is legal (frozen CAS)
    expect(pointerRow(db).state_id).toBe(root.stateId); // pointer did NOT move
    const eff = effectiveCurrentHead(db, TENANT, SCOPE);
    expect(eff.selection).toBe('invalid-designation');
    expect(eff.head).toBeNull();
    expect(eff.live.map((h) => h.stateId)).toEqual([b.stateId, c.stateId]);
    for (const over of [{}, { resultVersion: 2 }, { resultVersion: 3 }]) {
      const bundle = resume(db, over);
      expect(bundle.working).toBeNull();
      expect(bundle.asOf).toMatchObject({ stateId: null, stale: true });
    }
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.asOf).toMatchObject({ selection: 'invalid-designation', liveHeadCount: 2, divergentHeadCount: 2 });
    expect(v3.asOf.pointer.stateId).toBe(root.stateId);
    expect(v3.heads.every((h: any) => h.isCurrent === false)).toBe(true);
    // And a healthy pointer is unaffected by the precondition: extending the live pointed head still advances.
    const db2 = freshDb();
    write(db2);
    const b2 = write(db2, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    expect(pointerRow(db2)).toMatchObject({ state_id: b2.stateId, reason: 'advance' });
  });

  it('exactly one head is flagged isCurrent under pointer/max-revision; none under empty-scope/invalid-designation', () => {
    const db = freshDb();
    const root = write(db);
    write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    write(db, { expectedRevision: 1, idempotencyKey: 'k-c-000001', state: state('c') });
    const flagged = () => resume(db, { resultVersion: 3 }).heads.filter((h: any) => h.isCurrent).length;
    expect(flagged()).toBe(1);
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    expect(flagged()).toBe(0);
    dropPointer(db);
    expect(flagged()).toBe(1);
  });
});

describe('H1 resume v3 — bundle shape, schema exclusivity, budget and cursor (§3.5, constraint 7)', () => {
  it('output schemas are mutually exclusive: each bundle version matches exactly one shape and the combined oneOf', () => {
    const db = freshDb();
    attack(db);
    const bundles = [resume(db), resume(db, { resultVersion: 2 }), resume(db, { resultVersion: 3 })];
    const validators = [validV1, validV2, validV3];
    bundles.forEach((bundle, i) => {
      expect(bundle.schemaVersion).toBe(i + 1);
      validators.forEach((v, j) => expect(v(bundle), `bundle v${i + 1} vs schema v${j + 1}: ${ajv.errorsText(v.errors)}`).toBe(i === j));
      expect(validBundle(bundle), ajv.errorsText(validBundle.errors)).toBe(true);
      expect(() => validateEng4Output('resume', bundle)).not.toThrow();
    });
    // v3 rejects a bundle missing any head field, or carrying an unknown selection.
    const v3 = bundles[2];
    expect(validV3({ ...v3, asOf: { ...v3.asOf, selection: 'anchor' } })).toBe(false);
    const { pointer: _p, ...withoutPointer } = v3.asOf;
    expect(validV3({ ...v3, asOf: withoutPointer })).toBe(false);
    const { heads: _h, ...withoutHeads } = v3;
    expect(validV3(withoutHeads)).toBe(false);
    expect(validV3({ ...v3, heads: [{ ...v3.heads[0], parentRetired: undefined }] })).toBe(false);
  });

  it('every runtime bundle in every mode validates through the handler validator', () => {
    const db = freshDb();
    const check = () => {
      for (const rv of [undefined, 2, 3]) {
        const bundle = resume(db, rv ? { resultVersion: rv } : {});
        expect(() => validateEng4Output('resume', bundle)).not.toThrow();
      }
    };
    check(); // empty
    const root = write(db);
    check(); // single head, pointer
    write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    write(db, { expectedRevision: 1, idempotencyKey: 'k-c-000001', state: state('c') });
    check(); // forked, pointer
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    check(); // invalid designation
    dropPointer(db);
    check(); // legacy
  });

  it('v3 asOf carries exactly the six frozen fields plus the five fixed-size head fields', () => {
    const db = freshDb();
    attack(db);
    expect(Object.keys(resume(db, { resultVersion: 3 }).asOf).sort()).toEqual(V3_ASOF_KEYS);
  });

  it('section order: heads is budgeted right after capsule; coverage.heads is closed', () => {
    const db = freshDb();
    attack(db);
    const bundle = resume(db, { resultVersion: 3 });
    const order = Object.keys(bundle.coverage).filter((k) => k !== 'totalTokenEstimate' && k !== 'budget');
    expect(order).toEqual(['working', 'capsule', 'heads', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers', 'divergentValues', 'legacyValues']); // H4 appended the last two
    expect(bundle.coverage.heads).toMatchObject({ includedCount: 2, totalCount: 2, contentComplete: true, omittedReason: 'none', nextCursor: null });
    expect(bundle.coverage.heads.tokenEstimate).toBeGreaterThan(0);
  });

  it('heads is BUDGETED: a tight budget omits heads with closed coverage and a cursor; following the cursor delivers every head exactly once', () => {
    const db = freshDb();
    write(db);
    const N = 40;
    for (let i = 0; i < N; i++) write(db, { expectedRevision: 1, idempotencyKey: `k-branch-${String(i).padStart(4, '0')}`, state: state(`b${i}`) });
    const all = liveHeads(db, TENANT, SCOPE).map((h) => h.stateId);
    expect(all).toHaveLength(N);

    const budget = 700;
    const first = resume(db, { resultVersion: 3, budget });
    expect(first.coverage.totalTokenEstimate).toBeLessThanOrEqual(budget);
    expect(first.working).not.toBeNull();
    expect(first.coverage.heads.totalCount).toBe(N);
    expect(first.coverage.heads.includedCount).toBeLessThan(N);
    expect(first.coverage.heads.includedCount).toBe(first.heads.length);
    expect(first.coverage.heads).toMatchObject({ contentComplete: false, omittedReason: 'budget' });
    expect(first.coverage.heads.nextCursor).toEqual(expect.any(String));
    expect(first.asOf.liveHeadCount).toBe(N); // fixed-size counts are never budget-trimmed
    expect(first.asOf.divergentHeadCount).toBe(N - 1);
    expect(validV3(first), ajv.errorsText(validV3.errors)).toBe(true);

    const seen: string[] = first.heads.map((h: any) => h.stateId);
    let cursor = first.coverage.heads.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = resume(db, { resultVersion: 3, budget, cursor });
      expect(page.coverage.totalTokenEstimate).toBeLessThanOrEqual(budget);
      expect(page.coverage.working.omittedReason).toBe('cursor'); // delivered earlier, accounted, not repeated
      expect(page.coverage.heads.totalCount).toBe(N);
      seen.push(...page.heads.map((h: any) => h.stateId));
      cursor = page.coverage.heads.nextCursor;
      expect(++pages).toBeLessThan(N + 2);
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...all].sort());
    expect(seen.filter((id) => id === pointerRow(db).state_id)).toHaveLength(1);
  });

  it('sections filter: resultVersion 3 with sections ["heads"] delivers only heads; asOf head fields are still present', () => {
    const db = freshDb();
    attack(db);
    const bundle = resume(db, { resultVersion: 3, sections: ['heads'] });
    expect(bundle.heads).toHaveLength(2);
    expect(bundle.working).toBeNull();
    expect(bundle.coverage.working).toMatchObject({ omittedReason: 'not-requested', contentComplete: false });
    expect(bundle.coverage.heads.contentComplete).toBe(true);
    expect(bundle.asOf.selection).toBe('pointer');
    expect(validV3(bundle), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('v1 and v2 never see heads: a v3 heads cursor is malformed under v1/v2 at runtime', () => {
    const db = freshDb();
    attack(db);
    const cursor = Buffer.from(JSON.stringify({ s: 'heads', o: 1 }), 'utf8').toString('base64url');
    expect(() => resume(db, { cursor })).toThrow(/malformed resume cursor/);
    expect(() => resume(db, { resultVersion: 2, cursor })).toThrow(/malformed resume cursor/);
  });

  it('resume input schema: resultVersion accepts 1|2|3 (not 4); "heads" in sections REQUIRES an explicit resultVersion 3 (codex 186e1f91 MEDIUM 2)', () => {
    const base = { agentId: 'a', scope: { project: 'Proj' }, budget: 1024 };
    expect(validResumeInput({ ...base, resultVersion: 3 })).toBe(true);
    expect(validResumeInput({ ...base, resultVersion: 4 })).toBe(false);
    expect(validResumeInput({ ...base, sections: ['anchors'] })).toBe(false);
    // The frozen v1/v2 request surface does not grow: heads is rejected without v3.
    expect(validResumeInput({ ...base, sections: ['heads'] })).toBe(false);
    expect(validResumeInput({ ...base, sections: ['working', 'heads'] })).toBe(false);
    expect(validResumeInput({ ...base, resultVersion: 1, sections: ['heads'] })).toBe(false);
    expect(validResumeInput({ ...base, resultVersion: 2, sections: ['heads'] })).toBe(false);
    expect(validResumeInput({ ...base, resultVersion: 3, sections: ['heads'] })).toBe(true);
    expect(validResumeInput({ ...base, resultVersion: 3, sections: ['working', 'heads', 'capsule'] })).toBe(true);
    // Other sections remain valid on v1/v2 exactly as before #8/#9.
    expect(validResumeInput({ ...base, sections: ['working', 'openLoops'] })).toBe(true);
    expect(validResumeInput({ ...base, resultVersion: 2, sections: ['capsule'] })).toBe(true);
  });
});

describe('H1 — v1/v2 requests carrying H-series fields fail validation (constraint 2)', () => {
  const H_SERIES_CHECKPOINT_FIELDS: Array<[string, unknown]> = [
    ['operation', 'reconcile'], ['expectedHeads', ['x']], ['expectedPointer', null], ['survivor', 'x'],
    ['reason', 'r'], ['strict', true], ['resolutions', []], ['rejectLineages', []],
    ['acknowledgeRetired', true], ['statePatch', {}],
  ];

  it('checkpoint: every H-series field is rejected on v1 and v2 requests; a plain resultVersion 3 request is accepted (H3)', () => {
    const base = cp();
    expect(validCheckpointInput(base)).toBe(true);
    for (const [field, value] of H_SERIES_CHECKPOINT_FIELDS) {
      expect(validCheckpointInput({ ...base, [field]: value }), field).toBe(false);
      expect(validCheckpointInput({ ...base, resultVersion: 2, [field]: value }), field).toBe(false);
    }
    expect(validCheckpointInput({ ...base, resultVersion: 3 })).toBe(true);
  });

  it('resume: unknown H-series request fields are rejected regardless of resultVersion', () => {
    const base = { agentId: 'a', scope: { project: 'Proj' }, budget: 1024 };
    for (const rv of [undefined, 1, 2, 3]) {
      const req = rv ? { ...base, resultVersion: rv } : base;
      expect(validResumeInput({ ...req, expectedHeads: ['x'] })).toBe(false);
      expect(validResumeInput({ ...req, acknowledgeRetired: true })).toBe(false);
    }
  });
});

describe('H1 acceptance canary shape (§7 row H1, simulated: the live store is the deploy-gated step)', () => {
  it('a legacy scope with 13 live heads and no pointer reports selection max-revision, liveHeadCount 13, and a complete heads section with parentRetired false throughout', () => {
    const db = freshDb();
    write(db);
    for (let i = 0; i < 13; i++) write(db, { expectedRevision: 1, idempotencyKey: `k-lane-${String(i).padStart(4, '0')}`, state: state(`h${i}`) });
    dropPointer(db);
    const bundle = resume(db, { resultVersion: 3, budget: 20000 });
    expect(bundle.asOf).toMatchObject({ selection: 'max-revision', pointer: null, liveHeadCount: 13, divergentHeadCount: 12, retiredHeadCount: 0 });
    expect(bundle.coverage.heads).toMatchObject({ includedCount: 13, totalCount: 13, contentComplete: true });
    expect(bundle.heads.every((h: any) => h.parentRetired === false)).toBe(true);
    expect(bundle.heads.filter((h: any) => h.isCurrent)).toHaveLength(1);
    expect(bundle.asOf.conflicts).toHaveLength(13);
    expect(validV3(bundle), ajv.errorsText(validV3.errors)).toBe(true);
  });
});
