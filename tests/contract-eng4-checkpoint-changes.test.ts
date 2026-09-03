/**
 * ENG-4 — checkpoint returns the IDs it materializes (PR A of the
 * 2026-09-03 field-report response; codex-hythe review b8456917 finding 4:
 * "cheapest first slice = created factIds/loopIds only").
 *
 * CONTRACT (additive to the frozen written / idempotent-replay results):
 * - `changes.facts[i]` corresponds POSITIONALLY to `factChanges[i]`, and
 *   `changes.loops[i]` to `loopChanges[i]`. Each entry carries the row id
 *   the change materialized to and whether the row was CREATED by this
 *   checkpoint (false = an existing id was updated in place).
 * - A checkpoint with no changes reports empty arrays, never null.
 * - idempotent-replay returns the SAME `changes` the original write did,
 *   from a per-snapshot ledger (eng4_snapshot_changes) written in the same
 *   transaction — never recomputed, never guessed.
 * - A snapshot recorded BEFORE the ledger existed cannot answer: replay
 *   reports `changes: null` when the persisted envelope carried changes and
 *   empty arrays when it did not. Honest, not invented.
 * - conflict / idempotency-mismatch never carry `changes` (nothing was
 *   materialized).
 * - Request fingerprint and content hash are UNTOUCHED: the ledger is a
 *   result-side record, not part of the canonical envelope.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { CHECKPOINT_OUTPUT_SCHEMA } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointChangeError } from '../src/unified-server/eng4/checkpoint.js';
import type { EntityDirectory } from '../src/unified-server/eng4/resolver.js';
import { validateEng4Output, Eng4OutputValidationError } from '../src/unified-server/eng4/register.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validCheckpointResult = ajv.compile(CHECKPOINT_OUTPUT_SCHEMA as any);

const TENANT = 't1';
const directory: EntityDirectory = {
  resolveEntityCandidatesExact: (name) =>
    name === 'Proj' ? [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }] : [],
  resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
};

const freshDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_messages (id TEXT PRIMARY KEY, content TEXT)`);
  applyEng4Schema(db);
  return db;
};

const state = (status: string): WorkingState => ({
  objective: 'ship PR A', status, owner: 'claude-hythe',
  nextActions: ['review'], blockers: [], guardrails: ['no-live-writes'],
});
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe',
  scope: { project: 'Proj' },
  expectedRevision: null,
  idempotencyKey: 'k-default',
  state: state('working'),
  ...over,
});
const fact = (subject: string, over: Partial<FactChange> = {}): FactChange => ({
  assertion: { subject, predicate: 'p', object: 'o' },
  status: 'asserted',
  evidenceRefs: ['ev'],
  sourceRefs: ['src'],
  ...over,
});
const ledgerRows = (db: any, stateId: string) =>
  db.prepare(`SELECT kind, ordinal, change_id, created FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=? ORDER BY kind, ordinal`)
    .all(TENANT, stateId);

describe('ENG-4 PR A — checkpoint returns materialized change IDs', () => {
  it('written: one positional entry per factChange/loopChange, carrying the materialized row id and created=true', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp({
      factChanges: [fact('alpha'), fact('beta')],
      loopChanges: [{ status: 'open', nextAction: 'first' }, { status: 'open', nextAction: 'second' }],
    })) as any;
    expect(res.outcome).toBe('written');
    expect(res.changes.facts).toHaveLength(2);
    expect(res.changes.loops).toHaveLength(2);
    for (const entry of res.changes.facts) {
      expect(typeof entry.factId).toBe('string');
      expect(entry.created).toBe(true);
    }
    for (const entry of res.changes.loops) {
      expect(typeof entry.loopId).toBe('string');
      expect(entry.created).toBe(true);
    }
    expect(new Set(res.changes.facts.map((f: any) => f.factId)).size).toBe(2);
    // Positional: entry i is the row materialized from change i.
    const subjectOf = (id: string) =>
      (db.prepare(`SELECT subject FROM eng4_facts WHERE tenant_id=? AND fact_id=?`).get(TENANT, id) as any).subject;
    expect(subjectOf(res.changes.facts[0].factId)).toBe('alpha');
    expect(subjectOf(res.changes.facts[1].factId)).toBe('beta');
    const actionOf = (id: string) =>
      (db.prepare(`SELECT next_action FROM eng4_open_loops WHERE tenant_id=? AND loop_id=?`).get(TENANT, id) as any).next_action;
    expect(actionOf(res.changes.loops[0].loopId)).toBe('first');
    expect(actionOf(res.changes.loops[1].loopId)).toBe('second');
    // Ledger rows exist for the snapshot, in the same transaction.
    expect(ledgerRows(db, res.stateId)).toEqual([
      { kind: 'fact', ordinal: 0, change_id: res.changes.facts[0].factId, created: 1 },
      { kind: 'fact', ordinal: 1, change_id: res.changes.facts[1].factId, created: 1 },
      { kind: 'loop', ordinal: 0, change_id: res.changes.loops[0].loopId, created: 1 },
      { kind: 'loop', ordinal: 1, change_id: res.changes.loops[1].loopId, created: 1 },
    ]);
  });

  it('written with no changes reports empty arrays, never null', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp()) as any;
    expect(res.changes).toEqual({ facts: [], loops: [] });
    expect(ledgerRows(db, res.stateId)).toEqual([]);
  });

  it('updating an existing fact/loop echoes the given id with created=false; mixed with a new change the ordinals hold', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp({
      factChanges: [fact('alpha')],
      loopChanges: [{ status: 'open', nextAction: 'first' }],
    })) as any;
    const factId = first.changes.facts[0].factId;
    const loopId = first.changes.loops[0].loopId;
    const second = performCheckpoint(db, directory, TENANT, cp({
      expectedRevision: 1, idempotencyKey: 'k-2',
      factChanges: [fact('gamma'), fact('alpha', { factId, status: 'verified' })],
      loopChanges: [{ loopId, status: 'blocked', nextAction: 'wait', blockedOn: 'review' }, { status: 'open', nextAction: 'new' }],
    })) as any;
    expect(second.changes.facts[0].created).toBe(true);
    expect(second.changes.facts[1]).toEqual({ factId, created: false });
    expect(second.changes.loops[0]).toEqual({ loopId, created: false });
    expect(second.changes.loops[1].created).toBe(true);
    expect(second.changes.loops[1].loopId).not.toBe(loopId);
  });

  it('idempotent-replay returns the SAME changes as the original write, from the ledger', () => {
    const db = freshDb();
    const params = cp({
      factChanges: [fact('alpha'), fact('beta')],
      loopChanges: [{ status: 'open', nextAction: 'first' }],
    });
    const original = performCheckpoint(db, directory, TENANT, params) as any;
    const replay = performCheckpoint(db, directory, TENANT, params) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.stateId).toBe(original.stateId);
    expect(replay.changes).toEqual(original.changes);
  });

  it('a failed change rolls back the ledger with everything else', () => {
    const db = freshDb();
    expect(() => performCheckpoint(db, directory, TENANT, cp({
      factChanges: [fact('alpha'), fact('nope', { factId: 'does-not-exist' })],
    }))).toThrow(CheckpointChangeError);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_snapshot_changes`).get() as any).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_facts`).get() as any).n).toBe(0);
  });

  it('replay of a pre-ledger snapshot: null when the envelope carried changes, empty when it did not', () => {
    const db = freshDb();
    const withChanges = cp({ factChanges: [fact('alpha')] });
    const written = performCheckpoint(db, directory, TENANT, withChanges) as any;
    // Simulate a snapshot recorded before the ledger existed.
    db.prepare(`DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`).run(TENANT, written.stateId);
    const replay = performCheckpoint(db, directory, TENANT, withChanges) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.changes).toBeNull();

    const without = cp({ expectedRevision: 1, idempotencyKey: 'k-2' });
    performCheckpoint(db, directory, TENANT, without);
    const replayEmpty = performCheckpoint(db, directory, TENANT, without) as any;
    expect(replayEmpty.outcome).toBe('idempotent-replay');
    expect(replayEmpty.changes).toEqual({ facts: [], loops: [] });
  });

  it('output schema: written and idempotent-replay REQUIRE changes (object or null on replay); conflict and mismatch must NOT carry it', () => {
    const base = { stateId: 's1', scopeKey: 'p:u-proj', revision: 1, contentHash: 'h' };
    const changes = { facts: [{ factId: 'f1', created: true }], loops: [{ loopId: 'l1', created: false }] };
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes })).toBe(true);
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null })).toBe(false);
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes: null })).toBe(false);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base, changes })).toBe(true);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base, changes: null })).toBe(true);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base })).toBe(false);
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes: { facts: [{ factId: 'f1' }], loops: [] } })).toBe(false);
    expect(validCheckpointResult({ outcome: 'conflict', heads: [{ stateId: 's1', revision: 1, author: 'a', recordedAt: 't' }], changes })).toBe(false);
    expect(validCheckpointResult({ outcome: 'idempotency-mismatch', stateId: 's1', expectedRequestFingerprint: 'a', receivedRequestFingerprint: 'b', changes })).toBe(false);
  });

  it('every runtime outcome validates against the output schema through the handler validator', () => {
    const db = freshDb();
    const params = cp({ factChanges: [fact('alpha')], loopChanges: [{ status: 'open', nextAction: 'x' }] });
    const results = [
      performCheckpoint(db, directory, TENANT, params),                                                     // written
      performCheckpoint(db, directory, TENANT, params),                                                     // idempotent-replay
      performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-2' })),         // written, no changes
      performCheckpoint(db, directory, TENANT, cp({ state: state('DIFFERENT') })),                          // idempotency-mismatch
      performCheckpoint(db, directory, TENANT, cp({ idempotencyKey: 'k-3' })),                              // conflict
    ];
    for (const result of results) expect(() => validateEng4Output('checkpoint', result)).not.toThrow();
    expect(() => validateEng4Output('checkpoint', { outcome: 'written', stateId: 's', scopeKey: 'p:u', revision: 1, parentStateId: null, contentHash: 'h' }))
      .toThrow(Eng4OutputValidationError);
  });

  it('the ledger does not participate in the canonical envelope: content hash and fingerprint are unchanged by tracking', () => {
    const db = freshDb();
    const params = cp({ factChanges: [fact('alpha')] });
    const res = performCheckpoint(db, directory, TENANT, params) as any;
    const row = db.prepare(`SELECT content_hash, request_fingerprint FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, res.stateId) as any;
    expect(row.content_hash).toBe(res.contentHash);
    // Deleting ledger rows must not alter what the snapshot resource verifies.
    db.prepare(`DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`).run(TENANT, res.stateId);
    const again = db.prepare(`SELECT content_hash, request_fingerprint FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, res.stateId) as any;
    expect(again).toEqual(row);
  });

  it('DDL: ledger rows require an existing snapshot (FK); one ordinal per kind per snapshot (PK); kind is constrained', () => {
    const db = freshDb();
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES ('t1','ghost','fact',0,'f',1)`
    ).run()).toThrow(/FOREIGN KEY/);
    const res = performCheckpoint(db, directory, TENANT, cp({ factChanges: [fact('alpha')] })) as any;
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES (?, ?, 'fact', 0, 'dup', 1)`
    ).run(TENANT, res.stateId)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES (?, ?, 'other', 5, 'x', 1)`
    ).run(TENANT, res.stateId)).toThrow(/CHECK/);
  });
});
