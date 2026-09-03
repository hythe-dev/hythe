/**
 * ENG-4 — resume selects the rehydration capsule BY KIND (data-audit HIGH 1,
 * codex-hythe 1e5d0dc6, 2026-09-03).
 *
 * THE DEFECT: get_current_observation returns the newest observation of ANY
 * kind, so one unrelated append (a handoff note, a finding) displaces the
 * capsule pointer that every lane uses as its entry point. Convention
 * ("don't append here") is not an invariant.
 *
 * CONTRACT
 * - The schemaVersion=1 bundle is FROZEN and remains the default: no
 *   `capsule` key, byte-identical to before.
 * - Request `resultVersion: 2` → schemaVersion=2: the v1 bundle plus
 *   `capsule` = { current, conflicts, candidatesConsidered }.
 * - `current` is the newest observation on the scope entity with
 *   metadata.kind === 'capsule' that is NOT superseded by ANY observation on
 *   that entity. A newer non-capsule append never hides it. A superseding
 *   observation of any kind retires it.
 * - Every other unsuperseded capsule is a conflict (newest first) — a fork
 *   the lane must reconcile, surfaced rather than silently picked.
 * - Unresolved scope under v2 → schemaVersion 2 with an empty capsule block,
 *   never a missing key.
 * - `definition` (immutable founding prose) is untouched and separate.
 * - BUDGETED (review b2641137 blocker 1): under v2 the capsule is a section
 *   ('capsule', ordered right after working) with closed coverage. A capsule
 *   that does not fit is OMITTED with omittedReason=budget and a cursor;
 *   capsule.current is then null and capsule.complete false — never a
 *   silently trimmed bundle claiming completeness. totalTokenEstimate never
 *   exceeds budget.
 * - AUTHORITATIVE (review b2641137 blocker 2): the selector scans the
 *   entity's FULL indexed observation set (paged), so a still-current
 *   capsule behind 500+ newer unrelated rows is still found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CapsuleObservation, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { RESUME_INPUT_SCHEMA, RESUME_OUTPUT_SCHEMA, RESUME_OUTPUT_SCHEMA_V1, RESUME_OUTPUT_SCHEMA_V2 } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { validateEng4Output, Eng4OutputValidationError } from '../src/unified-server/eng4/register.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validInput = ajv.compile(RESUME_INPUT_SCHEMA as any);
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);
const validV1 = ajv.compile(RESUME_OUTPUT_SCHEMA_V1 as any);
const validV2 = ajv.compile(RESUME_OUTPUT_SCHEMA_V2 as any);

const TENANT = 't1';
const cap = (id: string, recordedAt: string): CapsuleObservation => ({
  observationId: id, entityId: 'u-proj', recordedAt, author: 'claude-hythe',
  canonicalFact: `pointer ${id}`, contents: [`capsule ${id}`],
});

const makeDirectory = (capsules: CapsuleObservation[], candidatesConsidered = capsules.length): ResumeDirectory => ({
  resolveEntityCandidatesExact: (name) =>
    name === 'Proj' ? [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }] : [],
  resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
  getEntityDefinition: (id) => (id === 'u-proj' ? 'FOUNDING CAPSULE 2026-08-07 (immutable, stale)' : null),
  getCapsuleObservations: (id) => (id === 'u-proj' ? { capsules, candidatesConsidered } : { capsules: [], candidatesConsidered: 0 }),
});

const freshDb = () => {
  const db = new Database(':memory:');
  // Fixture-fidelity: mirror the real message/handoff tables resume reads.
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
const state: WorkingState = { objective: 'o', status: 's', owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [] };
const seed = (db: any, directory: ResumeDirectory) =>
  performCheckpoint(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, expectedRevision: null, idempotencyKey: 'k-seed-001', state });
const v1Coverage = (db: any, directory: ResumeDirectory) => resume(db, directory).coverage;
const resume = (db: any, directory: ResumeDirectory, over: Record<string, unknown> = {}) =>
  performResume(db, directory, TENANT, { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 4000, ...over } as any) as any;

describe('resume capsule — frozen v1 default', () => {
  it('a legacy request (no resultVersion) returns schemaVersion 1 with NO capsule key', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T00:00:00Z')]);
    seed(db, directory);
    const bundle = resume(db, directory);
    expect(bundle.schemaVersion).toBe(1);
    expect('capsule' in bundle).toBe(false);
    expect(bundle.definition).toBe('FOUNDING CAPSULE 2026-08-07 (immutable, stale)');
    expect(validV1(bundle), ajv.errorsText(validV1.errors)).toBe(true);
  });

  it('resultVersion: 1 is the same as omitting it', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T00:00:00Z')]);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 1 });
    expect(bundle.schemaVersion).toBe(1);
    expect('capsule' in bundle).toBe(false);
  });

  it('input schema: resultVersion accepts 1, 2 or 3 (3 = ENG-4 H-series internal bundle) and is optional', () => {
    const base = { agentId: 'a', scope: { project: 'Proj' }, budget: 1024 };
    expect(validInput(base)).toBe(true);
    expect(validInput({ ...base, resultVersion: 2 })).toBe(true);
    expect(validInput({ ...base, resultVersion: 3 })).toBe(true);
    expect(validInput({ ...base, resultVersion: 4 })).toBe(false);
    expect(validInput({ ...base, resultVersion: '2' })).toBe(false);
  });
});

describe('resume capsule — resultVersion=2 (injected directory)', () => {
  it('returns schemaVersion 2 with capsule.current = the directory\'s first (newest) unsuperseded capsule and the rest as conflicts', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('newest', '2026-09-03T02:00:00Z'), cap('older-fork', '2026-09-03T01:00:00Z')], 7);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 2 });
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.capsule.current.observationId).toBe('newest');
    expect(bundle.capsule.conflicts.map((c: any) => c.observationId)).toEqual(['older-fork']);
    expect(bundle.capsule.candidatesConsidered).toBe(7);
    expect(bundle.capsule.complete).toBe(true);
    expect(bundle.coverage.capsule).toMatchObject({ includedCount: 2, totalCount: 2, contentComplete: true, omittedReason: 'none', nextCursor: null });
    expect('capsule' in v1Coverage(db, directory)).toBe(false);
    expect(bundle.definition).toBe('FOUNDING CAPSULE 2026-08-07 (immutable, stale)'); // separate, untouched
    expect(validV2(bundle), ajv.errorsText(validV2.errors)).toBe(true);
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
  });

  it('no capsule on the entity → current null, conflicts empty, key still present', () => {
    const db = freshDb();
    const directory = makeDirectory([], 3);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 2 });
    expect(bundle.capsule).toEqual({ current: null, conflicts: [], candidatesConsidered: 3, complete: true });
    expect(bundle.coverage.capsule).toMatchObject({ includedCount: 0, totalCount: 0, contentComplete: true, omittedReason: 'none' });
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
  });

  it('unresolved scope under v2 → schemaVersion 2 with an EMPTY capsule block (never a missing key)', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T00:00:00Z')]);
    const bundle = resume(db, directory, { resultVersion: 2, scope: { project: 'Nope' } });
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.resolvedScope.scopeKey).toBeNull();
    expect(bundle.capsule).toEqual({ current: null, conflicts: [], candidatesConsidered: 0, complete: true });
    expect(bundle.coverage.capsule).toMatchObject({ includedCount: 0, totalCount: 0, contentComplete: true });
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
  });

  it('output schema: v1 rejects a capsule key; v2 requires it; the combined schema accepts exactly one shape', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T00:00:00Z')]);
    seed(db, directory);
    const v1 = resume(db, directory);
    const v2 = resume(db, directory, { resultVersion: 2 });
    expect(validBundle(v1)).toBe(true);
    expect(validBundle(v2)).toBe(true);
    expect(validV1({ ...v1, capsule: v2.capsule })).toBe(false);
    const { capsule: _dropped, ...v2WithoutCapsule } = v2;
    expect(validV2(v2WithoutCapsule)).toBe(false);
    expect(validBundle({ ...v1, schemaVersion: 2 })).toBe(false); // v2 without capsule
    expect(validBundle({ ...v2, schemaVersion: 1 })).toBe(false); // v1 with capsule
    expect(() => validateEng4Output('resume', { ...v1, schemaVersion: 2 })).toThrow(Eng4OutputValidationError);
  });
});

describe('resume capsule — budget, cursor and section accounting (review b2641137 blocker 1)', () => {
  const big = (id: string, recordedAt: string): CapsuleObservation => ({ ...cap(id, recordedAt), contents: ['x'.repeat(20_000)] });

  it('REPRO: a 20,000-char capsule under budget=256 is OMITTED with closed coverage — current null, complete false, cursor present, bundle within budget', () => {
    const db = freshDb();
    const directory = makeDirectory([big('huge', '2026-09-03T02:00:00Z')]);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 2, budget: 256 });
    expect(bundle.capsule.current).toBeNull();
    expect(bundle.capsule.conflicts).toEqual([]);
    expect(bundle.capsule.complete).toBe(false);
    expect(bundle.coverage.capsule).toMatchObject({ includedCount: 0, totalCount: 1, contentComplete: false, omittedReason: 'budget' });
    expect(bundle.coverage.capsule.nextCursor).toEqual(expect.any(String));
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(256);
    expect(JSON.stringify(bundle).length).toBeLessThan(5_000);
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
  });

  it('with a sufficient budget the same capsule is delivered complete', () => {
    const db = freshDb();
    const directory = makeDirectory([big('huge', '2026-09-03T02:00:00Z')]);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 2, budget: 20_000 });
    expect(bundle.capsule.current.observationId).toBe('huge');
    expect(bundle.capsule.complete).toBe(true);
    expect(bundle.coverage.capsule.contentComplete).toBe(true);
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(20_000);
  });

  it('budget cut inside the capsule section: current delivered, conflict deferred to the cursor page (never silently dropped)', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('current', '2026-09-03T02:00:00Z'), big('fork', '2026-09-03T01:00:00Z')]);
    seed(db, directory);
    const first = resume(db, directory, { resultVersion: 2, budget: 400 });
    expect(first.capsule.current.observationId).toBe('current');
    expect(first.capsule.conflicts).toEqual([]);
    expect(first.capsule.complete).toBe(false);
    expect(first.coverage.capsule).toMatchObject({ includedCount: 1, totalCount: 2, contentComplete: false, omittedReason: 'budget' });
    const cursor = first.coverage.capsule.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = resume(db, directory, { resultVersion: 2, budget: 20_000, cursor });
    expect(second.capsule.current).toBeNull(); // delivered on the earlier page — accounted, not repeated
    expect(second.capsule.conflicts.map((c: any) => c.observationId)).toEqual(['fork']);
    expect(second.capsule.complete).toBe(false);
    expect(second.coverage.capsule).toMatchObject({ includedCount: 1, totalCount: 2 });
    expect(second.coverage.working.omittedReason).toBe('cursor');
  });

  it('sections filter: resultVersion=2 with sections:["capsule"] delivers only the capsule; the rest are accounted as not-requested', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T02:00:00Z')]);
    seed(db, directory);
    const bundle = resume(db, directory, { resultVersion: 2, sections: ['capsule'] });
    expect(bundle.capsule.current.observationId).toBe('c1');
    expect(bundle.working).toBeNull();
    expect(bundle.coverage.working.omittedReason).toBe('not-requested');
    expect(bundle.coverage.capsule.contentComplete).toBe(true);
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
  });

  it('v1 ignores the capsule section entirely: no capsule coverage, and a v2 capsule cursor is rejected as malformed under v1', () => {
    const db = freshDb();
    const directory = makeDirectory([cap('c1', '2026-09-03T02:00:00Z')]);
    seed(db, directory);
    const v1 = resume(db, directory, { sections: ['working', 'capsule'] });
    expect(v1.schemaVersion).toBe(1);
    expect('capsule' in v1.coverage).toBe(false);
    const cursorIntoCapsule = Buffer.from(JSON.stringify({ s: 'capsule', o: 0 }), 'utf8').toString('base64url');
    expect(() => resume(db, directory, { cursor: cursorIntoCapsule })).toThrow(/malformed resume cursor/);
    expect(() => resume(db, directory, { resultVersion: 2, cursor: cursorIntoCapsule })).not.toThrow();
  });
});

describe('resume capsule — REAL store selection by kind (the audit repro)', () => {
  let manager: any;
  const ENTITY_ID = 'u-capsule-proj';
  const insertObs = (id: string, createdAt: string, kind: string | null, supersedes: string[] = []) =>
    manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags, created_at)
       VALUES (?, 'default', 'observation', ?, 'claude-hythe', '[]', ?)`
    ).run(id, JSON.stringify({
      entityName: 'capsule-proj',
      contents: [`${kind ?? 'plain'} ${id}`],
      addedBy: 'claude-hythe',
      timestamp: createdAt,
      metadata: { ...(kind ? { kind } : {}), ...(supersedes.length ? { supersedes } : {}), ...(kind === 'capsule' ? { canonicalFact: `pointer ${id}` } : {}) },
    }), createdAt);

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, 'default', 'entity', ?, 'claude-hythe', '[]')`
    ).run(ENTITY_ID, JSON.stringify({ name: 'capsule-proj', type: 'project', observations: ['FOUNDING definition prose'] }));
    // A: first capsule. B: capsule superseding A. C: unrelated NEWEST finding.
    insertObs('obs-A', '2026-09-01T00:00:00Z', 'capsule');
    insertObs('obs-B', '2026-09-02T00:00:00Z', 'capsule', ['obs-A']);
    insertObs('obs-C', '2026-09-03T00:00:00Z', 'finding');
    manager.rebuildGraphLookupIndex();
  });

  afterAll(async () => { await manager.close(); });

  it('REPRO: get_current_observation returns the unrelated newest finding — the capsule is displaced', () => {
    const cur = manager.getCurrentObservation('capsule-proj', 'default');
    expect(cur.current.id).toBe('obs-C');
    expect(cur.current.kind).toBe('finding');
  });

  it('FIX: getCapsuleObservations selects B by kind (A superseded, C ignored); resume v2 surfaces it separately from definition', () => {
    const sel = manager.getCapsuleObservations(ENTITY_ID, 'default');
    expect(sel.capsules.map((c: any) => c.observationId)).toEqual(['obs-B']);
    expect(sel.candidatesConsidered).toBe(3);

    const db = manager.getDb();
    performCheckpoint(db, manager, 'default', {
      agentId: 'claude-hythe', scope: { project: 'capsule-proj' }, expectedRevision: null, idempotencyKey: 'k-capsule-01', state,
    });
    const bundle = performResume(db, manager, 'default', {
      agentId: 'claude-hythe', scope: { project: 'capsule-proj' }, budget: 4000, resultVersion: 2,
    } as any) as any;
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.capsule.current).toEqual({
      observationId: 'obs-B', entityId: ENTITY_ID, recordedAt: '2026-09-02T00:00:00Z', author: 'claude-hythe',
      canonicalFact: 'pointer obs-B', contents: ['capsule obs-B'],
    });
    expect(bundle.capsule.conflicts).toEqual([]);
    expect(bundle.definition).toBe('FOUNDING definition prose');
    expect(() => validateEng4Output('resume', bundle)).not.toThrow();
    // v1 on the same store is unchanged: no capsule key.
    const v1 = performResume(db, manager, 'default', { agentId: 'claude-hythe', scope: { project: 'capsule-proj' }, budget: 4000 }) as any;
    expect(v1.schemaVersion).toBe(1);
    expect('capsule' in v1).toBe(false);
  });

  it('a second unsuperseded capsule is a CONFLICT (newest current, other listed), never silently dropped', () => {
    insertObs('obs-D', '2026-09-04T00:00:00Z', 'capsule'); // does not supersede B
    manager.rebuildGraphLookupIndex();
    const sel = manager.getCapsuleObservations(ENTITY_ID, 'default');
    expect(sel.capsules.map((c: any) => c.observationId)).toEqual(['obs-D', 'obs-B']);
    const bundle = performResume(manager.getDb(), manager, 'default', {
      agentId: 'claude-hythe', scope: { project: 'capsule-proj' }, budget: 4000, resultVersion: 2,
    } as any) as any;
    expect(bundle.capsule.current.observationId).toBe('obs-D');
    expect(bundle.capsule.conflicts.map((c: any) => c.observationId)).toEqual(['obs-B']);
  });

  it('a superseding observation of ANOTHER kind still retires a capsule (supersession is entity-wide)', () => {
    insertObs('obs-E', '2026-09-05T00:00:00Z', 'handoff', ['obs-D']);
    manager.rebuildGraphLookupIndex();
    const sel = manager.getCapsuleObservations(ENTITY_ID, 'default');
    expect(sel.capsules.map((c: any) => c.observationId)).toEqual(['obs-B']);
    expect(sel.candidatesConsidered).toBe(5);
  });

  it('REPRO (review b2641137 blocker 2): a still-current capsule behind 600 newer unrelated findings is STILL selected (full paged scan)', () => {
    const insertMany = manager.getDb().transaction(() => {
      for (let i = 0; i < 600; i++) {
        insertObs(`obs-noise-${String(i).padStart(3, '0')}`, `2026-09-06T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'finding');
      }
    });
    insertMany();
    manager.rebuildGraphLookupIndex();
    const sel = manager.getCapsuleObservations(ENTITY_ID, 'default');
    expect(sel.capsules.map((c: any) => c.observationId)).toEqual(['obs-B']);
    expect(sel.candidatesConsidered).toBe(605);
    const bundle = performResume(manager.getDb(), manager, 'default', {
      agentId: 'claude-hythe', scope: { project: 'capsule-proj' }, budget: 4000, resultVersion: 2,
    } as any) as any;
    expect(bundle.capsule.current.observationId).toBe('obs-B');
    expect(bundle.capsule.complete).toBe(true);
    expect(bundle.capsule.candidatesConsidered).toBe(605);
  });

  it('unknown entity id → empty selection, zero candidates', () => {
    expect(manager.getCapsuleObservations('no-such-entity', 'default')).toEqual({ capsules: [], candidatesConsidered: 0 });
  });
});
