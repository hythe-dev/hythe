/**
 * ENG-4 H2 — the version foundation: append-only fact/loop versions, the
 * exact coverage manifest, the verified ledger-bound backfill, dual writes,
 * and the bidirectional parity verifier (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §6.2 and §7 row H2, merged 3429000;
 * internal increment of resultVersion 3 — DATA ONLY, no public read-model
 * change; H4 reads these rows through resume).
 *
 * CONTRACT
 * - changes_hash is the durable cutover marker: NOT NULL ⇒ exactly one
 *   coverage row per digest-verified ledger tuple; NULL ⇒ zero ledger,
 *   coverage and version rows (any row under a null digest is corruption).
 * - Every post-H2 checkpoint emits `materialized` coverage (source 'write')
 *   plus an exact version for every change, in the same transaction; a
 *   failed change rolls all of it back; replay adds nothing.
 * - The backfill runs at schema apply, in the DDL transaction, all-or-nothing,
 *   idempotent, and reconstructs ONLY from immutable data (hash-verified
 *   payload + digest-verified ledger + snapshot row). Fact changes and loop
 *   creations are always reconstructible. A loop update that omitted `owner`
 *   is materialized only when its immediately preceding ledger tuple has a
 *   materialized version and no null-digest snapshot lies between; otherwise
 *   `unversioned` with reason 'pre-h2-inherited-owner' — never a guess.
 * - verifyVersionParity recomputes the expected set and compares
 *   bidirectionally (cardinality, keys, disposition, deterministic reason,
 *   values). Missing / extra / mismatched rows → CheckpointIntegrityError.
 * - Same-scope by structure (composite FKs), append-only by trigger.
 * - The in-place tables and every resume bundle version are unchanged.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { RESUME_OUTPUT_SCHEMA_V3 } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointChangeError, CheckpointIntegrityError } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { canonicalize } from '../src/unified-server/eng4/canonical.js';
import { verifyVersionParity, UNVERSIONED_REASON_INHERITED_OWNER } from '../src/unified-server/eng4/versions.js';
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';

const ajv = new Ajv({ allErrors: true, $data: true });
const validV3 = ajv.compile(RESUME_OUTPUT_SCHEMA_V3 as any);

const TENANT = 't1';
const SCOPE = 'p:u-proj';
const OTHER = 'p:u-other';
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
  objective: 'H2', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [],
});
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
const fact = (subject: string, over: Partial<FactChange> = {}): FactChange => ({
  assertion: { subject, predicate: 'p', object: 'o' },
  status: 'asserted',
  evidenceRefs: ['ev'],
  sourceRefs: ['src'],
  ...over,
});
const snap = (db: any, stateId: string) =>
  db.prepare(`SELECT * FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, stateId) as any;
const coverage = (db: any, stateId: string) =>
  db.prepare(`SELECT kind, ordinal, change_id, disposition, reason, source FROM eng4_version_coverage WHERE tenant_id=? AND state_id=? ORDER BY kind, ordinal`).all(TENANT, stateId) as any[];
const factVersions = (db: any, stateId: string) =>
  db.prepare(`SELECT * FROM eng4_fact_versions WHERE tenant_id=? AND state_id=? ORDER BY ordinal`).all(TENANT, stateId) as any[];
const loopVersions = (db: any, stateId: string) =>
  db.prepare(`SELECT * FROM eng4_loop_versions WHERE tenant_id=? AND state_id=? ORDER BY ordinal`).all(TENANT, stateId) as any[];
const count = (db: any, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;

/** Every append-only / immutability trigger H1+H2 install, and their exact DDL. */
const TRIGGERS = [
  'trg_eng4_snapshots_immutable',
  'trg_eng4_fact_versions_immutable', 'trg_eng4_fact_versions_no_delete',
  'trg_eng4_loop_versions_immutable', 'trg_eng4_loop_versions_no_delete',
  'trg_eng4_version_coverage_immutable', 'trg_eng4_version_coverage_no_delete',
];
const ddlFor = (name: string) => (DDL_STANDALONE as readonly string[]).find((s) => s.includes(name))!;
/** Out-of-band corruption fixture: drop the triggers, modify, restore the exact trigger DDL. */
const bypass = (db: any, fn: () => void) => {
  for (const t of TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
  try { fn(); } finally { for (const t of TRIGGERS) db.exec(ddlFor(t)); }
};
/** Simulate a pre-H2 store: ledger and digests intact, no coverage or versions anywhere. */
const stripVersionFoundation = (db: any) => bypass(db, () => {
  db.exec(`DELETE FROM eng4_version_coverage; DELETE FROM eng4_fact_versions; DELETE FROM eng4_loop_versions;`);
});
/** Simulate a pre-ledger (pre-PR #8) snapshot: no ledger rows, null digest, no coverage/versions. */
const makePreLedger = (db: any, stateId: string) => bypass(db, () => {
  db.prepare(`DELETE FROM eng4_version_coverage WHERE tenant_id=? AND state_id=?`).run(TENANT, stateId);
  db.prepare(`DELETE FROM eng4_fact_versions WHERE tenant_id=? AND state_id=?`).run(TENANT, stateId);
  db.prepare(`DELETE FROM eng4_loop_versions WHERE tenant_id=? AND state_id=?`).run(TENANT, stateId);
  db.prepare(`DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`).run(TENANT, stateId);
  db.prepare(`UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`).run(TENANT, stateId);
});
/** Whole-store dump of the version foundation (coverage without `source`, so write/backfill dumps compare). */
const dump = (db: any) => ({
  coverage: db.prepare(`SELECT tenant_id, scope_key, state_id, kind, ordinal, change_id, disposition, reason FROM eng4_version_coverage ORDER BY state_id, kind, ordinal`).all(),
  facts: db.prepare(`SELECT * FROM eng4_fact_versions ORDER BY state_id, ordinal`).all(),
  loops: db.prepare(`SELECT * FROM eng4_loop_versions ORDER BY state_id, ordinal`).all(),
});

/** root(fact alpha, loop L created w/o owner) → s2(update alpha, L omitted owner, M created owner 'm') → s3(L owner 'y', M closed) → s4(L omitted owner). */
const history = (db: any) => {
  const root = write(db, { factChanges: [fact('alpha')], loopChanges: [{ status: 'open', nextAction: 'L0' }] });
  const L = root.changes.loops[0].loopId;
  const alpha = root.changes.facts[0].factId;
  const s2 = write(db, {
    expectedRevision: root.revision,
    factChanges: [fact('alpha-2', { factId: alpha, status: 'verified', evidenceRefs: ['ev2', 'ev1'], contradicts: ['zzz'] })],
    loopChanges: [{ loopId: L, status: 'blocked', nextAction: 'L1', blockedOn: 'x' }, { status: 'open', nextAction: 'M0', owner: 'm', dueAt: '2026-10-01' }],
  });
  const M = s2.changes.loops[1].loopId;
  const s3 = write(db, {
    expectedRevision: s2.revision,
    loopChanges: [{ loopId: L, status: 'open', nextAction: 'L2', owner: 'y' }, { loopId: M, status: 'closed', nextAction: 'done', closeOutcome: 'shipped' }],
  });
  const s4 = write(db, { expectedRevision: s3.revision, loopChanges: [{ loopId: L, status: 'open', nextAction: 'L3' }] });
  return { root, s2, s3, s4, L, M, alpha };
};

// ---------------------------------------------------------------------------

describe('H2 DDL — structure (§6.2)', () => {
  it('version and coverage tables, same-scope unique indexes, and six append-only triggers exist; apply is idempotent', () => {
    const db = freshDb();
    const names = (type: string) => db.prepare(`SELECT name FROM sqlite_master WHERE type=?`).all(type).map((r: any) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['eng4_fact_versions', 'eng4_loop_versions', 'eng4_version_coverage']));
    expect(names('index')).toEqual(expect.arrayContaining(['idx_eng4_facts_scope_id', 'idx_eng4_loops_scope_id']));
    expect(names('trigger')).toEqual(expect.arrayContaining(TRIGGERS.slice(1)));
    const result = applyEng4Schema(db);
    expect(result.versionBackfill).toEqual({ scopesScanned: 0, snapshotsScanned: 0, snapshotsBackfilled: 0, materialized: 0, unversioned: 0 });
    expect(names('trigger').filter((n: string) => n === 'trg_eng4_version_coverage_no_delete')).toHaveLength(1);
  });

  it('coverage CHECKs and FKs: reason only with unversioned, unversioned only from backfill, every row FKs a real ledger tuple in the right scope', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('a')] });
    stripVersionFoundation(db);
    const ins = (vals: unknown[]) => () => db.prepare(
      `INSERT INTO eng4_version_coverage (tenant_id, scope_key, state_id, kind, ordinal, change_id, disposition, reason, source) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(...vals);
    const f = w.changes.facts[0].factId;
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'materialized', UNVERSIONED_REASON_INHERITED_OWNER, 'write'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'unversioned', null, 'backfill'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'unversioned', UNVERSIONED_REASON_INHERITED_OWNER, 'write'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'unversioned', 'because', 'backfill'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'materialized', null, 'other'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'other', 0, f, 'materialized', null, 'write'])).toThrow(/CHECK/);
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 7, f, 'materialized', null, 'write'])).toThrow(/FOREIGN KEY/); // no such ledger tuple
    expect(ins([TENANT, OTHER, w.stateId, 'fact', 0, f, 'materialized', null, 'write'])).toThrow(/FOREIGN KEY/); // wrong scope for the state
    expect(ins([TENANT, SCOPE, w.stateId, 'fact', 0, f, 'materialized', null, 'write'])).not.toThrow();
  });

  it('a version can only reference a fact/loop and a snapshot of the SAME tenant and scope (composite FKs)', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('a')], loopChanges: [{ status: 'open', nextAction: 'n' }] });
    const other = performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'Other' } })) as any;
    const f = w.changes.facts[0].factId;
    const l = w.changes.loops[0].loopId;
    const insFact = (scope: string, stateId: string) => () => db.prepare(
      `INSERT INTO eng4_fact_versions (tenant_id, scope_key, fact_id, state_id, ordinal, subject, predicate, object, status, effective_at, refs_json, author, recorded_at)
       VALUES (?, ?, ?, ?, 9, 's', 'p', 'o', 'asserted', NULL, '{}', 'a', 't')`
    ).run(TENANT, scope, f, stateId);
    expect(insFact(OTHER, other.stateId)).toThrow(/FOREIGN KEY/); // fact belongs to Proj
    expect(insFact(SCOPE, other.stateId)).toThrow(/FOREIGN KEY/); // snapshot belongs to Other
    expect(insFact(SCOPE, 'no-such-state')).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(
      `INSERT INTO eng4_loop_versions (tenant_id, scope_key, loop_id, state_id, ordinal, owner, status, next_action, due_at, blocked_on, close_json, author, recorded_at)
       VALUES (?, ?, ?, ?, 9, 'o', 'open', 'n', NULL, NULL, NULL, 'a', 't')`
    ).run(TENANT, OTHER, l, other.stateId)).toThrow(/FOREIGN KEY/);
  });

  it('coverage and both version tables are append-only: UPDATE and DELETE are rejected', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('a')], loopChanges: [{ status: 'open', nextAction: 'n' }] });
    for (const [table, column] of [
      ['eng4_version_coverage', 'change_id'], ['eng4_fact_versions', 'author'], ['eng4_loop_versions', 'author'],
    ] as const) {
      expect(() => db.prepare(`UPDATE ${table} SET ${column}='x' WHERE tenant_id=? AND state_id=?`).run(TENANT, w.stateId), table).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND state_id=?`).run(TENANT, w.stateId), table).toThrow(/append-only/);
    }
    expect(() => db.prepare(`UPDATE eng4_version_coverage SET disposition='unversioned', reason=? WHERE tenant_id=? AND state_id=?`).run(UNVERSIONED_REASON_INHERITED_OWNER, TENANT, w.stateId)).toThrow(/append-only/);
  });
});

describe('H2 dual write — every post-H2 change gets exact materialized coverage + a version (§6.2)', () => {
  it('creations: one coverage row per ledger tuple (source write), fact values exact with canonical refs, loop owners resolved (omitted → author)', () => {
    const db = freshDb();
    const w = write(db, {
      factChanges: [fact('alpha', { effectiveAt: '2026-09-01T00:00:00Z', contradicts: ['c1'] }), fact('beta')],
      loopChanges: [{ status: 'open', nextAction: 'L0' }, { status: 'blocked', nextAction: 'M0', owner: 'x', blockedOn: 'b', dueAt: 'd' }],
    });
    const s = snap(db, w.stateId);
    expect(coverage(db, w.stateId)).toEqual([
      { kind: 'fact', ordinal: 0, change_id: w.changes.facts[0].factId, disposition: 'materialized', reason: null, source: 'write' },
      { kind: 'fact', ordinal: 1, change_id: w.changes.facts[1].factId, disposition: 'materialized', reason: null, source: 'write' },
      { kind: 'loop', ordinal: 0, change_id: w.changes.loops[0].loopId, disposition: 'materialized', reason: null, source: 'write' },
      { kind: 'loop', ordinal: 1, change_id: w.changes.loops[1].loopId, disposition: 'materialized', reason: null, source: 'write' },
    ]);
    const fv = factVersions(db, w.stateId);
    expect(fv).toHaveLength(2);
    expect(fv[0]).toMatchObject({
      fact_id: w.changes.facts[0].factId, ordinal: 0, subject: 'alpha', predicate: 'p', object: 'o', status: 'asserted',
      effective_at: '2026-09-01T00:00:00Z', author: 'claude-hythe', recorded_at: s.recorded_at,
      refs_json: canonicalize({ evidenceRefs: ['ev'], sourceRefs: ['src'], contradicts: ['c1'] }),
    });
    expect(fv[1]).toMatchObject({ subject: 'beta', effective_at: null, refs_json: canonicalize({ evidenceRefs: ['ev'], sourceRefs: ['src'], contradicts: [] }) });
    const lv = loopVersions(db, w.stateId);
    expect(lv[0]).toMatchObject({ loop_id: w.changes.loops[0].loopId, ordinal: 0, owner: 'claude-hythe', status: 'open', next_action: 'L0', due_at: null, blocked_on: null, close_json: null, author: 'claude-hythe', recorded_at: s.recorded_at });
    expect(lv[1]).toMatchObject({ owner: 'x', status: 'blocked', next_action: 'M0', due_at: 'd', blocked_on: 'b', close_json: null });
  });

  it('updates: a fact update versions the full new value; a loop update inherits the in-place owner when omitted, records the explicit one otherwise, and binds the close event', () => {
    const db = freshDb();
    const { s2, s3, L, M, alpha } = history(db);
    const fv = factVersions(db, s2.stateId);
    expect(fv).toEqual([expect.objectContaining({
      fact_id: alpha, ordinal: 0, subject: 'alpha-2', status: 'verified',
      refs_json: canonicalize({ evidenceRefs: ['ev2', 'ev1'], sourceRefs: ['src'], contradicts: ['zzz'] }),
    })]);
    expect(loopVersions(db, s2.stateId)).toEqual([
      expect.objectContaining({ loop_id: L, ordinal: 0, owner: 'claude-hythe', status: 'blocked', next_action: 'L1', blocked_on: 'x' }), // inherited from in-place
      expect.objectContaining({ loop_id: M, ordinal: 1, owner: 'm', status: 'open', due_at: '2026-10-01' }),
    ]);
    const s3Row = snap(db, s3.stateId);
    expect(loopVersions(db, s3.stateId)).toEqual([
      expect.objectContaining({ loop_id: L, owner: 'y', status: 'open', next_action: 'L2' }),
      expect.objectContaining({ loop_id: M, owner: 'm', status: 'closed', close_json: JSON.stringify({ closedAt: s3Row.recorded_at, closedBy: 'claude-hythe', outcome: 'shipped' }) }),
    ]);
    // The in-place row is the frozen v1/v2 view and still holds the last write.
    expect(db.prepare(`SELECT owner, status FROM eng4_open_loops WHERE tenant_id=? AND loop_id=?`).get(TENANT, L)).toEqual({ owner: 'y', status: 'open' });
  });

  it('the same factId twice in one checkpoint yields two versions at ordinals 0 and 1; in-place holds the last', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('v1')] });
    const id = w.changes.facts[0].factId;
    const u = write(db, { expectedRevision: 1, factChanges: [fact('v2', { factId: id }), fact('v3', { factId: id, status: 'disputed' })] });
    expect(factVersions(db, u.stateId).map((r) => [r.ordinal, r.subject, r.status])).toEqual([[0, 'v2', 'asserted'], [1, 'v3', 'disputed']]);
    expect(coverage(db, u.stateId).map((c) => c.change_id)).toEqual([id, id]);
    expect(db.prepare(`SELECT subject FROM eng4_facts WHERE tenant_id=? AND fact_id=?`).get(TENANT, id)).toEqual({ subject: 'v3' });
  });

  it('a failed change rolls back coverage and versions with everything else; idempotent replay adds nothing', () => {
    const db = freshDb();
    const params = cp({ factChanges: [fact('a')] });
    performCheckpoint(db, directory, TENANT, params);
    const before = dump(db);
    expect(() => write(db, { expectedRevision: 1, factChanges: [fact('b')], loopChanges: [{ loopId: 'nope', status: 'open', nextAction: 'x' }] })).toThrow(CheckpointChangeError);
    expect(dump(db)).toEqual(before);
    const replay = performCheckpoint(db, directory, TENANT, params) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(dump(db)).toEqual(before);
  });

  it('every post-H2 tuple is materialized: the verifier passes on a forked, multi-write scope with zero unversioned tuples', () => {
    const db = freshDb();
    const { root, L } = history(db);
    // A stale branch that rewrites L too (the §6.1 shape): still exactly versioned.
    write(db, { expectedRevision: root.revision, loopChanges: [{ loopId: L, status: 'closed', nextAction: 'x', closeOutcome: 'abandoned' }] });
    const summary = verifyVersionParity(db, TENANT, SCOPE);
    expect(summary).toEqual({ snapshotsVerified: 5, tuplesVerified: 9, materialized: 9, unversioned: 0 }); // 8 from history + the branch's loop close
  });

  it('no public read-model change: v1/v2/v3 resume still serve the in-place rows and carry no H4 sections', () => {
    const db = freshDb();
    history(db);
    for (const rv of [undefined, 2, 3]) {
      const bundle = performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 8000, ...(rv ? { resultVersion: rv } : {}) } as any) as any;
      expect(bundle.currentFacts.map((f: any) => f.assertion.subject)).toEqual(['alpha-2']);
      expect(bundle.openLoops).toHaveLength(2);
      expect('divergentValues' in bundle).toBe(false);
      expect('legacyValues' in bundle).toBe(false);
      if (rv === 3) expect(validV3(bundle), ajv.errorsText(validV3.errors)).toBe(true);
    }
  });
});

describe('H2 backfill — verified, ledger-bound, all-or-nothing, idempotent (§6.2, §7 row H2)', () => {
  it('ROUND TRIP: stripping every coverage/version row and re-applying the schema reconstructs the identical set (source backfill), all materialized when the chain is ledger-complete', () => {
    const db = freshDb();
    history(db);
    const before = dump(db);
    expect(before.coverage.length).toBe(8);
    stripVersionFoundation(db);
    expect(count(db, 'eng4_version_coverage')).toBe(0);
    const result = applyEng4Schema(db);
    expect(result.versionBackfill).toEqual({ scopesScanned: 1, snapshotsScanned: 4, snapshotsBackfilled: 4, materialized: 8, unversioned: 0 });
    expect(dump(db)).toEqual(before);
    expect(db.prepare(`SELECT DISTINCT source FROM eng4_version_coverage`).all()).toEqual([{ source: 'backfill' }]);
    expect(verifyVersionParity(db, TENANT, SCOPE).unversioned).toBe(0);
  });

  it('UNPROVABLE INHERITED OWNER: a loop created pre-ledger → its omitted-owner update is `unversioned` (pre-h2-inherited-owner) with no version; an explicit-owner update is materialized; the next omitted-owner update chains from it', () => {
    const db = freshDb();
    const { root, s2, s3, s4, L, M } = history(db);
    makePreLedger(db, root.stateId); // root (L's creation, alpha's creation) becomes unknowable history
    stripVersionFoundation(db);
    const result = applyEng4Schema(db);
    expect(result.versionBackfill).toMatchObject({ snapshotsScanned: 4, snapshotsBackfilled: 3, unversioned: 1 });
    // s2: L update omitted owner → unprovable (no ledger predecessor); M creation → materialized.
    expect(coverage(db, s2.stateId)).toEqual([
      expect.objectContaining({ kind: 'fact', ordinal: 0, disposition: 'materialized' }),
      { kind: 'loop', ordinal: 0, change_id: L, disposition: 'unversioned', reason: UNVERSIONED_REASON_INHERITED_OWNER, source: 'backfill' },
      { kind: 'loop', ordinal: 1, change_id: M, disposition: 'materialized', reason: null, source: 'backfill' },
    ]);
    expect(loopVersions(db, s2.stateId).map((r) => r.loop_id)).toEqual([M]); // no version for the opaque tuple
    // s3: explicit owner 'y' → materialized regardless of history.
    expect(coverage(db, s3.stateId).every((c) => c.disposition === 'materialized')).toBe(true);
    expect(loopVersions(db, s3.stateId)[0]).toMatchObject({ loop_id: L, owner: 'y' });
    // s4: omitted owner, predecessor s3 is materialized with no gap → owner 'y', materialized.
    expect(coverage(db, s4.stateId)).toEqual([{ kind: 'loop', ordinal: 0, change_id: L, disposition: 'materialized', reason: null, source: 'backfill' }]);
    expect(loopVersions(db, s4.stateId)[0]).toMatchObject({ owner: 'y', next_action: 'L3' });
    // The verifier recomputes the same deterministic reason.
    expect(verifyVersionParity(db, TENANT, SCOPE)).toMatchObject({ snapshotsVerified: 4, unversioned: 1 });
    // And the null-digest root stays bare.
    expect(coverage(db, root.stateId)).toEqual([]);
  });

  it('UNKNOWABLE GAP: a null-digest snapshot between a loop\'s ledger-recorded creation and an omitted-owner update makes that update `unversioned`', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'L0', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    const gap = write(db, { expectedRevision: root.revision }); // no changes at all…
    const upd = write(db, { expectedRevision: gap.revision, loopChanges: [{ loopId: L, status: 'open', nextAction: 'L1' }] });
    makePreLedger(db, gap.stateId); // …but pre-ledger: it COULD have updated L (creations there are unidentifiable, updates unverifiable)
    stripVersionFoundation(db);
    applyEng4Schema(db);
    expect(coverage(db, upd.stateId)).toEqual([{ kind: 'loop', ordinal: 0, change_id: L, disposition: 'unversioned', reason: UNVERSIONED_REASON_INHERITED_OWNER, source: 'backfill' }]);
    expect(loopVersions(db, upd.stateId)).toEqual([]);
    expect(loopVersions(db, root.stateId)[0]).toMatchObject({ owner: 'orig' }); // the creation itself is fully reconstructible
    expect(verifyVersionParity(db, TENANT, SCOPE).unversioned).toBe(1);
  });

  it('SOURCE SEMANTICS: a post-H2 write that inherits an unprovable owner is materialized (the writer knew the value) and verifies; the same shape under backfill is unversioned', () => {
    const db = freshDb();
    const root = write(db, { loopChanges: [{ status: 'open', nextAction: 'L0', owner: 'orig' }] });
    const L = root.changes.loops[0].loopId;
    makePreLedger(db, root.stateId);
    const upd = write(db, { expectedRevision: root.revision, loopChanges: [{ loopId: L, status: 'open', nextAction: 'L1' }] });
    expect(coverage(db, upd.stateId)).toEqual([{ kind: 'loop', ordinal: 0, change_id: L, disposition: 'materialized', reason: null, source: 'write' }]);
    expect(loopVersions(db, upd.stateId)[0]).toMatchObject({ owner: 'orig' }); // exact in-place owner at write time
    expect(verifyVersionParity(db, TENANT, SCOPE)).toMatchObject({ materialized: 1, unversioned: 0 });
    // Re-apply must leave it alone (already covered) — no reinterpretation as backfill.
    expect(applyEng4Schema(db).versionBackfill).toMatchObject({ snapshotsBackfilled: 0 });
    expect(coverage(db, upd.stateId)[0].source).toBe('write');
    // Whereas if the SAME tuple had to be backfilled, the owner is unprovable → unversioned.
    stripVersionFoundation(db);
    applyEng4Schema(db);
    expect(coverage(db, upd.stateId)[0]).toMatchObject({ disposition: 'unversioned', reason: UNVERSIONED_REASON_INHERITED_OWNER, source: 'backfill' });
  });

  it('ALL-OR-NOTHING: a altered ledger in one snapshot aborts the whole backfill — no coverage row lands for ANY snapshot', () => {
    const db = freshDb();
    const { s2 } = history(db);
    stripVersionFoundation(db);
    db.prepare(`UPDATE eng4_snapshot_changes SET change_id='inconsistent' WHERE tenant_id=? AND state_id=? AND kind='fact' AND ordinal=0`).run(TENANT, s2.stateId);
    expect(() => applyEng4Schema(db)).toThrow(CheckpointIntegrityError);
    expect(count(db, 'eng4_version_coverage')).toBe(0);
    expect(count(db, 'eng4_fact_versions')).toBe(0);
    expect(count(db, 'eng4_loop_versions')).toBe(0);
    // The schema itself is still there (the DDL is IF NOT EXISTS and was applied earlier).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='eng4_version_coverage'`).get()).toEqual({ n: 1 });
  });

  it('a null-digest snapshot that carries ledger, coverage or version rows is corruption, not legacy history: apply refuses', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('a')] });
    bypass(db, () => db.prepare(`UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`).run(TENANT, w.stateId));
    expect(() => applyEng4Schema(db)).toThrow(/no change digest but carries/);
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/no change digest but carries/);
  });

  it('a covered snapshot with the wrong number of coverage rows fails the apply (structural parity)', () => {
    const db = freshDb();
    const w = write(db, { factChanges: [fact('a'), fact('b')] });
    bypass(db, () => db.prepare(`DELETE FROM eng4_version_coverage WHERE tenant_id=? AND state_id=? AND ordinal=1`).run(TENANT, w.stateId));
    expect(() => applyEng4Schema(db)).toThrow(/coverage rows for 2 ledger tuples/);
  });

  it('idempotent: a second apply on a covered store backfills nothing and duplicates nothing; statementsOverride skips the backfill', () => {
    const db = freshDb();
    history(db);
    const before = dump(db);
    const again = applyEng4Schema(db);
    expect(again.versionBackfill).toMatchObject({ snapshotsScanned: 4, snapshotsBackfilled: 0, materialized: 0, unversioned: 0 });
    expect(dump(db)).toEqual(before);
    const overridden = applyEng4Schema(db, [`CREATE TABLE IF NOT EXISTS eng4_h2_probe (x INTEGER)`]);
    expect('versionBackfill' in overridden).toBe(false);
  });
});

describe('H2 verifier — bidirectional, fails CLOSED on every corruption fixture (§6.2, 89c01374 blocker 4)', () => {
  const healthy = () => {
    const db = freshDb();
    const h = history(db);
    expect(verifyVersionParity(db, TENANT, SCOPE).snapshotsVerified).toBe(4);
    return { db, ...h };
  };

  it('a deleted coverage row', () => {
    const { db, s2 } = healthy();
    bypass(db, () => db.prepare(`DELETE FROM eng4_version_coverage WHERE tenant_id=? AND state_id=? AND kind='loop' AND ordinal=1`).run(TENANT, s2.stateId));
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/expected 3 coverage rows, found 2/);
  });

  it('a deleted expected version row (fact and loop)', () => {
    const { db, s2 } = healthy();
    bypass(db, () => db.prepare(`DELETE FROM eng4_fact_versions WHERE tenant_id=? AND state_id=?`).run(TENANT, s2.stateId));
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/missing fact version/);
    const { db: db2, s3: t3 } = healthy();
    bypass(db2, () => db2.prepare(`DELETE FROM eng4_loop_versions WHERE tenant_id=? AND state_id=? AND ordinal=1`).run(TENANT, t3.stateId));
    expect(() => verifyVersionParity(db2, TENANT, SCOPE)).toThrow(/missing loop version/);
  });

  it('a altered version value (object, owner, close event, refs, author)', () => {
    for (const [sql, pattern] of [
      [`UPDATE eng4_fact_versions SET object='altered'`, /fact version value mismatch/],
      [`UPDATE eng4_fact_versions SET refs_json='{}'`, /fact version value mismatch/],
      [`UPDATE eng4_fact_versions SET author='someone-else'`, /fact version value mismatch/],
      [`UPDATE eng4_loop_versions SET owner='changed'`, /loop version value mismatch/],
      [`UPDATE eng4_loop_versions SET close_json=NULL WHERE close_json IS NOT NULL`, /loop version value mismatch/],
      [`UPDATE eng4_loop_versions SET recorded_at='1970-01-01T00:00:00Z'`, /loop version value mismatch/],
    ] as const) {
      const { db } = healthy();
      bypass(db, () => db.exec(sql));
      expect(() => verifyVersionParity(db, TENANT, SCOPE), sql).toThrow(pattern);
    }
  });

  it('an EXTRA version row beyond what coverage accounts for', () => {
    const { db, s2, alpha } = healthy();
    bypass(db, () => db.prepare(
      `INSERT INTO eng4_fact_versions (tenant_id, scope_key, fact_id, state_id, ordinal, subject, predicate, object, status, effective_at, refs_json, author, recorded_at)
       VALUES (?, ?, ?, ?, 5, 's', 'p', 'o', 'asserted', NULL, '{}', 'a', 't')`
    ).run(TENANT, SCOPE, alpha, s2.stateId));
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/expected 1 fact versions, found 2/);
  });

  it('a flipped disposition: materialized→unversioned on a fact, or a version present for an unversioned tuple', () => {
    const { db, s2 } = healthy();
    bypass(db, () => db.prepare(`UPDATE eng4_version_coverage SET disposition='unversioned', reason=?, source='backfill' WHERE tenant_id=? AND state_id=? AND kind='fact'`).run(UNVERSIONED_REASON_INHERITED_OWNER, TENANT, s2.stateId));
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/fact\[0\] must be materialized/);

    // Genuine unversioned tuple (unprovable owner) + an unexpected version row for it.
    const db2 = freshDb();
    const { root, s2: t2, L } = history(db2);
    makePreLedger(db2, root.stateId);
    stripVersionFoundation(db2);
    applyEng4Schema(db2);
    bypass(db2, () => db2.prepare(
      `INSERT INTO eng4_loop_versions (tenant_id, scope_key, loop_id, state_id, ordinal, owner, status, next_action, due_at, blocked_on, close_json, author, recorded_at)
       VALUES (?, ?, ?, ?, 0, 'guess', 'blocked', 'L1', NULL, 'x', NULL, 'claude-hythe', ?)`
    ).run(TENANT, SCOPE, L, t2.stateId, snap(db2, t2.stateId).recorded_at));
    expect(() => verifyVersionParity(db2, TENANT, SCOPE)).toThrow(/is unversioned but has a version row/);
  });

  it('a coverage row whose change_id disagrees with the ledger, and a ledger/payload mismatch', () => {
    const { db, s2 } = healthy();
    bypass(db, () => db.prepare(`UPDATE eng4_version_coverage SET change_id='other' WHERE tenant_id=? AND state_id=? AND kind='fact'`).run(TENANT, s2.stateId));
    expect(() => verifyVersionParity(db, TENANT, SCOPE)).toThrow(/coverage change_id mismatch/);
    const { db: db2, s3 } = healthy();
    db2.pragma('foreign_keys = OFF'); // out-of-band change: coverage FKs the ledger, the digest is what catches it
    db2.prepare(`DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=? AND ordinal=1`).run(TENANT, s3.stateId);
    db2.pragma('foreign_keys = ON');
    expect(() => verifyVersionParity(db2, TENANT, SCOPE)).toThrow(CheckpointIntegrityError);
  });

  it('scopes are verified independently: corruption in one scope does not fail the other', () => {
    const { db } = healthy();
    const other = performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'Other' }, factChanges: [fact('o')] })) as any;
    bypass(db, () => db.prepare(`UPDATE eng4_fact_versions SET object='x' WHERE tenant_id=? AND state_id=?`).run(TENANT, other.stateId));
    expect(() => verifyVersionParity(db, TENANT, OTHER)).toThrow(/fact version value mismatch/);
    expect(verifyVersionParity(db, TENANT, SCOPE).snapshotsVerified).toBe(4);
  });
});
