/**
 * ENG-4 H5 — versioned checkpoint operations `record` and `patch` (design
 * note docs/design/ENG4-HEAD-RECONCILIATION.md §5, §7 row H5) and the
 * per-call verification memo. Last internal increment of resultVersion 3;
 * publishing v3 remains the owner's separate gate (§2.10).
 *
 * CONTRACT
 * - `record` (resultVersion 3): fact/loop changes WITHOUT resending state.
 *   `patch`: an RFC 7396 merge patch on the state. Both FORBID `state` in the
 *   request and derive it from the parent's hash-verified canonical payload
 *   (never state_json): record keeps it byte-for-byte; patch applies the
 *   merge patch (null deletes, arrays replace wholesale) and the result must
 *   be a complete valid working state or the call fails closed.
 * - Both admit ONLY the pointed head as parent (selection 'pointer' and
 *   expectedRevision = the pointer's revision); anything else — a stale
 *   parent, a legacy max-revision scope, an invalid designation — is a v3
 *   `conflict` carrying heads + pointer. Never a branch (§5.1).
 * - A successful record/patch advances the pointer like any write on the
 *   pointed head (§3.2a). Results are the v3 written shape with `changes`, so
 *   the field report's item 2 (new loop ids without a resume round-trip) is
 *   closed end to end.
 * - Fingerprints: record binds operation:'record' + resolved parent + the
 *   non-state changes (state:null in the content); patch additionally binds
 *   the RAW merge patch; write/record/patch for the same key are pairwise
 *   different; replay parity holds.
 * - v1/v2 request surface frozen: operation/statePatch fail validation there;
 *   `state` remains required for write/reconcile.
 * - The memo: within one resume/checkpoint every payload is hashed and parsed
 *   once; nothing is cached across calls (an out-of-band change is caught on
 *   the next call).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { CHECKPOINT_INPUT_SCHEMA, CHECKPOINT_OUTPUT_SCHEMA } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, applyMergePatch, CheckpointPatchError, CheckpointEmptyScopeError, CheckpointIntegrityError, CheckpointParentStateError } from '../src/unified-server/eng4/checkpoint.js';
import { CheckpointRetiredParentError } from '../src/unified-server/eng4/reconcile.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { requestFingerprint } from '../src/unified-server/eng4/canonical.js';
import { readScopePointer } from '../src/unified-server/eng4/heads.js';
import { lastMemoStats } from '../src/unified-server/eng4/memo.js';
import { validateEng4Output } from '../src/unified-server/eng4/register.js';
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';

const ajv = new Ajv({ allErrors: true, $data: true });
const validInput = ajv.compile(CHECKPOINT_INPUT_SCHEMA as any);
const validResult = ajv.compile(CHECKPOINT_OUTPUT_SCHEMA as any);

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
  db.exec(`CREATE TABLE ai_messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, priority TEXT DEFAULT 'normal', created_at TEXT, read_at TEXT, delivered_at TEXT, tenant_id TEXT DEFAULT 'default')`);
  db.exec(`CREATE TABLE session_handoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_agent TEXT NOT NULL, summary TEXT NOT NULL, open_items_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), consumed_at TEXT, active INTEGER NOT NULL DEFAULT 1, last_confirmed TEXT, tenant_id TEXT DEFAULT 'default', user_id TEXT)`);
  applyEng4Schema(db);
  return db;
};
const state = (status: string, over: Partial<WorkingState> = {}): WorkingState => ({ objective: 'H5', status, owner: 'claude-hythe', nextActions: ['n1', 'n2'], blockers: [], guardrails: ['g'], ...over });
let keyCounter = 0;
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe', scope: { project: 'Proj' }, expectedRevision: null,
  idempotencyKey: `k-${String(++keyCounter).padStart(6, '0')}`, state: state('s'), resultVersion: 2, ...over,
});
const write = (db: any, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, cp(over)) as any;
/** A v3 record/patch request: no state; expectedRevision defaults to the pointer's revision. */
const derived = (db: any, operation: 'record' | 'patch', over: Partial<CheckpointParams> = {}): CheckpointParams => {
  const { state: _s, ...rest } = cp({ resultVersion: 3, operation, expectedRevision: readScopePointer(db, TENANT, SCOPE)?.revision ?? null, ...over });
  return rest as CheckpointParams;
};
const record = (db: any, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, derived(db, 'record', over)) as any;
const patch = (db: any, statePatch: Record<string, unknown>, over: Partial<CheckpointParams> = {}) => performCheckpoint(db, directory, TENANT, derived(db, 'patch', { statePatch, ...over })) as any;
const fact = (subject: string, over: Partial<FactChange> = {}): FactChange => ({ assertion: { subject, predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: ['ev'], sourceRefs: ['src'], ...over });
const resume = (db: any, over: Record<string, unknown> = {}) =>
  performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 20000, ...over } as any) as any;
const pointerRow = (db: any) => db.prepare(`SELECT state_id, reason FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).get(TENANT, SCOPE) as any;
const stateJsonOf = (db: any, stateId: string) => JSON.parse((db.prepare(`SELECT state_json FROM eng4_state_snapshots WHERE state_id=?`).get(stateId) as any).state_json);
const payloadStateOf = (db: any, stateId: string) => {
  const row = db.prepare(`SELECT p.body FROM eng4_state_snapshots s JOIN eng4_payloads p ON p.tenant_id=s.tenant_id AND p.content_hash=s.content_hash WHERE s.state_id=?`).get(stateId) as any;
  return JSON.parse(Buffer.from(row.body).toString('utf8')).state;
};
const ddlFor = (name: string) => (DDL_STANDALONE as readonly string[]).find((s) => s.includes(name))!;
const dropPointer = (db: any) => db.prepare(`DELETE FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE);

// ---------------------------------------------------------------------------

describe('H5 request surface (§5.1, §2.2)', () => {
  it('input schema: record forbids state and statePatch; patch requires statePatch and forbids state; write/reconcile still require state; v1/v2 reject operation and statePatch', () => {
    const base = { agentId: 'a', scope: { project: 'Proj' }, expectedRevision: 1, idempotencyKey: 'k-schema-1', resultVersion: 3 };
    expect(validInput({ ...base, operation: 'record' })).toBe(true);
    expect(validInput({ ...base, operation: 'record', factChanges: [fact('x')], loopChanges: [{ status: 'open', nextAction: 'n' }] })).toBe(true);
    expect(validInput({ ...base, operation: 'record', state: state('s') })).toBe(false);
    expect(validInput({ ...base, operation: 'record', statePatch: { status: 'x' } })).toBe(false);
    expect(validInput({ ...base, operation: 'patch', statePatch: { status: 'x' } })).toBe(true);
    expect(validInput({ ...base, operation: 'patch' })).toBe(false);
    expect(validInput({ ...base, operation: 'patch', statePatch: { status: 'x' }, state: state('s') })).toBe(false);
    expect(validInput({ ...base, operation: 'patch', statePatch: 'not-an-object' })).toBe(false);
    // acknowledgeRetired can never apply to record/patch (pointed head only): rejected, not ignored.
    expect(validInput({ ...base, operation: 'record', acknowledgeRetired: true })).toBe(false);
    expect(validInput({ ...base, operation: 'patch', statePatch: { status: 'x' }, acknowledgeRetired: false })).toBe(false);
    expect(validInput({ ...base, operation: 'write', state: state('s'), acknowledgeRetired: true })).toBe(true);
    expect(validInput({ ...base, operation: 'write' })).toBe(false); // state required
    expect(validInput({ ...base, operation: 'write', state: state('s') })).toBe(true);
    expect(validInput({ ...base, operation: 'write', state: state('s'), statePatch: {} })).toBe(false);
    expect(validInput({ ...base })).toBe(false); // absent operation = write → state required
    expect(validInput({ ...base, state: state('s') })).toBe(true);
    for (const rv of [undefined, 1, 2]) {
      const v: any = { agentId: 'a', scope: { project: 'Proj' }, expectedRevision: 1, idempotencyKey: 'k-schema-2', state: state('s') };
      if (rv) v.resultVersion = rv;
      expect(validInput(v), `rv ${rv}`).toBe(true);
      expect(validInput({ ...v, operation: 'record' }), `rv ${rv}`).toBe(false);
      expect(validInput({ ...v, statePatch: {} }), `rv ${rv}`).toBe(false);
      const { state: _s, ...noState } = v;
      expect(validInput(noState), `rv ${rv} without state`).toBe(false);
    }
  });

  it('fingerprints: write, record and patch for the same key are pairwise different; the raw patch is bound; equivalent patches with permuted keys are identical', () => {
    const envelope = { scopeKey: SCOPE, state: state('x'), events: [], factChanges: [], loopChanges: [], evidenceRefs: [] };
    const base = { canonicalAgentId: 'a', scopeKey: SCOPE, expectedRevision: 2, resolvedParentStateId: 'S', resultVersion: 3 as const };
    const w = requestFingerprint({ ...base, envelope, operation: 'write' });
    const derivedEnvelope = { ...envelope, state: null };
    const r = requestFingerprint({ ...base, envelope: derivedEnvelope, operation: 'record' });
    const p1 = requestFingerprint({ ...base, envelope: derivedEnvelope, operation: 'patch', patch: { status: 'x', blockers: ['b'] } });
    const p2 = requestFingerprint({ ...base, envelope: derivedEnvelope, operation: 'patch', patch: { blockers: ['b'], status: 'x' } });
    const p3 = requestFingerprint({ ...base, envelope: derivedEnvelope, operation: 'patch', patch: { status: 'y' } });
    expect(new Set([w, r, p1, p3]).size).toBe(4);
    expect(p1).toBe(p2);
    expect(requestFingerprint({ ...base, envelope: derivedEnvelope, operation: 'record', reconcile: undefined })).toBe(r);
  });
});

describe('H5 record — changes without resending state (§5.3)', () => {
  it('records fact/loop changes, keeps the parent state BYTE-FOR-BYTE from the verified payload, returns the new ids, and advances the pointer (field report item 2, end to end)', () => {
    const db = freshDb();
    const root = write(db, { state: state('root', { nextActions: ['a', 'b'] }) });
    const r = record(db, { factChanges: [fact('f1')], loopChanges: [{ status: 'open', nextAction: 'do it' }] });
    expect(r.outcome).toBe('written');
    expect(Object.keys(r).sort()).toEqual(['changes', 'contentHash', 'outcome', 'parentStateId', 'revision', 'scopeKey', 'stateId']); // v3 write shape, no reconciled
    expect(r.parentStateId).toBe(root.stateId);
    expect(r.changes.facts[0].created).toBe(true);
    expect(r.changes.loops[0].created).toBe(true);
    expect(pointerRow(db)).toEqual({ state_id: r.stateId, reason: 'advance' });
    expect(payloadStateOf(db, r.stateId)).toEqual(payloadStateOf(db, root.stateId));
    expect(stateJsonOf(db, r.stateId)).toEqual(state('root', { nextActions: ['a', 'b'] }));
    expect(validResult(r), ajv.errorsText(validResult.errors)).toBe(true);
    expect(() => validateEng4Output('checkpoint', r)).not.toThrow();
    // The loop id is usable immediately: a second record updates it, no resume round-trip needed.
    const r2 = record(db, { loopChanges: [{ loopId: r.changes.loops[0].loopId, status: 'closed', nextAction: 'done', closeOutcome: 'ok' }] });
    expect(r2.changes.loops[0]).toEqual({ loopId: r.changes.loops[0].loopId, created: false });
    const v3 = resume(db, { resultVersion: 3 });
    expect(v3.asOf.stateId).toBe(r2.stateId);
    expect(v3.working.status).toBe('root');
    expect(v3.openLoops[0]).toMatchObject({ status: 'closed', provenance: expect.objectContaining({ stateId: r2.stateId }) });
    expect(v3.currentFacts).toHaveLength(1);
  });

  it('the parent state comes from the verified PAYLOAD, never from state_json (§5.2)', () => {
    const db = freshDb();
    const root = write(db, { state: state('truth') });
    // Alter the unverified state_json out of band (immutability trigger dropped); the payload stays authoritative.
    db.exec(`DROP TRIGGER trg_eng4_snapshots_immutable`);
    db.prepare(`UPDATE eng4_state_snapshots SET state_json=? WHERE state_id=?`).run(JSON.stringify(state('lie')), root.stateId);
    db.exec(ddlFor('trg_eng4_snapshots_immutable'));
    const r = record(db, { factChanges: [fact('f')] });
    expect(payloadStateOf(db, r.stateId).status).toBe('truth');
    expect(stateJsonOf(db, r.stateId).status).toBe('truth');
    // A parent payload that fails verification fails the record closed.
    const db2 = freshDb();
    const root2 = write(db2);
    db2.pragma('foreign_keys = OFF');
    db2.prepare(`UPDATE eng4_payloads SET body=CAST('{"x":1}' AS BLOB), byte_length=7 WHERE content_hash=?`).run(root2.contentHash); // consistent length, wrong hash
    db2.pragma('foreign_keys = ON');
    expect(() => record(db2, { factChanges: [fact('f')] })).toThrow(CheckpointIntegrityError);
  });

  it('idempotent replay returns the same result (changes included); a same-key write is a fingerprint mismatch', () => {
    const db = freshDb();
    write(db);
    const params = derived(db, 'record', { factChanges: [fact('f')], idempotencyKey: 'k-record-1' });
    const first = performCheckpoint(db, directory, TENANT, params) as any;
    const replay = performCheckpoint(db, directory, TENANT, params) as any;
    expect(replay).toMatchObject({ outcome: 'idempotent-replay', stateId: first.stateId, changes: first.changes });
    expect(validResult(replay), ajv.errorsText(validResult.errors)).toBe(true);
    const asWrite = performCheckpoint(db, directory, TENANT, { ...params, operation: 'write', state: state('s') }) as any;
    expect(asWrite.outcome).toBe('idempotency-mismatch');
    expect(pointerRow(db).state_id).toBe(first.stateId);
  });
});

describe('H5 patch — RFC 7396 merge patch on the verified parent state (§5.4)', () => {
  it('applies the patch: scalars replace, arrays replace wholesale, unmentioned fields persist; result validates and advances the pointer', () => {
    const db = freshDb();
    write(db, { state: state('open', { nextActions: ['a', 'b', 'c'], blockers: ['x'] }) });
    const p = patch(db, { status: 'blocked', nextActions: ['only-this'] }, { factChanges: [fact('why')] });
    expect(p.outcome).toBe('written');
    expect(payloadStateOf(db, p.stateId)).toEqual(state('blocked', { nextActions: ['only-this'], blockers: ['x'] }));
    expect(stateJsonOf(db, p.stateId)).toEqual(payloadStateOf(db, p.stateId));
    expect(pointerRow(db)).toEqual({ state_id: p.stateId, reason: 'advance' });
    expect(resume(db).working).toEqual(state('blocked', { nextActions: ['only-this'], blockers: ['x'] })); // v1 follows the pointer
    expect(validResult(p), ajv.errorsText(validResult.errors)).toBe(true);
  });

  it('fails CLOSED when the patched state is not a complete valid working state (null deletes a required key; wrong types; extra keys); nothing written', () => {
    const db = freshDb();
    const root = write(db);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get() as any;
    expect(() => patch(db, { status: null })).toThrow(CheckpointPatchError);
    expect(() => patch(db, { nextActions: 'not-an-array' })).toThrow(CheckpointPatchError);
    expect(() => patch(db, { extra: 'key' })).toThrow(CheckpointPatchError);
    expect(() => patch(db, { blockers: [1, 2] })).toThrow(CheckpointPatchError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual(before);
    expect(pointerRow(db).state_id).toBe(root.stateId);
    // An empty patch is a legal no-op patch (state identical, new snapshot).
    const noop = patch(db, {});
    expect(payloadStateOf(db, noop.stateId)).toEqual(payloadStateOf(db, root.stateId));
  });

  it('applyMergePatch follows RFC 7396: null deletes, objects merge recursively, arrays and scalars replace wholesale', () => {
    expect(applyMergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { a: null, b: { c: 9 }, e: [3] })).toEqual({ b: { c: 9, d: 3 }, e: [3] });
    expect(applyMergePatch({ a: 1 }, { b: { c: 1 } })).toEqual({ a: 1, b: { c: 1 } });
    expect(applyMergePatch({ a: { x: 1 } }, { a: 'scalar' })).toEqual({ a: 'scalar' });
    expect(applyMergePatch('anything', { a: 1 })).toEqual({ a: 1 });
    expect(applyMergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  it('a prototype key anywhere in the patch fails CLOSED (independent review finding 3): never silently dropped, nothing written', () => {
    const own = (json: string) => JSON.parse(json) as Record<string, unknown>; // an OWN "__proto__" key, unlike an object literal
    expect(() => applyMergePatch({ objective: 'o' }, own('{"__proto__":{"objective":"x"}}'))).toThrow(CheckpointPatchError);
    expect(() => applyMergePatch({}, own('{"constructor":{"prototype":{}}}'))).toThrow(CheckpointPatchError);
    expect(() => applyMergePatch({}, { a: own('{"prototype":1}') })).toThrow(CheckpointPatchError);
    const db = freshDb();
    const root = write(db);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get() as any;
    expect(() => patch(db, own('{"__proto__":{"objective":"x"}}'))).toThrow(CheckpointPatchError);
    expect(() => patch(db, own('{"status":"ok","constructor":{"x":1}}'))).toThrow(CheckpointPatchError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual(before);
    expect(pointerRow(db).state_id).toBe(root.stateId);
    expect(Object.getPrototypeOf(applyMergePatch({}, { a: 1 }))).toBe(Object.prototype); // no global pollution either
  });

  it('a pointed head whose verified state no longer validates is an ADMISSION failure (typed, tells the caller to write), not an integrity error (independent review finding 4)', () => {
    const db = freshDb();
    const root = write(db);
    // Simulate schema drift out of band: a consistent payload whose state lacks a now-required key.
    const row = db.prepare(`SELECT p.body FROM eng4_state_snapshots s JOIN eng4_payloads p ON p.tenant_id=s.tenant_id AND p.content_hash=s.content_hash WHERE s.state_id=?`).get(root.stateId) as any;
    const env = JSON.parse(Buffer.from(row.body).toString('utf8'));
    delete env.state.guardrails;
    const bytes = Buffer.from(JSON.stringify(env), 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    db.pragma('foreign_keys = OFF');
    const src = db.prepare(`SELECT * FROM eng4_payloads WHERE content_hash=?`).get(root.contentHash) as Record<string, unknown>;
    const copy = { ...src, content_hash: hash, body: bytes, byte_length: bytes.length };
    db.prepare(`INSERT INTO eng4_payloads (${Object.keys(copy).join(', ')}) VALUES (${Object.keys(copy).map(() => '?').join(', ')})`).run(...Object.values(copy));
    db.exec(`DROP TRIGGER trg_eng4_snapshots_immutable`);
    db.prepare(`UPDATE eng4_state_snapshots SET content_hash=? WHERE state_id=?`).run(hash, root.stateId);
    db.exec(ddlFor('trg_eng4_snapshots_immutable'));
    db.pragma('foreign_keys = ON');
    expect(() => record(db, { factChanges: [fact('f')] })).toThrow(CheckpointParentStateError);
    expect(() => patch(db, { status: 'x' })).toThrow(/send a full write/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual({ n: 1 });
    // The way out the message names: a full v3 write on the pointed head.
    expect(write(db, { resultVersion: 3, expectedRevision: 1, state: state('repaired') }).outcome).toBe('written');
  });

  it('direct callers behind the schema get typed failures, not TypeErrors (independent review finding 6): statePatch null/array, missing state on write/reconcile', () => {
    const db = freshDb();
    write(db);
    expect(() => performCheckpoint(db, directory, TENANT, derived(db, 'patch', { statePatch: null as any }))).toThrow(CheckpointPatchError);
    expect(() => performCheckpoint(db, directory, TENANT, derived(db, 'patch', { statePatch: [1] as any }))).toThrow(CheckpointPatchError);
    expect(() => performCheckpoint(db, directory, TENANT, derived(db, 'patch', {}))).toThrow(CheckpointPatchError);
    const { state: _s, ...noState } = cp({ resultVersion: 3, expectedRevision: 1 });
    expect(() => performCheckpoint(db, directory, TENANT, noState as any)).toThrow(/requires a full working state/);
    expect(() => performCheckpoint(db, directory, TENANT, { ...noState, state: null } as any)).toThrow(/requires a full working state/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual({ n: 1 });
  });

  it('idempotent replay; a different patch under the same key is a fingerprint mismatch; the same patch with permuted keys replays', () => {
    const db = freshDb();
    write(db);
    const params = derived(db, 'patch', { statePatch: { status: 'a', blockers: ['b'] }, idempotencyKey: 'k-patch-1' });
    const first = performCheckpoint(db, directory, TENANT, params) as any;
    expect((performCheckpoint(db, directory, TENANT, { ...params, statePatch: { blockers: ['b'], status: 'a' } }) as any)).toMatchObject({ outcome: 'idempotent-replay', stateId: first.stateId });
    expect((performCheckpoint(db, directory, TENANT, { ...params, statePatch: { status: 'z' } }) as any).outcome).toBe('idempotency-mismatch');
  });
});

describe('H5 admissible parent: only the pointed head (§5.1) — conflicts in every other selection mode', () => {
  it('a stale (non-pointer) parent conflicts instead of branching, carrying heads and the pointer; nothing written', () => {
    const db = freshDb();
    const root = write(db);
    const a = write(db, { expectedRevision: 1, state: state('a') }); // pointer → A
    const c = write(db, { expectedRevision: 1, state: state('c') }); // divergent live head
    for (const op of ['record', 'patch'] as const) {
      const res = performCheckpoint(db, directory, TENANT, derived(db, op, { expectedRevision: 1, ...(op === 'patch' ? { statePatch: { status: 'x' } } : {}), factChanges: [fact('f')] })) as any; // root: not live
      expect(res).toMatchObject({ outcome: 'conflict', pointer: a.stateId });
      expect(res.heads.map((h: any) => h.stateId).sort()).toEqual([a.stateId, c.stateId].sort());
      const onC = performCheckpoint(db, directory, TENANT, derived(db, op, { expectedRevision: c.revision, ...(op === 'patch' ? { statePatch: { status: 'x' } } : {}) })) as any; // live but not the pointer
      expect(onC).toMatchObject({ outcome: 'conflict', pointer: a.stateId });
      expect(validResult(res), ajv.errorsText(validResult.errors)).toBe(true);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual({ n: 3 });
    void root;
  });

  it('legacy max-revision scope (no pointer) and invalid designation both conflict; an empty scope is a typed error; a plain v3 write still branches', () => {
    const db = freshDb();
    write(db);
    const b = write(db, { expectedRevision: 1, state: state('b') });
    dropPointer(db);
    expect(record(db, { expectedRevision: b.revision, factChanges: [fact('f')] })).toMatchObject({ outcome: 'conflict', pointer: null });
    expect(patch(db, { status: 'x' }, { expectedRevision: b.revision })).toMatchObject({ outcome: 'conflict', pointer: null });
    // Invalid designation: pointer at a non-live snapshot.
    db.prepare(`INSERT INTO eng4_scope_current VALUES (?, ?, ?, 't', 'x', 'first-write')`).run(TENANT, SCOPE, (db.prepare(`SELECT state_id FROM eng4_state_snapshots WHERE revision=1`).get() as any).state_id);
    expect(record(db, { expectedRevision: 1, factChanges: [fact('f')] }).outcome).toBe('conflict');
    expect(record(db, { expectedRevision: b.revision, factChanges: [fact('f')] }).outcome).toBe('conflict');
    // Frozen write semantics untouched: a v3 write on the stale parent branches.
    expect(write(db, { resultVersion: 3, expectedRevision: 1, state: state('branch') }).outcome).toBe('written');
    const empty = freshDb();
    expect(() => performCheckpoint(empty, directory, TENANT, derived(empty, 'record', { expectedRevision: null, factChanges: [fact('f')] }))).toThrow(CheckpointEmptyScopeError);
  });

  it('record/patch never resurrect a retired head: the pointer check conflicts first; a reconcile then admits them on the new pointer', () => {
    const db = freshDb();
    write(db);
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c') });
    const rev = (id: string) => (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE state_id=?`).get(id) as any).revision;
    const r = performCheckpoint(db, directory, TENANT, cp({ resultVersion: 3, operation: 'reconcile', expectedRevision: rev(a.stateId), expectedHeads: [a.stateId, c.stateId], expectedPointer: a.stateId, survivor: a.stateId, reason: 'fold', state: state('reconciled') })) as any;
    expect(r.outcome).toBe('written');
    expect(record(db, { expectedRevision: rev(c.stateId), factChanges: [fact('f')] }).outcome).toBe('conflict'); // retired C is not the pointer
    const ok = record(db, { factChanges: [fact('f')] }); // pointer = R
    expect(ok).toMatchObject({ outcome: 'written', parentStateId: r.stateId });
    expect(payloadStateOf(db, ok.stateId).status).toBe('reconciled');
  });
});

describe('H5 fingerprint binds acknowledgeRetired (codex review of PR #15, finding 1)', () => {
  it('a v3 write on a retired parent with acknowledgeRetired:true replays only with the acknowledgment; dropping it under the same key is an idempotency-mismatch, never a replay', () => {
    const db = freshDb();
    write(db);
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c') });
    const rev = (id: string) => (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE state_id=?`).get(id) as any).revision;
    performCheckpoint(db, directory, TENANT, cp({ resultVersion: 3, operation: 'reconcile', expectedRevision: rev(a.stateId), expectedHeads: [a.stateId, c.stateId], expectedPointer: a.stateId, survivor: a.stateId, reason: 'fold', state: state('reconciled') }));
    const acked = cp({ resultVersion: 3, expectedRevision: rev(c.stateId), state: state('again'), acknowledgeRetired: true, idempotencyKey: 'k-ack-1' });
    const first = performCheckpoint(db, directory, TENANT, acked) as any;
    expect(first.outcome).toBe('written');
    expect(performCheckpoint(db, directory, TENANT, acked)).toMatchObject({ outcome: 'idempotent-replay', stateId: first.stateId });
    const { acknowledgeRetired: _ack, ...dropped } = acked;
    const withoutAck = performCheckpoint(db, directory, TENANT, dropped) as any;
    expect(withoutAck.outcome).toBe('idempotency-mismatch');
    expect(withoutAck.stateId).toBe(first.stateId);
    expect(performCheckpoint(db, directory, TENANT, { ...dropped, acknowledgeRetired: false })).toMatchObject({ outcome: 'idempotency-mismatch' });
    // Under a fresh key the unacknowledged retired-parent write is still refused (§4.5).
    expect(() => performCheckpoint(db, directory, TENANT, { ...dropped, idempotencyKey: 'k-ack-2' })).toThrow(CheckpointRetiredParentError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get()).toEqual({ n: 5 });
  });

  it('fingerprint bytes: bound only when true and only for v3; v1/v2 and unacknowledged v3 requests are unchanged; reconcile does not double-bind', () => {
    const envelope = { scopeKey: SCOPE, state: state('x'), events: [], factChanges: [], loopChanges: [], evidenceRefs: [] };
    const base = { canonicalAgentId: 'a', scopeKey: SCOPE, expectedRevision: 2, resolvedParentStateId: 'S' };
    for (const rv of [undefined, 1, 2, 3] as const) {
      const plain = requestFingerprint({ ...base, envelope, resultVersion: rv });
      expect(requestFingerprint({ ...base, envelope, resultVersion: rv, acknowledgeRetired: false })).toBe(plain);
      expect(requestFingerprint({ ...base, envelope, resultVersion: rv, acknowledgeRetired: undefined })).toBe(plain);
      expect(requestFingerprint({ ...base, envelope, resultVersion: rv, acknowledgeRetired: true })).not.toBe(plain);
    }
    // End to end: a v1/v2 request cannot carry the flag (schema); performCheckpoint binds it for v3 only,
    // so a v2 request with the (schema-invalid) flag set produces the frozen v2 fingerprint.
    const db = freshDb();
    write(db);
    const k = cp({ resultVersion: 2, expectedRevision: 1, state: state('v2'), idempotencyKey: 'k-v2-ack' });
    const w = performCheckpoint(db, directory, TENANT, k) as any;
    expect(performCheckpoint(db, directory, TENANT, { ...k, acknowledgeRetired: true } as any)).toMatchObject({ outcome: 'idempotent-replay', stateId: w.stateId });
  });
});

describe('H5 per-call verification memo', () => {
  /** JSON.parse calls whose input is exactly one of the persisted payload bodies, keyed by content hash. */
  const countPayloadParses = (db: any, run: () => void): Map<string, number> => {
    const bodies = new Map<string, string>(
      (db.prepare(`SELECT content_hash, body FROM eng4_payloads`).all() as any[]).map((r) => [Buffer.from(r.body).toString('utf8'), r.content_hash])
    );
    const counts = new Map<string, number>();
    const spy = vi.spyOn(JSON, 'parse');
    try {
      run();
      for (const call of spy.mock.calls) {
        const hash = bodies.get(String(call[0]));
        if (hash) counts.set(hash, (counts.get(hash) ?? 0) + 1);
      }
    } finally {
      spy.mockRestore();
    }
    return counts;
  };

  it('one v3 resume parses EVERY payload at most once (codex review of PR #15, finding 2) and hits the memo on a lineage with reconciles; nothing persists across calls — an out-of-band payload change is caught by the next call', () => {
    const db = freshDb();
    const root = write(db, { factChanges: [fact('good')] });
    const F = root.changes.facts[0].factId;
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c'), factChanges: [fact('bad', { factId: F })] });
    const rev = (id: string) => (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE state_id=?`).get(id) as any).revision;
    const r = performCheckpoint(db, directory, TENANT, cp({ resultVersion: 3, operation: 'reconcile', expectedRevision: rev(a.stateId), expectedHeads: [a.stateId, c.stateId], expectedPointer: a.stateId, survivor: a.stateId, reason: 'fold', rejectLineages: [c.stateId], state: state('reconciled') })) as any;
    const parses = countPayloadParses(db, () => resume(db, { resultVersion: 3 }));
    expect(parses.get(r.contentHash), 'the current head (decisions + verifiers)').toBe(1);
    expect(parses.get(c.contentHash), 'the rejected divergent terminal').toBe(1);
    for (const [hash, n] of parses) expect(n, hash).toBe(1);
    expect(lastMemoStats.hits).toBeGreaterThan(0);
    const missesFirst = lastMemoStats.misses;
    resume(db, { resultVersion: 3 });
    expect(lastMemoStats.misses).toBe(missesFirst); // same work each call: nothing was remembered across calls
    // A record on the pointed head reads its parent payload once too.
    const recParses = countPayloadParses(db, () => record(db, { factChanges: [fact('after')] }));
    expect(recParses.get(r.contentHash)).toBe(1);
    for (const [hash, n] of recParses) expect(n, hash).toBe(1);
  });

  it('a payload changed out of band DURING one v3 resume never reaches a consumer (independent review finding 1): every verified fact comes from the first SELECT; the bundle reflects the verified bytes; the next call fails closed', () => {
    const db = freshDb();
    write(db, { factChanges: [fact('good')] });
    const a = write(db, { expectedRevision: 1, state: state('a') });
    const c = write(db, { expectedRevision: 1, state: state('c') });
    const rev = (id: string) => (db.prepare(`SELECT revision FROM eng4_state_snapshots WHERE state_id=?`).get(id) as any).revision;
    const r = performCheckpoint(db, directory, TENANT, cp({ resultVersion: 3, operation: 'reconcile', expectedRevision: rev(a.stateId), expectedHeads: [a.stateId, c.stateId], expectedPointer: a.stateId, survivor: a.stateId, reason: 'fold', state: state('reconciled'), events: [{ kind: 'decision', summary: 'real' }] })) as any;
    const original = db.prepare(`SELECT body, byte_length FROM eng4_payloads WHERE content_hash=?`).get(r.contentHash) as any;
    const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(original.body).toString('utf8')), events: [{ kind: 'decision', summary: 'modified out of band' }] }), 'utf8');
    // Stand-in for an external writer committing between two statements of the same (non-transactional) resume:
    // right after the FIRST statement that returns the reconcile payload, its row is replaced (consistent length, stale hash).
    const realPrepare = db.prepare.bind(db);
    const replace = realPrepare(`UPDATE eng4_payloads SET body=?, byte_length=? WHERE content_hash=?`);
    let fired = 0;
    (db as any).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (/FROM eng4_payloads/.test(sql)) {
        const get = stmt.get.bind(stmt);
        (stmt as any).get = (...args: any[]) => {
          const row = get(...args);
          if (args[1] === r.contentHash && fired++ === 0) {
            db.pragma('foreign_keys = OFF');
            replace.run(modified, modified.length, r.contentHash);
            db.pragma('foreign_keys = ON');
          }
          return row;
        };
      }
      return stmt;
    };
    try {
      const bundle = resume(db, { resultVersion: 3 });
      expect(fired).toBeGreaterThan(0);
      expect(bundle.decisions.map((d: any) => d.summary)).toEqual(['real']);
      expect(bundle.evidence[0]).toMatchObject({ contentHash: r.contentHash, byteLength: original.byte_length });
      expect(bundle.working.status).toBe('reconciled');
    } finally {
      (db as any).prepare = realPrepare;
    }
    expect(() => resume(db, { resultVersion: 3 })).toThrow(CheckpointIntegrityError);
    // Out-of-band payload alteration is detected on the next call (fail closed).
    db.pragma('foreign_keys = OFF');
    db.prepare(`UPDATE eng4_payloads SET body=CAST('{}' AS BLOB), byte_length=2 WHERE content_hash=?`).run(c.contentHash);
    db.pragma('foreign_keys = ON');
    expect(() => resume(db, { resultVersion: 3 })).toThrow(CheckpointIntegrityError);
  });
});
