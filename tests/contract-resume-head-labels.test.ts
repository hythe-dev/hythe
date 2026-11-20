/**
 * Field feedback P1 item 5: resume conflict semantics were unclear. A lane saw
 * current head 44 with revisions 34 and 35 in asOf.conflicts and could not
 * tell which was authoritative or whether to act. resume v3 now labels each
 * live head with role (current | divergent with a valid pointer; undesignated
 * without one) and adds fixed-size asOf fields: selectionReason,
 * reconcileNeeded (writes are blocked: record/patch conflict until a
 * reconcile) and cleanupAvailable (retained branches beside a valid pointer;
 * nothing blocked). v1/v2 bundles are unchanged.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { RESUME_OUTPUT_SCHEMA, RESUME_OUTPUT_SCHEMA_V3 } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint } from '../src/unified-server/eng4/checkpoint.js';
import { describeSelection, performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);
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

const state = (status: string): WorkingState => ({
  objective: 'C5', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [],
});
const write = (db: any, over: Partial<CheckpointParams> = {}) =>
  performCheckpoint(db, directory, TENANT, {
    agentId: 'claude-hythe', scope: { project: 'Proj' }, expectedRevision: null,
    idempotencyKey: 'k-root-0001', state: state('root'), ...over,
  }) as any;
const fact = (subject: string): FactChange => ({ assertion: { subject, predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: ['ev'], sourceRefs: ['src'] });
/** A v3 record (no state) against an explicit revision. */
const record = (db: any, expectedRevision: number, key: string) => {
  const { state: _s, ...params } = {
    agentId: 'claude-hythe', scope: { project: 'Proj' }, expectedRevision, idempotencyKey: key,
    state: state('unused'), resultVersion: 3, operation: 'record', factChanges: [fact(key)],
  } as any;
  return performCheckpoint(db, directory, TENANT, params as CheckpointParams) as any;
};
const dropPointer = (db: any) => db.prepare(`DELETE FROM eng4_scope_current WHERE tenant_id=? AND scope_key=?`).run(TENANT, SCOPE);
const resume = (db: any, resultVersion?: number) =>
  performResume(db, directory, TENANT, {
    agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 4000, ...(resultVersion ? { resultVersion } : {}),
  } as any) as any;

/**
 * The field shape: the pointer advances root(1) -> b1(2) -> b2(4) while two
 * stale writers branch from revision 1: stale-1 (3) and stale-2 (5). One
 * divergent head has a LOWER revision than current and one a HIGHER one.
 */
const fieldShape = (db: any) => {
  write(db);
  const b1 = write(db, { expectedRevision: 1, idempotencyKey: 'k-b1-00001', state: state('b1') });
  const stale1 = write(db, { expectedRevision: 1, idempotencyKey: 'k-s1-00001', state: state('stale-1') });
  const b2 = write(db, { expectedRevision: b1.revision, idempotencyKey: 'k-b2-00001', state: state('b2') });
  const stale2 = write(db, { expectedRevision: 1, idempotencyKey: 'k-s2-00001', state: state('stale-2') });
  return { current: b2, branches: [stale1, stale2] };
};

describe('resume v3 head labels (role, selectionReason, reconcileNeeded, cleanupAvailable)', () => {
  it('pointer + branches: the pointed head is current, every other live head divergent (even with a higher revision); nothing blocked', () => {
    const db = freshDb();
    const { current, branches } = fieldShape(db);
    const v3 = resume(db, 3);
    expect(v3.asOf.stateId).toBe(current.stateId);
    expect(Math.max(...branches.map((b: any) => b.revision))).toBeGreaterThan(current.revision);
    const role = (id: string) => v3.heads.find((h: any) => h.stateId === id)?.role;
    expect(role(current.stateId)).toBe('current');
    for (const b of branches) expect(role(b.stateId)).toBe('divergent');
    for (const h of v3.heads) expect(h.role === 'current').toBe(h.isCurrent);
    expect(v3.asOf).toMatchObject({ selection: 'pointer', reconcileNeeded: false, cleanupAvailable: true });
    expect(v3.asOf.selectionReason).toBe(
      `Current is the head the scope pointer designates (revision ${current.revision}). ` +
      '2 other live heads are branches retained from a stale parent: not current, even with a higher revision. ' +
      'Writes to the current revision succeed; retiring the branches with checkpoint operation:"reconcile" (resultVersion 3) is optional cleanup.',
    );
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
    expect(validBundle(v3)).toBe(true);
    // reconcileNeeded:false is true to checkpoint: record on the current head is written.
    expect(record(db, current.revision, 'k-rec-ptr-01').outcome).toBe('written');
  });

  it('a single divergent head reads singular', () => {
    expect(describeSelection('pointer', 4, 1)).toContain('1 other live head is a branch retained from a stale parent');
  });

  it('a single live head: nothing blocked, no cleanup, reason says it is the only head', () => {
    const db = freshDb();
    write(db);
    const v3 = resume(db, 3);
    expect(v3.heads.map((h: any) => h.role)).toEqual(['current']);
    expect(v3.asOf).toMatchObject({ reconcileNeeded: false, cleanupAvailable: false });
    expect(v3.asOf.selectionReason).toBe('Current is the head the scope pointer designates (revision 1). It is the only live head.');
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('legacy scope without a pointer (several heads): no head designated, no lineage claimed, writes blocked, record conflicts', () => {
    const db = freshDb();
    const { current, branches } = fieldShape(db);
    dropPointer(db);
    const v3 = resume(db, 3);
    const highest = Math.max(current.revision, ...branches.map((b: any) => b.revision));
    expect(v3.asOf.selection).toBe('max-revision');
    expect(v3.asOf.revision).toBe(highest); // the pre-existing working-state fallback is kept
    expect(v3.heads.map((h: any) => h.role)).toEqual(['undesignated', 'undesignated', 'undesignated']);
    expect(v3.heads.filter((h: any) => h.isCurrent).map((h: any) => h.revision)).toEqual([highest]); // isCurrent fallback kept
    expect(v3.asOf).toMatchObject({ reconcileNeeded: true, cleanupAvailable: false });
    expect(v3.asOf.selectionReason).toBe(
      'Legacy scope without a pointer: no head is designated. ' +
      `The highest of 3 live heads (revision ${highest}) is shown as working state only; it is not known to be the lineage tip. ` +
      'record and patch conflict until checkpoint operation:"reconcile" (resultVersion 3) designates a head.',
    );
    expect(v3.asOf.selectionReason).not.toMatch(/stale parent/);
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
    // reconcileNeeded:true is true to checkpoint: record on the shown head conflicts.
    expect(record(db, highest, 'k-rec-leg-01').outcome).toBe('conflict');
  });

  it('legacy scope without a pointer (one head): still undesignated and blocked', () => {
    const db = freshDb();
    write(db);
    dropPointer(db);
    const v3 = resume(db, 3);
    expect(v3.heads.map((h: any) => h.role)).toEqual(['undesignated']);
    expect(v3.asOf).toMatchObject({ selection: 'max-revision', reconcileNeeded: true, cleanupAvailable: false });
    expect(v3.asOf.selectionReason).toBe(
      'Legacy scope without a pointer: no head is designated. Its only live head (revision 1) is shown as working state. ' +
      'record and patch conflict until checkpoint operation:"reconcile" (resultVersion 3) designates a head.',
    );
    expect(record(db, 1, 'k-rec-leg-02').outcome).toBe('conflict');
  });

  it('an empty scope and an invalid pointer are labelled too', () => {
    const empty = resume(freshDb(), 3);
    expect(empty.asOf).toMatchObject({ selection: 'empty-scope', reconcileNeeded: false, cleanupAvailable: false, selectionReason: 'No snapshot in this scope yet.' });

    const db = freshDb();
    // Point at the root after it gained a child: a real snapshot that is no longer a live head.
    const root = write(db);
    write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    const broken = resume(db, 3);
    expect(broken.asOf.selection).toBe('invalid-designation');
    expect(broken.asOf).toMatchObject({ reconcileNeeded: true, cleanupAvailable: false });
    expect(broken.asOf.selectionReason).toMatch(/no head is designated \(fail closed\)/);
    expect(broken.heads.every((h: any) => h.role === 'undesignated')).toBe(true);
    expect(validV3(broken), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('v1 and v2 bundles are unchanged: no role, no new asOf fields', () => {
    const db = freshDb();
    fieldShape(db);
    for (const v of [undefined, 2]) {
      const b = resume(db, v);
      for (const key of ['selectionReason', 'reconcileNeeded', 'cleanupAvailable']) expect(b.asOf).not.toHaveProperty(key);
      expect(b).not.toHaveProperty('heads');
      expect(validBundle(b), ajv.errorsText(validBundle.errors)).toBe(true);
    }
  });

  it('the v3 schema requires the new fields', () => {
    const db = freshDb();
    fieldShape(db);
    const v3 = resume(db, 3);
    for (const key of ['selectionReason', 'reconcileNeeded', 'cleanupAvailable']) {
      const { [key]: _drop, ...rest } = v3.asOf;
      expect(validV3({ ...v3, asOf: rest })).toBe(false);
    }
    const { role: _role, ...noRole } = v3.heads[0];
    expect(validV3({ ...v3, heads: [noRole, ...v3.heads.slice(1)] })).toBe(false);
    expect(validV3({ ...v3, heads: [{ ...v3.heads[0], role: 'winner' }, ...v3.heads.slice(1)] })).toBe(false);
  });
});
