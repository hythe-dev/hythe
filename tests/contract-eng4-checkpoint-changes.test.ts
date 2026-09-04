/**
 * ENG-4 — checkpoint returns the IDs it materializes (PR A of the
 * 2026-09-03 field-report response; codex-hythe review b8456917 finding 4;
 * revised per codex-hythe PR #8 review 5e486718 blockers 1 and 2).
 *
 * CONTRACT
 * - The v1 written / idempotent-replay result shapes are FROZEN and remain
 *   the default: a request without `resultVersion` (or with 1) gets exactly
 *   the pre-PR object. `changes` never appears on it.
 * - `resultVersion: 2` opts in: written and replay additionally carry
 *   `changes.facts[i]` / `changes.loops[i]`, POSITIONAL to `factChanges[i]`
 *   / `loopChanges[i]`, each {id, created}. Empty arrays when nothing changed.
 * - resultVersion=2 is bound into requestFingerprint (absent/1 is NOT), so
 *   legacy fingerprints are byte-identical and a same-key retry with a
 *   different resultVersion is an idempotency-mismatch.
 * - The ledger (eng4_snapshot_changes + eng4_state_snapshots.changes_hash)
 *   is ALWAYS written in the checkpoint transaction. Replay verifies it
 *   against the hash-verified persisted envelope and FAILS CLOSED
 *   (CheckpointIntegrityError) on any partial, duplicated, mis-ordered, or
 *   altered ledger — never a subset. Verification runs on every replay,
 *   v1 included; the opt-in only decides whether the answer is returned.
 * - "No rows AND no digest" is accepted as a pre-ledger snapshot ONLY on a
 *   matched v1 replay. A matched resultVersion=2 replay is fingerprint-proven
 *   to have been written by the ledger-aware writer, so that state is
 *   erasure/corruption and throws — even for a zero-change write. v2 replay
 *   `changes` is therefore never null.
 * - The ledger is result-side only: canonical envelope and contentHash are
 *   unchanged. conflict / idempotency-mismatch never carry `changes`.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import type { CheckpointParams, FactChange, WorkingState } from '../src/unified-server/eng4/contracts.js';
import { CHECKPOINT_INPUT_SCHEMA, CHECKPOINT_OUTPUT_SCHEMA } from '../src/unified-server/eng4/schemas.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, changesHash, CheckpointChangeError, CheckpointIntegrityError } from '../src/unified-server/eng4/checkpoint.js';
import { requestFingerprint } from '../src/unified-server/eng4/canonical.js';
import type { EntityDirectory } from '../src/unified-server/eng4/resolver.js';
import { validateEng4Output, Eng4OutputValidationError } from '../src/unified-server/eng4/register.js';
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';

const ajv = new Ajv({ allErrors: true, $data: true });
const validCheckpointInput = ajv.compile(CHECKPOINT_INPUT_SCHEMA as any);
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
/** v1 (legacy) request. */
const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
  agentId: 'claude-hythe',
  scope: { project: 'Proj' },
  expectedRevision: null,
  idempotencyKey: 'k-default',
  state: state('working'),
  ...over,
});
/** v2 (opt-in) request. */
const cp2 = (over: Partial<CheckpointParams> = {}): CheckpointParams => cp({ resultVersion: 2, ...over });
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
/**
 * Out-of-band corruption fixture (ENG-4 H1): trg_eng4_snapshots_immutable
 * forbids every snapshot UPDATE except the single digest write, so
 * simulating erasure or alteration must bypass it explicitly — as an out-of-band process
 * with direct database access would. The exact trigger DDL is re-executed
 * afterwards (not the whole schema apply: since H2 that also runs the
 * verified version backfill, which correctly refuses a store whose digest
 * was erased under existing coverage rows — the very corruption we model).
 */
/**
 * Ledger out-of-band modification fixture (ENG-4 H2): coverage rows FK the ledger, so a
 * direct out-of-band write that deletes or re-keys ledger rows must switch FK
 * enforcement off for the modification, as any direct database write would — the
 * digest (not the FK) is what replay verification catches it with.
 */
const modifyLedgerOutOfBand = (db: any, sql: string, ...args: unknown[]) => {
  db.pragma('foreign_keys = OFF');
  try { db.prepare(sql).run(...args); } finally { db.pragma('foreign_keys = ON'); }
};
const IMMUTABLE_TRIGGER_DDL = (DDL_STANDALONE as readonly string[]).find((s) => s.includes('trg_eng4_snapshots_immutable'))!;
const modifySnapshotOutOfBand = (db: any, sql: string, ...args: unknown[]) => {
  db.exec(`DROP TRIGGER trg_eng4_snapshots_immutable`);
  db.prepare(sql).run(...args);
  db.exec(IMMUTABLE_TRIGGER_DDL);
};
const snapRow = (db: any, stateId: string) =>
  db.prepare(`SELECT content_hash, request_fingerprint, changes_hash FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, stateId) as any;

describe('ENG-4 PR A — frozen v1 default', () => {
  it('a legacy request (no resultVersion) returns EXACTLY the pre-PR written shape — no changes key', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp({ factChanges: [fact('alpha')] })) as any;
    expect(Object.keys(res).sort()).toEqual(['contentHash', 'outcome', 'parentStateId', 'revision', 'scopeKey', 'stateId']);
    expect('changes' in res).toBe(false);
    // ...but the ledger was still written, digest-bound.
    expect(ledgerRows(db, res.stateId)).toHaveLength(1);
    expect(snapRow(db, res.stateId).changes_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resultVersion: 1 is the same as omitting it (shape and fingerprint)', () => {
    const db = freshDb();
    const a = performCheckpoint(db, directory, TENANT, cp({ factChanges: [fact('alpha')] })) as any;
    const replay = performCheckpoint(db, directory, TENANT, cp({ resultVersion: 1, factChanges: [fact('alpha')] })) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.stateId).toBe(a.stateId);
    expect('changes' in replay).toBe(false);
  });

  it('legacy fingerprints are byte-identical: requestFingerprint ignores absent/1 and binds 2', () => {
    const base = {
      canonicalAgentId: 'a', scopeKey: 'p:u', expectedRevision: null, resolvedParentStateId: null,
      envelope: { scopeKey: 'p:u', state: state('x'), events: [], factChanges: [], loopChanges: [], evidenceRefs: [] },
    };
    const legacy = requestFingerprint(base);
    expect(requestFingerprint({ ...base, resultVersion: 1 })).toBe(legacy);
    expect(requestFingerprint({ ...base, resultVersion: 2 })).not.toBe(legacy);
  });

  it('same key, different resultVersion → idempotency-mismatch (the opt-in is semantic intent)', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const res = performCheckpoint(db, directory, TENANT, cp2()) as any;
    expect(res.outcome).toBe('idempotency-mismatch');
  });

  it('input schema: resultVersion accepts 1, 2 or 3 (3 = ENG-4 H-series, internal) and is optional', () => {
    const base = cp();
    expect(validCheckpointInput(base)).toBe(true);
    expect(validCheckpointInput({ ...base, resultVersion: 2 })).toBe(true);
    expect(validCheckpointInput({ ...base, resultVersion: 1 })).toBe(true);
    expect(validCheckpointInput({ ...base, resultVersion: 3 })).toBe(true);
    expect(validCheckpointInput({ ...base, resultVersion: 4 })).toBe(false);
    expect(validCheckpointInput({ ...base, resultVersion: '2' })).toBe(false);
  });
});

describe('ENG-4 PR A — resultVersion=2 returns materialized change IDs', () => {
  it('written: one positional entry per factChange/loopChange, carrying the materialized row id and created=true', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp2({
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
    const subjectOf = (id: string) =>
      (db.prepare(`SELECT subject FROM eng4_facts WHERE tenant_id=? AND fact_id=?`).get(TENANT, id) as any).subject;
    expect(subjectOf(res.changes.facts[0].factId)).toBe('alpha');
    expect(subjectOf(res.changes.facts[1].factId)).toBe('beta');
    const actionOf = (id: string) =>
      (db.prepare(`SELECT next_action FROM eng4_open_loops WHERE tenant_id=? AND loop_id=?`).get(TENANT, id) as any).next_action;
    expect(actionOf(res.changes.loops[0].loopId)).toBe('first');
    expect(actionOf(res.changes.loops[1].loopId)).toBe('second');
    expect(ledgerRows(db, res.stateId)).toEqual([
      { kind: 'fact', ordinal: 0, change_id: res.changes.facts[0].factId, created: 1 },
      { kind: 'fact', ordinal: 1, change_id: res.changes.facts[1].factId, created: 1 },
      { kind: 'loop', ordinal: 0, change_id: res.changes.loops[0].loopId, created: 1 },
      { kind: 'loop', ordinal: 1, change_id: res.changes.loops[1].loopId, created: 1 },
    ]);
    expect(snapRow(db, res.stateId).changes_hash).toBe(changesHash(res.changes));
  });

  it('written with no changes reports empty arrays, never null', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp2()) as any;
    expect(res.changes).toEqual({ facts: [], loops: [] });
    expect(ledgerRows(db, res.stateId)).toEqual([]);
    expect(snapRow(db, res.stateId).changes_hash).toBe(changesHash({ facts: [], loops: [] }));
  });

  it('updating an existing fact/loop echoes the given id with created=false; mixed with a new change the ordinals hold', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp2({
      factChanges: [fact('alpha')],
      loopChanges: [{ status: 'open', nextAction: 'first' }],
    })) as any;
    const factId = first.changes.facts[0].factId;
    const loopId = first.changes.loops[0].loopId;
    const second = performCheckpoint(db, directory, TENANT, cp2({
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

  it('idempotent-replay returns the SAME changes as the original write, from the verified ledger', () => {
    const db = freshDb();
    const params = cp2({
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
    expect(() => performCheckpoint(db, directory, TENANT, cp2({
      factChanges: [fact('alpha'), fact('nope', { factId: 'does-not-exist' })],
    }))).toThrow(CheckpointChangeError);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_snapshot_changes`).get() as any).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_facts`).get() as any).n).toBe(0);
  });
});

describe('ENG-4 PR A — ledger integrity fails CLOSED (review 5e486718 blocker 2)', () => {
  const twoFacts = () => cp2({ factChanges: [fact('alpha'), fact('beta')], loopChanges: [{ status: 'open', nextAction: 'x' }] });

  it('REPRO (partial ledger): deleting one row from a multi-change ledger makes replay THROW, never return a subset', () => {
    const db = freshDb();
    const params = twoFacts();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=? AND kind='fact' AND ordinal=1`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(CheckpointIntegrityError);
  });

  it('altered change_id (counts and ordinals intact) fails the digest', () => {
    const db = freshDb();
    const params = twoFacts();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `UPDATE eng4_snapshot_changes SET change_id='inconsistent' WHERE tenant_id=? AND state_id=? AND kind='fact' AND ordinal=0`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/digest mismatch/);
  });

  it('altered created flag fails the digest', () => {
    const db = freshDb();
    const params = twoFacts();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `UPDATE eng4_snapshot_changes SET created=0 WHERE tenant_id=? AND state_id=? AND kind='loop' AND ordinal=0`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/digest mismatch/);
  });

  it('non-contiguous ordinals fail even when the count matches', () => {
    const db = freshDb();
    const params = twoFacts();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `UPDATE eng4_snapshot_changes SET ordinal=7 WHERE tenant_id=? AND state_id=? AND kind='fact' AND ordinal=1`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/not contiguous/);
  });

  it('ledger rows present but stored digest missing fails', () => {
    const db = freshDb();
    const params = twoFacts();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifySnapshotOutOfBand(db, `UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/no stored digest/);
  });

  it('verification runs on v1 replays too: a legacy client never silently replays over a corrupt ledger', () => {
    const db = freshDb();
    const params = cp({ factChanges: [fact('alpha'), fact('beta')] });
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=? AND kind='fact' AND ordinal=1`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(CheckpointIntegrityError);
  });

  it('REPRO (total erasure, v2): no rows AND no digest under a matched resultVersion=2 replay THROWS — envelope carried changes', () => {
    const db = freshDb();
    const params = cp2({ factChanges: [fact('alpha')] });
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    modifyLedgerOutOfBand(db, `DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`, TENANT, written.stateId);
    modifySnapshotOutOfBand(db, `UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(/ledger and digest absent/);
  });

  it('REPRO (total erasure, v2): THROWS even when the envelope carried NO changes (zero-change v2 write still has a digest)', () => {
    const db = freshDb();
    const params = cp2();
    const written = performCheckpoint(db, directory, TENANT, params) as any;
    expect(ledgerRows(db, written.stateId)).toEqual([]);
    modifySnapshotOutOfBand(db, `UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`, TENANT, written.stateId);
    expect(() => performCheckpoint(db, directory, TENANT, params)).toThrow(CheckpointIntegrityError);
  });

  it('matched v1 replay keeps the pre-ledger fallback: no rows AND no digest replays cleanly (with or without envelope changes)', () => {
    const db = freshDb();
    const withChanges = cp({ factChanges: [fact('alpha')] });
    const w1 = performCheckpoint(db, directory, TENANT, withChanges) as any;
    modifyLedgerOutOfBand(db, `DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`, TENANT, w1.stateId);
    modifySnapshotOutOfBand(db, `UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`, TENANT, w1.stateId);
    const r1 = performCheckpoint(db, directory, TENANT, withChanges) as any;
    expect(r1.outcome).toBe('idempotent-replay');
    expect('changes' in r1).toBe(false);

    const without = cp({ expectedRevision: 1, idempotencyKey: 'k-2' });
    const w2 = performCheckpoint(db, directory, TENANT, without) as any;
    modifySnapshotOutOfBand(db, `UPDATE eng4_state_snapshots SET changes_hash=NULL WHERE tenant_id=? AND state_id=?`, TENANT, w2.stateId);
    const r2 = performCheckpoint(db, directory, TENANT, without) as any;
    expect(r2.outcome).toBe('idempotent-replay');
    expect('changes' in r2).toBe(false);
  });

  it('a v1 request can never "upgrade" an old key to v2: the fingerprint mismatches before replay', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp({ factChanges: [fact('alpha')] }));
    const res = performCheckpoint(db, directory, TENANT, cp2({ factChanges: [fact('alpha')] })) as any;
    expect(res.outcome).toBe('idempotency-mismatch');
  });
});

describe('ENG-4 PR A — schema and envelope invariants', () => {
  it('output schema: v1 written/replay have no changes; v2 require a non-null object; conflict/mismatch never carry it', () => {
    const base = { stateId: 's1', scopeKey: 'p:u-proj', revision: 1, contentHash: 'h' };
    const changes = { facts: [{ factId: 'f1', created: true }], loops: [{ loopId: 'l1', created: false }] };
    // v1 (frozen) shapes still validate exactly as before
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null })).toBe(true);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base })).toBe(true);
    // v2 shapes
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes })).toBe(true);
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes: null })).toBe(false);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base, changes })).toBe(true);
    expect(validCheckpointResult({ outcome: 'idempotent-replay', ...base, changes: null })).toBe(false);
    expect(validCheckpointResult({ outcome: 'written', ...base, parentStateId: null, changes: { facts: [{ factId: 'f1' }], loops: [] } })).toBe(false);
    expect(validCheckpointResult({ outcome: 'conflict', heads: [{ stateId: 's1', revision: 1, author: 'a', recordedAt: 't' }], changes })).toBe(false);
    expect(validCheckpointResult({ outcome: 'idempotency-mismatch', stateId: 's1', expectedRequestFingerprint: 'a', receivedRequestFingerprint: 'b', changes })).toBe(false);
  });

  it('every runtime outcome, v1 and v2, validates through the handler validator', () => {
    const db = freshDb();
    const v2 = cp2({ factChanges: [fact('alpha')], loopChanges: [{ status: 'open', nextAction: 'x' }] });
    const v1 = cp({ idempotencyKey: 'k-v1', expectedRevision: 1, factChanges: [fact('beta')] });
    const results = [
      performCheckpoint(db, directory, TENANT, v2),                                                         // written v2
      performCheckpoint(db, directory, TENANT, v2),                                                         // replay v2
      performCheckpoint(db, directory, TENANT, v1),                                                         // written v1
      performCheckpoint(db, directory, TENANT, v1),                                                         // replay v1
      performCheckpoint(db, directory, TENANT, cp2({ state: state('DIFFERENT') })),                         // idempotency-mismatch
      performCheckpoint(db, directory, TENANT, cp2({ idempotencyKey: 'k-3' })),                             // conflict
    ];
    for (const result of results) expect(() => validateEng4Output('checkpoint', result)).not.toThrow();
    expect(() => validateEng4Output('checkpoint', { outcome: 'written', stateId: 's', scopeKey: 'p:u', revision: 1, parentStateId: null, contentHash: 'h', changes: null }))
      .toThrow(Eng4OutputValidationError);
  });

  it('the ledger does not participate in the canonical envelope: contentHash and fingerprint are independent of ledger rows', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp2({ factChanges: [fact('alpha')] })) as any;
    const before = snapRow(db, res.stateId);
    expect(before.content_hash).toBe(res.contentHash);
    modifyLedgerOutOfBand(db, `DELETE FROM eng4_snapshot_changes WHERE tenant_id=? AND state_id=?`, TENANT, res.stateId);
    const after = snapRow(db, res.stateId);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.request_fingerprint).toBe(before.request_fingerprint);
  });

  it('DDL: ledger rows require an existing snapshot (FK); one ordinal per kind per snapshot (PK); kind is constrained; changes_hash column exists', () => {
    const db = freshDb();
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES ('t1','ghost','fact',0,'f',1)`
    ).run()).toThrow(/FOREIGN KEY/);
    const res = performCheckpoint(db, directory, TENANT, cp2({ factChanges: [fact('alpha')] })) as any;
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES (?, ?, 'fact', 0, 'dup', 1)`
    ).run(TENANT, res.stateId)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare(
      `INSERT INTO eng4_snapshot_changes (tenant_id, state_id, kind, ordinal, change_id, created) VALUES (?, ?, 'other', 5, 'x', 1)`
    ).run(TENANT, res.stateId)).toThrow(/CHECK/);
    const cols = db.prepare(`PRAGMA table_info(eng4_state_snapshots)`).all().map((c: any) => c.name);
    expect(cols).toContain('changes_hash');
    // Idempotent re-apply: the guarded ALTER is skipped, not fatal.
    expect(() => applyEng4Schema(db)).not.toThrow();
  });
});
