/**
 * Field feedback P1 item 5: resume conflict semantics were unclear. A lane saw
 * current head 44 with revisions 34 and 35 in asOf.conflicts and could not
 * tell which was authoritative or whether to act. resume v3 now labels each
 * live head with role (current | divergent) and adds two fixed-size asOf
 * fields: selectionReason (why this head is current, what the others are) and
 * reconcileNeeded. v1/v2 bundles are unchanged.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, WorkingState } from '../src/unified-server/eng4/contracts.js';
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

describe('resume v3 head labels (role, selectionReason, reconcileNeeded)', () => {
  it('labels the pointed head current and every other live head divergent, even with a higher revision', () => {
    const db = freshDb();
    const { current, branches } = fieldShape(db);
    const v3 = resume(db, 3);
    expect(v3.asOf.stateId).toBe(current.stateId);
    expect(Math.max(...branches.map((b: any) => b.revision))).toBeGreaterThan(current.revision);
    const role = (id: string) => v3.heads.find((h: any) => h.stateId === id)?.role;
    expect(role(current.stateId)).toBe('current');
    for (const b of branches) expect(role(b.stateId)).toBe('divergent');
    for (const h of v3.heads) expect(h.role === 'current').toBe(h.isCurrent);
    expect(v3.asOf.reconcileNeeded).toBe(true);
    expect(v3.asOf.selectionReason).toBe(
      `Current is the head the scope pointer designates (revision ${current.revision}). ` +
      '2 other live heads are a branch written from a stale parent: NOT current, even when its revision is higher. ' +
      'Merge or retire with checkpoint operation:"reconcile" (resultVersion 3).',
    );
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
    expect(validBundle(v3)).toBe(true);
  });

  it('a single live head: reconcileNeeded false, reason says it is the only head', () => {
    const db = freshDb();
    write(db);
    const v3 = resume(db, 3);
    expect(v3.heads.map((h: any) => h.role)).toEqual(['current']);
    expect(v3.asOf.reconcileNeeded).toBe(false);
    expect(v3.asOf.selectionReason).toBe('Current is the head the scope pointer designates (revision 1). It is the only live head.');
    expect(validV3(v3), ajv.errorsText(validV3.errors)).toBe(true);
  });

  it('an empty scope and an invalid pointer are labelled too', () => {
    const empty = resume(freshDb(), 3);
    expect(empty.asOf).toMatchObject({ selection: 'empty-scope', reconcileNeeded: false, selectionReason: 'No snapshot in this scope yet.' });

    const db = freshDb();
    // Point at the root after it gained a child: a real snapshot that is no longer a live head.
    const root = write(db);
    write(db, { expectedRevision: 1, idempotencyKey: 'k-b-000001', state: state('b') });
    db.prepare(`UPDATE eng4_scope_current SET state_id=? WHERE tenant_id=? AND scope_key=?`).run(root.stateId, TENANT, SCOPE);
    const broken = resume(db, 3);
    expect(broken.asOf.selection).toBe('invalid-designation');
    expect(broken.asOf.reconcileNeeded).toBe(true);
    expect(broken.asOf.selectionReason).toMatch(/no head is current \(fail closed\)/);
    expect(broken.heads.every((h: any) => h.role === 'divergent')).toBe(true);
  });

  it('a legacy scope without a pointer explains max-revision selection', () => {
    expect(describeSelection('max-revision', 7, 1)).toMatch(/^Legacy scope without a pointer: current is the highest live revision \(7\)\. 1 other live head is/);
  });

  it('v1 and v2 bundles are unchanged: no role, no new asOf fields', () => {
    const db = freshDb();
    fieldShape(db);
    for (const v of [undefined, 2]) {
      const b = resume(db, v);
      expect(b.asOf).not.toHaveProperty('selectionReason');
      expect(b.asOf).not.toHaveProperty('reconcileNeeded');
      expect(b).not.toHaveProperty('heads');
      expect(validBundle(b), ajv.errorsText(validBundle.errors)).toBe(true);
    }
  });

  it('the v3 schema requires the new fields', () => {
    const db = freshDb();
    fieldShape(db);
    const v3 = resume(db, 3);
    const { selectionReason: _r, ...noReason } = v3.asOf;
    expect(validV3({ ...v3, asOf: noReason })).toBe(false);
    const { role: _role, ...noRole } = v3.heads[0];
    expect(validV3({ ...v3, heads: [noRole, ...v3.heads.slice(1)] })).toBe(false);
    expect(validV3({ ...v3, heads: [{ ...v3.heads[0], role: 'winner' }, ...v3.heads.slice(1)] })).toBe(false);
  });
});
