/**
 * Field report 9ceed35e P1: resume must make pointer-versus-head divergence
 * visible. On bensalem-clean the pointer sat at revision 378 while a branch
 * grew to ~500, and resume returned the old state with no warning.
 *
 * The handlers now append a plain-text notice as content[1] when a scope has
 * forked. These tests build real forks through performCheckpoint, then check:
 * the notice states the lag, head count and the revision that advances
 * current; content[0] and structuredContent are unchanged and still validate
 * against the frozen v1/v2 and final v3 schemas; a linear scope gets no
 * notice; and following the notice's advice actually advances the pointer.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { CheckpointParams, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint } from '../src/unified-server/eng4/checkpoint.js';
import type { ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { handleEng4Tool, validateEng4Output } from '../src/unified-server/eng4/register.js';
import { divergenceNotice, summarizeDivergence } from '../src/unified-server/eng4/divergence.js';

const TENANT = 't1';
const directory: ResumeDirectory = {
  resolveEntityCandidatesExact: (name) =>
    name === 'Proj' ? [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }] : [],
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
  objective: 'P1', status, owner: 'claude-hythe', nextActions: [], blockers: [], guardrails: [],
});
let keySeq = 0;
const write = (db: any, expectedRevision: number | null, status: string, agentId = 'claude-hythe') =>
  performCheckpoint(db, directory, TENANT, {
    agentId,
    scope: { project: 'Proj' },
    expectedRevision,
    idempotencyKey: `k-div-${String(++keySeq).padStart(6, '0')}`,
    state: state(status),
  } as CheckpointParams) as any;

const callResume = (db: any, extra: Record<string, unknown> = {}) =>
  handleEng4Tool('resume', { agentId: 'claude-hythe', scope: { project: 'Proj' }, budget: 4000, ...extra }, {
    db, directory, tenantId: TENANT,
  }) as { content: Array<{ type: 'text'; text: string }>; structuredContent: any };

/**
 * The field shape: root(1) -> a(2) is current; c(3) forks from root and an
 * agent keeps checkpointing on its own branch: c(3) -> c2(4) -> c3(5).
 */
const strandedPointer = (db: any) => {
  write(db, null, 'root');
  const a = write(db, 1, 'a');
  write(db, 1, 'c', 'codex-clean');
  write(db, 3, 'c2', 'codex-clean');
  const c3 = write(db, 4, 'c3', 'codex-clean');
  return { a, c3 };
};

describe('resume divergence notice (field report 9ceed35e P1)', () => {
  it('a linear scope gets no notice: content is exactly the bundle JSON', () => {
    const db = freshDb();
    write(db, null, 'root');
    write(db, 1, 'next');
    const r = callResume(db);
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });

  it('an empty scope gets no notice', () => {
    const r = callResume(freshDb());
    expect(r.content).toHaveLength(1);
  });

  it('a stranded pointer gets a warning with lag, head count, newest author and the advancing revision', () => {
    const db = freshDb();
    const { a, c3 } = strandedPointer(db);
    const r = callResume(db);
    expect(r.structuredContent.asOf.revision).toBe(2); // current is still a(2)
    expect(r.content).toHaveLength(2);
    const notice = r.content[1].text;
    expect(notice).toMatch(/^WARNING \(hythe resume\): the working state above is revision 2/);
    expect(notice).toContain('1 other live head(s); the newest is revision 5 by codex-clean');
    expect(notice).toContain('3 revision(s) ahead');
    expect(notice).toContain(`rev 5 codex-clean ${c3.stateId}; rev 2 claude-hythe ${a.stateId} (current)`);
    expect(notice).toContain('checkpoint with expectedRevision 2');

    const d = summarizeDivergence(r.structuredContent)!;
    expect(d).toMatchObject({ liveHeadCount: 2, currentRevision: 2, revisionLag: 3 });
    expect(d.newest.revision).toBe(5);
  });

  it('content[0] and structuredContent are unchanged and still pass the frozen/final output schemas', () => {
    const db = freshDb();
    strandedPointer(db);
    for (const resultVersion of [1, 2, 3]) {
      const r = callResume(db, { resultVersion });
      expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
      expect(() => validateEng4Output('resume', r.structuredContent)).not.toThrow();
      expect(r.structuredContent).not.toHaveProperty('notice');
      expect(r.content[1].text).toContain('WARNING (hythe resume)');
    }
  });

  it('following the advice advances current, and the warning becomes a note with no lag', () => {
    const db = freshDb();
    strandedPointer(db);
    const advanced = write(db, 2, 'a2 merges what c3 learned');
    const r = callResume(db);
    expect(r.structuredContent.asOf.stateId).toBe(advanced.stateId);
    expect(r.structuredContent.asOf.revision).toBe(6);
    const notice = r.content[1].text;
    expect(notice).toMatch(/^NOTE \(hythe resume\): .* has forked: the working state above is revision 6 \(current\)/);
    expect(notice).not.toMatch(/WARNING|may be stale/);
  });

  it('extending the stray branch never advances current and the lag keeps growing', () => {
    const db = freshDb();
    strandedPointer(db);
    write(db, 5, 'c4', 'codex-clean');
    const r = callResume(db);
    expect(r.structuredContent.asOf.revision).toBe(2);
    expect(r.content[1].text).toContain('4 revision(s) ahead');
  });

  it('no designated current head: the notice says so and does not suggest a revision', () => {
    const notice = divergenceNotice({
      resolvedScope: { scopeKey: 'p:u-proj' },
      asOf: {
        stateId: null,
        revision: null,
        conflicts: [
          { stateId: 's-a', revision: 2, author: 'x', recordedAt: '2026-11-12T00:00:00Z' },
          { stateId: 's-c', revision: 3, author: 'y', recordedAt: '2026-11-12T00:00:01Z' },
        ],
      },
    })!;
    expect(notice).toMatch(/^WARNING \(hythe resume\): p:u-proj has 2 live heads and NO current head is designated/);
    expect(notice).not.toContain('checkpoint with expectedRevision');
  });
});
