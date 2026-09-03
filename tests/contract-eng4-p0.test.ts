/**
 * ENG-4 P0 contract tests — resume / checkpoint / history v1.
 *
 * Spec of record: neural entity engram-eng4-spec (frozen 2026-07-15);
 * amended per engram-sol Track B reviews 4179250c and e0d81d4d.
 *
 * Two layers:
 *  - EXECUTABLE NOW: schema invariants (Ajv with $data:true — a RUNTIME
 *    REQUIREMENT for any implementation validating these schemas) and DDL
 *    invariants (better-sqlite3 :memory:), covering every counterexample the
 *    reviews proved: NULL-scope idempotency, scope mismatch/orphans,
 *    incomplete coverage, unverifiable handles, lying byte lengths.
 *  - it.todo: runtime behaviors intentionally absent until the Phase-2
 *    implementation lands. The two legacy live repros are pinned as fixtures
 *    (tests/fixtures/eng4-legacy-repros.json).
 *
 * FROZEN CAS/BRANCH SEMANTICS (review e0d81d4d #1): expectedRevision
 * identifies an EXISTING IMMUTABLE SAME-SCOPE PARENT (liveness not
 * required). Extending any existing parent — stale included — WRITES a
 * branch child with a new globally-unique-per-scope revision; allocation +
 * insert happen in one transaction. outcome=conflict is reserved for a
 * missing/wrong-scope parent, or null when the scope already has snapshots.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ResumeBundle, ResumeParams, CheckpointResult, CheckpointParams, WorkingState } from '../src/unified-server/eng4/contracts.js';
import {
  adaptLegacyBeginSessionArgs,
  RESUME_INPUT_SCHEMA,
  RESUME_OUTPUT_SCHEMA,
  CHECKPOINT_INPUT_SCHEMA,
  CHECKPOINT_OUTPUT_SCHEMA,
  SNAPSHOT_SELECTOR_SCHEMA,
  BEGIN_SESSION_WRAPPER_INPUT_SCHEMA,
  BEGIN_SESSION_DISCOVERY_INPUT_SCHEMA,
} from '../src/unified-server/eng4/schemas.js';
import { canonicalize, canonicalEnvelopeBytes, envelopeContentHash, requestFingerprint } from '../src/unified-server/eng4/canonical.js';
import { applyEng4Schema } from '../src/unified-server/eng4/init.js';
import { performCheckpoint, CheckpointScopeError, CheckpointIntegrityError, CheckpointEmptyScopeError, CheckpointChangeError } from '../src/unified-server/eng4/checkpoint.js';
import { performResume, type ResumeDirectory } from '../src/unified-server/eng4/resume.js';
import { fetchSnapshot, fetchResourceByUri, changesSince, buildSnapshotUri, buildMessageUri, buildHandoffUri, parseEngramUri, ResourceNotFoundError } from '../src/unified-server/eng4/resource.js';
import { ackHandoffs, performBeginSession, performEndSession, HandoffAckError } from '../src/unified-server/eng4/session.js';
import { createHash } from 'node:crypto';
import { resolveScope, deriveScopeKey, type EntityDirectory } from '../src/unified-server/eng4/resolver.js';
// Inert migrations: importing is safe; only direct execution refuses.
import { DDL_STANDALONE } from '../src/migrations/005-eng4-control-plane.mjs';
import { planHandoffBackfill, applyHandoffBackfill } from '../src/migrations/006-handoff-uuid-backfill.mjs';
import { RETAINED_LEGACY_TOOLS, READ_DISCOVERY_TOOLS, RETIRED_TOOLS, ENG4_RESOURCE_TEMPLATES, validateEng4Output, Eng4OutputValidationError } from '../src/unified-server/eng4/register.js';

// $data:true is load-bearing: coverage closedness (included===total when
// complete) is expressed via $data refs. Runtime validators MUST enable it.
const ajv = new Ajv({ allErrors: true, $data: true });
const validResume = ajv.compile(RESUME_INPUT_SCHEMA as any);
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);
const validCheckpoint = ajv.compile(CHECKPOINT_INPUT_SCHEMA as any);
const validCheckpointResult = ajv.compile(CHECKPOINT_OUTPUT_SCHEMA as any);
const validSelector = ajv.compile(SNAPSHOT_SELECTOR_SCHEMA as any);
const validBeginSession = ajv.compile(BEGIN_SESSION_WRAPPER_INPUT_SCHEMA as any);

// --- fixture helpers -------------------------------------------------------

const coverageSection = (over: Record<string, unknown> = {}) => ({
  includedCount: 0,
  totalCount: 0,
  contentComplete: true,
  omittedReason: 'none',
  nextCursor: null,
  tokenEstimate: 0,
  ...over,
});

const fullCoverage = (over: Record<string, unknown> = {}) => ({
  totalTokenEstimate: 0,
  budget: 1024,
  working: coverageSection(),
  openLoops: coverageSection(),
  messages: coverageSection(),
  currentFacts: coverageSection(),
  decisions: coverageSection(),
  evidence: coverageSection(),
  pointers: coverageSection(),
  ...over,
});

const minimalBundle = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  resolvedScope: { projectId: 'u-1', taskId: null, scopeKey: 'p:u-1', aliasesMatched: [] },
  asOf: { assembledAt: 't', stateId: null, revision: null, stateAgeSec: null, stale: true, conflicts: [] },
  definition: null,
  working: null,
  openLoops: [],
  messages: [],
  currentFacts: [],
  decisions: [],
  evidence: [],
  pointers: [],
  coverage: fullCoverage(),
  ...over,
});

// ---------------------------------------------------------------------------
// Executable: schema invariants
// ---------------------------------------------------------------------------

describe('ENG-4 P0 — schema invariants (executable)', () => {
  it('rejects an empty resume scope (at least one of project/task required)', () => {
    expect(validResume({ agentId: 'agent-a', scope: {}, budget: 1024 })).toBe(false);
    expect(validResume({ agentId: 'agent-a', scope: { project: 'engram' }, budget: 1024 })).toBe(true);
    expect(validResume({ agentId: 'agent-a', scope: { task: 'eng4' }, budget: 1024 })).toBe(true);
    expect(validResume({ agentId: 'agent-a', scope: { project: 'engram', task: 'eng4' }, budget: 1024 })).toBe(true);
  });

  it('rejects arbitrary factChanges (fully-typed assertion + status + refs required)', () => {
    const base = {
      agentId: 'agent-a',
      scope: { project: 'engram' },
      expectedRevision: null,
      idempotencyKey: 'k-12345678',
      state: { objective: 'o', status: 's', owner: 'me', nextActions: [], blockers: [], guardrails: [] },
    };
    expect(validCheckpoint({ ...base, factChanges: [{ anything: 'goes' }] })).toBe(false);
    expect(
      validCheckpoint({
        ...base,
        factChanges: [
          {
            assertion: { subject: 'engram', predicate: 'deployedAt', object: 'c2cebccc' },
            status: 'verified',
            evidenceRefs: ['commit:c2cebccc'],
            sourceRefs: ['msg:example'],
          },
        ],
      })
    ).toBe(true);
  });

  it('REPRO FIXED (identity): resume/checkpoint without agentId are rejected', () => {
    // b2e6fc7c #1: under the shared API key, an un-asserted caller is invalid.
    expect(validResume({ scope: { project: 'engram' }, budget: 1024 })).toBe(false);
    expect(
      validCheckpoint({
        scope: { project: 'engram' },
        expectedRevision: null,
        idempotencyKey: 'k-12345678',
        state: { objective: 'o', status: 's', owner: 'me', nextActions: [], blockers: [], guardrails: [] },
      })
    ).toBe(false);
    expect(validResume({ agentId: '', scope: { project: 'engram' }, budget: 1024 })).toBe(false);
  });

  it('agentId respects the platform 100-char bound; begin_session wrapper TARGET schema validates (not yet MCP-registered)', () => {
    // 07b3906e #3: bound asserted ids to the platform convention.
    expect(validResume({ agentId: 'x'.repeat(101), scope: { project: 'engram' }, budget: 1024 })).toBe(false);
    expect(validResume({ agentId: 'x'.repeat(100), scope: { project: 'engram' }, budget: 1024 })).toBe(true);
    for (const invalid of ['agent with spaces', 'agent/other', 'agent\nsmuggled']) {
      expect(validResume({ agentId: invalid, scope: { project: 'engram' }, budget: 1024 }), invalid).toBe(false);
    }
    // 07b3906e #2: the ack path is now schema-visible on the wrapper.
    expect(validBeginSession({ agentId: 'agent-a', scope: { project: 'engram' }, budget: 1024 })).toBe(true);
    expect(validBeginSession({ agentId: 'agent-a', scope: { project: 'engram' }, budget: 1024, ackHandoffIds: ['h1', 'h2'] })).toBe(true);
    expect(validBeginSession({ agentId: 'agent-a', scope: { project: 'engram' }, budget: 1024, ackHandoffIds: [''] })).toBe(false);
    expect(validBeginSession({ agentId: 'agent-a', scope: { project: 'engram' }, budget: 1024, ackHandoffIds: 'h1' })).toBe(false);
    expect(validBeginSession({ agentId: 'agent with spaces', scope: { project: 'engram' }, budget: 1024 })).toBe(false);
  });

  it('RFC 8785 canonicalization: conformance, reorder-invariance, content sensitivity', () => {
    // 07b3906e #4: exact JCS, not "JCS-style".
    // RFC 8785-flavored vectors: key sorting by UTF-16 code units, no whitespace.
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ '\u00e9': 'e-acute', E: 'upper' })).toBe('{"E":"upper","\u00e9":"e-acute"}');
    expect(canonicalize([true, null, 'x', 10])).toBe('[true,null,"x",10]');
    expect(canonicalize({ nested: { z: [1, 2], a: 'b' } })).toBe('{"nested":{"a":"b","z":[1,2]}}');
    // undefined is rejected, never silently dropped (two inputs must not collide).
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/non-finite/);
    // Sparse arrays are JSON-inexpressible and must FAIL CLOSED — Array(1)
    // previously collapsed to "[]", colliding with a real empty array
    // (r3 5957b1b2 #3).
    expect(() => canonicalize(Array(1))).toThrow(/sparse array/);
    expect(() => canonicalize({ a: [1, , 3] })).toThrow(/sparse array/);
    expect(canonicalize([])).toBe('[]');
    // Inherited numeric properties must NOT un-hide holes (sol repro,
    // supplement 6dcf226d): own-property check required.
    try {
      (Array.prototype as any)[0] = 'inherited';
      expect(() => canonicalize(Array(1))).toThrow(/sparse array/);
    } finally {
      delete (Array.prototype as any)[0];
    }
    // Envelope: semantically equivalent reordered objects hash IDENTICALLY...
    const env1 = { scopeKey: 'p:u-1', state: { objective: 'o', status: 's', owner: 'me', nextActions: [], blockers: [], guardrails: [] }, events: [], factChanges: [], loopChanges: [], evidenceRefs: [] };
    const env2 = { evidenceRefs: [], loopChanges: [], factChanges: [], events: [], state: { guardrails: [], blockers: [], nextActions: [], owner: 'me', status: 's', objective: 'o' }, scopeKey: 'p:u-1' } as any;
    expect(envelopeContentHash(env1)).toBe(envelopeContentHash(env2));
    // ...and materially different content hashes DIFFERENTLY (same-key mismatch case).
    const env3 = { ...env1, state: { ...env1.state, objective: 'DIFFERENT' } };
    expect(envelopeContentHash(env3)).not.toBe(envelopeContentHash(env1));
  });

  it('RFC 8785 §3.2.2.2: lone surrogates terminate with an error (values AND keys); valid pairs pass', () => {
    // sol's r3 probe: canonicalize({x:'\uD800'}) must throw, not serialize.
    expect(() => canonicalize({ x: '\uD800' })).toThrow(/lone high surrogate/);
    expect(() => canonicalize({ x: 'ok\uDC00' })).toThrow(/lone low surrogate/);
    expect(() => canonicalize({ '\uDC00': 1 })).toThrow(/lone low surrogate/);
    expect(() => canonicalize(['\uD800abc'])).toThrow(/lone high surrogate/);
    // A valid surrogate PAIR (emoji) canonicalizes fine, as value and as key.
    expect(canonicalize({ x: '\uD83D\uDE00' })).toBe('{"x":"\uD83D\uDE00"}'.replace('\\uD83D\\uDE00', '\uD83D\uDE00'));
    expect(() => canonicalize({ '\uD83D\uDE00': 'emoji key' })).not.toThrow();
    // Control-char escaping is lowercase-hex JSON escaping.
    expect(canonicalize({ a: '\u000f' })).toBe('{"a":"\\u000f"}');
    // Key order is UTF-16 code-unit order — asserted on the canonical STRING
    // (JS Object.keys would re-order integer-like keys and lie about it).
    expect(canonicalize({ '\u20ac': 1, '\r': 2, '1': 3, '\u00f6': 4 })).toBe('{"\\r":2,"1":3,"\u00f6":4,"\u20ac":1}');
  });

  it('requestFingerprint binds canonical author + CAS position + content (5868b61b #3)', () => {
    const envelope = { scopeKey: 'p:u-1', state: { objective: 'o', status: 's', owner: 'me', nextActions: [], blockers: [], guardrails: [] }, events: [], factChanges: [], loopChanges: [], evidenceRefs: [] };
    const base = { canonicalAgentId: 'fable-engram', scopeKey: 'p:u-1', expectedRevision: 3, resolvedParentStateId: 's3', envelope };
    const fp = requestFingerprint(base);
    // Same key/content + DIFFERENT canonical agent => different fingerprint
    // (Agent B can never replay Agent A's write).
    expect(requestFingerprint({ ...base, canonicalAgentId: 'other-agent' })).not.toBe(fp);
    // Same key/content + DIFFERENT expectedRevision/parent => different
    // fingerprint (no replaying the wrong branch).
    expect(requestFingerprint({ ...base, expectedRevision: 4, resolvedParentStateId: 's4' })).not.toBe(fp);
    // An exact principal repeated verbatim fingerprints identically.
    expect(requestFingerprint({ ...base })).toBe(fp);
    // Fingerprint and resource content hash are DISTINCT values by design.
    expect(fp).not.toBe(envelopeContentHash(envelope));
  });

  it('legacy begin_session adapter preserves intent: budget clamp + userId deprecation (r3 5957b1b2 #2)', () => {
    // OMITTED maxTokens preserves the legacy default 4000 (r4 finding:
    // '?? 256' was a silent ~16x budget shrink for omitted-value callers).
    expect(adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p' }).budget).toBe(4000);
    // EXPLICIT maxTokens below the effective minimum is CLAMPED, not rejected — test 1, 255, 256.
    expect(adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p', maxTokens: 1 }).budget).toBe(256);
    expect(adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p', maxTokens: 255 }).budget).toBe(256);
    expect(adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p', maxTokens: 256 }).budget).toBe(256);
    expect(adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p', maxTokens: 2048 }).budget).toBe(2048);
    // userId is surfaced as deprecatedUserId — never silently erased, never a resume input.
    const adapted = adaptLegacyBeginSessionArgs({ agentId: 'a', projectId: 'p', maxTokens: 512, userId: 'u-7' });
    expect(adapted.deprecatedUserId).toBe('u-7');
    const { deprecatedUserId, ...target } = adapted;
    expect(validBeginSession(target)).toBe(true);
    // The target schema still rejects the raw legacy shape — the adapter is required.
    expect(validBeginSession({ agentId: 'a', projectId: 'p', maxTokens: 512, userId: 'u-7' })).toBe(false);
  });

  it('handoff inbox items carry handoffId + ackedByMe; message items require itemType', () => {
    const withItems = (items: unknown[]) => minimalBundle({ messages: items });
    // b2e6fc7c #2: handoff variant is first-class in the messages section.
    expect(
      validBundle(withItems([{ itemType: 'handoff', handoffId: 'h1', from: 'a', recordedAt: 't', ackedByMe: false, body: 'take over X', handle: null }]))
    ).toBe(true);
    // ackedByMe is required — an ack-less handoff is invalid.
    expect(
      validBundle(withItems([{ itemType: 'handoff', handoffId: 'h1', from: 'a', recordedAt: 't', body: 'x', handle: null }]))
    ).toBe(false);
    // Legacy shape without itemType no longer validates.
    expect(
      validBundle(withItems([{ messageId: 'm1', from: 'a', priority: 'normal', recordedAt: 't', body: 'x', handle: null }]))
    ).toBe(false);
  });

  it('checkpoint idempotency-mismatch names what is compared: request fingerprints', () => {
    // r3 5957b1b2 #1: the comparison is the request fingerprint (author +
    // CAS + content) — content hashes may be identical on a mismatch.
    expect(
      validCheckpointResult({ outcome: 'idempotency-mismatch', stateId: 's1', expectedRequestFingerprint: 'aa', receivedRequestFingerprint: 'bb' })
    ).toBe(true);
    expect(validCheckpointResult({ outcome: 'idempotency-mismatch', stateId: 's1' })).toBe(false);
    // The old lying field names no longer validate.
    expect(
      validCheckpointResult({ outcome: 'idempotency-mismatch', stateId: 's1', expectedContentHash: 'aa', receivedContentHash: 'bb' })
    ).toBe(false);
  });

  it('snapshot selector: exactly one of stateId | revision', () => {
    expect(validSelector({ scope: { project: 'engram' }, stateId: 's1', revision: 3 })).toBe(false);
    expect(validSelector({ scope: { project: 'engram' } })).toBe(false);
    expect(validSelector({ scope: { project: 'engram' }, stateId: 's1' })).toBe(true);
    expect(validSelector({ scope: { project: 'engram' }, revision: 3 })).toBe(true);
  });

  it('accepts a single-head conflict; rejects empty heads', () => {
    const oneHead = {
      outcome: 'conflict',
      heads: [{ stateId: 's1', revision: 4, author: 'a', recordedAt: '2026-07-15T00:00:00Z' }],
    };
    expect(validCheckpointResult(oneHead)).toBe(true);
    expect(validCheckpointResult({ outcome: 'conflict', heads: [] })).toBe(false);
  });

  it('message items are body XOR handle', () => {
    const withMsg = (body: unknown, handle: unknown) =>
      minimalBundle({
        messages: [{ itemType: 'message', messageId: 'm1', from: 'a', priority: 'normal', recordedAt: 't', body, handle }],
      });
    expect(validBundle(withMsg('inline text', null))).toBe(true);
    expect(validBundle(withMsg(null, { kind: 'message', uri: 'engram://message/p/agent-a/m1' }))).toBe(true);
    expect(validBundle(withMsg('inline text', { kind: 'message', uri: 'engram://message/p/agent-a/m1' }))).toBe(false);
    expect(validBundle(withMsg(null, null))).toBe(false);
  });

  it('REPRO FIXED (incompleteCoverage): a bundle missing per-section coverage is rejected', () => {
    // sol's probe: only `messages` coverage present — must now be invalid.
    const probe = minimalBundle({
      coverage: { totalTokenEstimate: 0, budget: 1024, messages: coverageSection() },
    });
    expect(validBundle(probe)).toBe(false);
    expect(validBundle(minimalBundle())).toBe(true);
  });

  it('coverage closedness: complete sections must have included==total, reason=none, cursor=null', () => {
    // included != total while claiming complete → invalid ($data check).
    expect(
      validBundle(minimalBundle({ coverage: fullCoverage({ working: coverageSection({ includedCount: 1, totalCount: 2 }) }) }))
    ).toBe(false);
    // complete but a leftover cursor → invalid.
    expect(
      validBundle(minimalBundle({ coverage: fullCoverage({ working: coverageSection({ nextCursor: 'c1' }) }) }))
    ).toBe(false);
    // incomplete requires an explicit non-'none' reason.
    expect(
      validBundle(
        minimalBundle({
          coverage: fullCoverage({
            working: coverageSection({ contentComplete: false, omittedReason: 'none' }),
          }),
        })
      )
    ).toBe(false);
    // not-requested is the sanctioned shape for excluded sections.
    expect(
      validBundle(
        minimalBundle({
          coverage: fullCoverage({
            working: coverageSection({ contentComplete: false, omittedReason: 'not-requested' }),
          }),
        })
      )
    ).toBe(true);
  });

  it('REPRO FIXED (coverage overcount): includedCount can never exceed totalCount, complete OR incomplete', () => {
    // sol's round-2 probe: included=5, total=1, incomplete, reason=budget — was accepted.
    expect(
      validBundle(
        minimalBundle({
          coverage: fullCoverage({
            working: coverageSection({ includedCount: 5, totalCount: 1, contentComplete: false, omittedReason: 'budget' }),
          }),
        })
      )
    ).toBe(false);
    // Sane incomplete section still validates.
    expect(
      validBundle(
        minimalBundle({
          coverage: fullCoverage({
            working: coverageSection({ includedCount: 1, totalCount: 5, contentComplete: false, omittedReason: 'budget', nextCursor: 'c1' }),
          }),
        })
      )
    ).toBe(true);
  });

  it('REPRO FIXED (raw-scope URI): canonical engram:// grammar rejects raw delimiters, accepts encoded', () => {
    const withEvidence = (uri: string) =>
      minimalBundle({
        evidence: [{ kind: 'state-snapshot', uri, contentHash: 'abc', byteLength: 42, mediaType: 'application/json' }],
      });
    // sol's round-2 probe: raw scope delimiter accepted by ^engram:// alone.
    expect(validBundle(withEvidence('engram://snapshot/p:u-1/s1'))).toBe(false);
    expect(validBundle(withEvidence('engram://snapshot/p|u-1/s1'))).toBe(false);
    expect(validBundle(withEvidence('engram://snapshot/p%3Au-1/s1'))).toBe(true);
    expect(validBundle(withEvidence('engram://snapshot'))).toBe(false); // kind alone is not a resource
  });

  it('REPRO FIXED (handleWithoutVerification): snapshot/payload handles require hash+length+mediaType', () => {
    const withEvidence = (handle: unknown) => minimalBundle({ evidence: [handle] });
    expect(withEvidence({ kind: 'state-snapshot', uri: 'engram://snapshot/p%3Au-1/s1' })).toBeTruthy();
    expect(validBundle(withEvidence({ kind: 'state-snapshot', uri: 'engram://snapshot/p%3Au-1/s1' }))).toBe(false);
    expect(
      validBundle(
        withEvidence({
          kind: 'state-snapshot',
          uri: 'engram://snapshot/p%3Au-1/s1',
          contentHash: 'abc',
          byteLength: 42,
          mediaType: 'application/json',
        })
      )
    ).toBe(true);
    // Reference handles (message/observation) stay light but need engram:// uris.
    expect(validBundle(withEvidence({ kind: 'observation', uri: 'engram://observation/o1' }))).toBe(true);
    expect(validBundle(withEvidence({ kind: 'observation', uri: 'eng4://observation/o1' }))).toBe(false);
  });

  it('REPRO FIXED (unresolvedPseudoScope): scopeKey is null for unresolved refs, never synthesized', () => {
    const unresolved = minimalBundle({
      resolvedScope: { projectId: null, taskId: null, scopeKey: null, aliasesMatched: [], ambiguousCandidates: ['a', 'b'] },
    });
    expect(validBundle(unresolved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Executable: DDL invariants (:memory:, PRAGMA foreign_keys=ON via DDL)
// ---------------------------------------------------------------------------

describe('ENG-4 P0 — DDL invariants (executable, :memory:)', () => {
  let db: InstanceType<typeof Database>;

  const insertScope = (tenantId: string, scopeKey: string, projectId: string | null, taskId: string | null) =>
    db
      .prepare(`INSERT INTO eng4_scopes (tenant_id, scope_key, project_id, task_id) VALUES (?, ?, ?, ?)`)
      .run(tenantId, scopeKey, projectId, taskId);

  const insertSnapshot = (row: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO eng4_state_snapshots
         (state_id, tenant_id, scope_key, revision, parent_state_id, content_hash, request_fingerprint, idempotency_key, author, asserted_agent_id, state_json)
         VALUES (@state_id, @tenant_id, @scope_key, @revision, @parent_state_id, @content_hash, @request_fingerprint, @idempotency_key, @author, @asserted_agent_id, @state_json)`
      )
      .run({ tenant_id: 't1', parent_state_id: null, content_hash: 'h', request_fingerprint: 'fp', author: 'test', asserted_agent_id: 'test-cli', state_json: '{}', ...row });

  beforeAll(() => {
    db = new Database(':memory:');
    for (const stmt of DDL_STANDALONE) db.exec(stmt);
    insertScope('t1', 'p:u-1', 'u-1', null);
    insertScope('t1', 'p:u-2', 'u-2', null);
    insertScope('t1', 'p:u-3', 'u-3', null);
  });

  it('REPRO FIXED (mismatchedScopeRows): a scope row with a non-deterministic key is rejected', () => {
    expect(() => insertScope('t1', 'p:wrong', 'actual-uuid', null)).toThrow(/CHECK/);
    expect(() => insertScope('t1', 't:u-9', 'u-9', null)).toThrow(/CHECK/); // p-scope with t-key
    insertScope('t1', 'p:u-4|t:u-5', 'u-4', 'u-5'); // both-form is legal
  });

  it('a scope requires project_id or task_id (CHECK)', () => {
    expect(() => insertScope('t1', 'x', null, null)).toThrow(/CHECK/);
  });

  it('REPRO FIXED: same (scope_key, idempotency_key) cannot insert twice', () => {
    insertSnapshot({ state_id: 's1', scope_key: 'p:u-1', revision: 1, idempotency_key: 'idem-1' });
    expect(() =>
      insertSnapshot({ state_id: 's2', scope_key: 'p:u-1', revision: 2, idempotency_key: 'idem-1' })
    ).toThrow(/UNIQUE/);
    const count = db.prepare(`SELECT COUNT(*) c FROM eng4_state_snapshots WHERE idempotency_key='idem-1'`).get() as any;
    expect(count.c).toBe(1);
  });

  it('revision is unique per scope (deterministic fetch-by-revision)', () => {
    insertSnapshot({ state_id: 's3', scope_key: 'p:u-2', revision: 1, idempotency_key: 'idem-2' });
    expect(() =>
      insertSnapshot({ state_id: 's4', scope_key: 'p:u-2', revision: 1, idempotency_key: 'idem-3' })
    ).toThrow(/UNIQUE/);
    insertSnapshot({ state_id: 's5', scope_key: 'p:u-3', revision: 1, idempotency_key: 'idem-4' });
  });

  it('REPRO FIXED (orphan snapshot): snapshots require an existing scope row (FK)', () => {
    expect(() =>
      insertSnapshot({ state_id: 's9', scope_key: 'p:ghost', revision: 1, idempotency_key: 'idem-9' })
    ).toThrow(/FOREIGN KEY/);
  });

  it('cross-scope parent references are rejected by trigger; same-scope branching is legal', () => {
    expect(() =>
      insertSnapshot({ state_id: 's6', scope_key: 'p:u-1', revision: 5, idempotency_key: 'idem-5', parent_state_id: 's3' })
    ).toThrow(/same tenant and scope_key/);
    // Branch: second child of s3 with a fresh per-scope revision (frozen semantics).
    insertSnapshot({ state_id: 's7', scope_key: 'p:u-2', revision: 2, idempotency_key: 'idem-6', parent_state_id: 's3' });
    insertSnapshot({ state_id: 's8', scope_key: 'p:u-2', revision: 3, idempotency_key: 'idem-7', parent_state_id: 's3' });
  });

  it('REPRO FIXED (orphanFactRows): facts require an existing scope row (FK)', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO eng4_facts (fact_id, tenant_id, scope_key, subject, predicate, object, status, author)
           VALUES ('f0','t1','p:ghost','a','b','c','asserted','test')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
  });

  it('facts control plane: typed assertion + refs side table; contradicts may dangle (documented rule)', () => {
    db.prepare(
      `INSERT INTO eng4_facts (fact_id, tenant_id, scope_key, subject, predicate, object, status, author)
       VALUES ('f1','t1','p:u-1','engram','liveCommit','c2cebccc','verified','test')`
    ).run();
    db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t1','f1','evidence','deploy-log')`).run();
    // Deferred-resolution rule: a contradicts ref may cite a not-yet-present
    // fact; legal at write, surfaced as unresolved at read (never dropped).
    db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t1','f1','contradicts','fact-not-yet-synced')`).run();
    expect(() =>
      db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t1','f1','vibes','x')`).run()
    ).toThrow(/CHECK/);
    // But refs on a NONEXISTENT fact are orphans and rejected.
    expect(() =>
      db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t1','ghost','evidence','x')`).run()
    ).toThrow(/FOREIGN KEY/);
  });

  it('REPRO FIXED (badLengthRows): payload byte_length must equal actual body length', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body)
           VALUES ('t1','h-bad','message','text/plain',999, x'68656c6c6f')`
        )
        .run()
    ).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body)
       VALUES ('t1','h1','message','text/plain; charset=utf-8',5, x'68656c6c6f')`
    ).run();
    const row = db.prepare(`SELECT media_type, byte_length FROM eng4_payloads WHERE content_hash='h1'`).get() as any;
    expect(row.media_type).toContain('text/plain');
    expect(row.byte_length).toBe(5);
  });

  it('TENANT ISOLATION (b2e6fc7c #3): composite keys structurally separate tenants', () => {
    // Same scope_key under a second tenant is a DIFFERENT row — both legal.
    insertScope('t2', 'p:u-1', 'u-1', null);
    // tenant2 snapshot on tenant2's scope with the SAME idempotency key as
    // tenant1's s1 does not collide (uniqueness is tenant-composite).
    insertSnapshot({ state_id: 't2-s1', tenant_id: 't2', scope_key: 'p:u-1', revision: 1, idempotency_key: 'idem-1' });
    // tenant2 CANNOT hang rows off a scope it does not own (composite FK).
    expect(() =>
      insertSnapshot({ state_id: 't2-s2', tenant_id: 't2', scope_key: 'p:u-2', revision: 1, idempotency_key: 'idem-x' })
    ).toThrow(/FOREIGN KEY/);
    // Cross-TENANT parent reference rejected by trigger even on same scope_key.
    expect(() =>
      insertSnapshot({ state_id: 't2-s3', tenant_id: 't2', scope_key: 'p:u-1', revision: 2, idempotency_key: 'idem-y', parent_state_id: 's1' })
    ).toThrow(/same tenant/);
    // Payload hashes are tenant-owned: same hash may exist under both tenants.
    db.prepare(`INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body) VALUES ('t1','h-shared','message','text/plain',5, x'68656c6c6f')`).run();
    db.prepare(`INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body) VALUES ('t2','h-shared','message','text/plain',5, x'68656c6c6f')`).run();
    // Handoff acks are per-tenant AND per-agent.
    db.prepare(`INSERT INTO eng4_handoff_acks (tenant_id, handoff_id, agent_id) VALUES ('t1','h1','agent-a')`).run();
    db.prepare(`INSERT INTO eng4_handoff_acks (tenant_id, handoff_id, agent_id) VALUES ('t2','h1','agent-a')`).run();
    expect(() =>
      db.prepare(`INSERT INTO eng4_handoff_acks (tenant_id, handoff_id, agent_id) VALUES ('t1','h1','agent-a')`).run()
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it('COMPOSITE IDENTITIES (07b3906e #1): identical row IDs coexist across tenants; references stay tenant-local', () => {
    // Tenant2 legally reuses tenant1's stateId under its own tenant.
    insertSnapshot({ state_id: 's1', tenant_id: 't2', scope_key: 'p:u-1', revision: 5, idempotency_key: 'idem-t2-a' });
    // Identical loopId under both tenants.
    db.prepare(`INSERT INTO eng4_open_loops (tenant_id, loop_id, scope_key, owner, status, next_action) VALUES ('t1','L1','p:u-1','me','open','act')`).run();
    db.prepare(`INSERT INTO eng4_open_loops (tenant_id, loop_id, scope_key, owner, status, next_action) VALUES ('t2','L1','p:u-1','me','open','act')`).run();
    // Identical factId under both tenants; fact_refs are tenant-composite.
    db.prepare(`INSERT INTO eng4_facts (fact_id, tenant_id, scope_key, subject, predicate, object, status, author) VALUES ('F1','t1','p:u-1','a','b','c','asserted','x')`).run();
    db.prepare(`INSERT INTO eng4_facts (fact_id, tenant_id, scope_key, subject, predicate, object, status, author) VALUES ('F1','t2','p:u-1','a','b','c','asserted','x')`).run();
    db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t1','F1','evidence','e1')`).run();
    // A ref under tenant2 pointing at a fact that exists only under tenant1 fails.
    expect(() =>
      db.prepare(`INSERT INTO eng4_fact_refs (tenant_id, fact_id, ref_kind, ref) VALUES ('t2','F-only-t1','evidence','e1')`).run()
    ).toThrow(/FOREIGN KEY/);
    // Parent references are tenant-local: t2's snapshot cannot parent t1's s1
    // even with the identical state_id string — composite FK resolves within t2.
    insertSnapshot({ state_id: 's-child', tenant_id: 't2', scope_key: 'p:u-1', revision: 6, idempotency_key: 'idem-t2-b', parent_state_id: 's1' });
    const parentScope = db.prepare(`SELECT scope_key FROM eng4_state_snapshots WHERE tenant_id='t2' AND state_id='s1'`).get() as any;
    expect(parentScope.scope_key).toBe('p:u-1');
  });

  it("REPRO FIXED (TEXT bypass): payload body must be typeof 'blob' — the 'é' char-vs-byte trick is rejected", () => {
    // sol's round-2 probe: TEXT 'é' has length()=1 (chars) but 2 UTF-8 bytes;
    // type affinity let it into the BLOB column and satisfy the length CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body)
           VALUES ('t1','h-text','message','text/plain',1, 'é')`
        )
        .run()
    ).toThrow(/CHECK/);
    // The same content as a real 2-byte BLOB with the true byte count is legal.
    db.prepare(
      `INSERT INTO eng4_payloads (tenant_id, content_hash, kind, media_type, byte_length, body)
       VALUES ('t1','h-blob','message','text/plain; charset=utf-8',2, x'c3a9')`
    ).run();
    const row = db.prepare(`SELECT typeof(body) t, byte_length FROM eng4_payloads WHERE content_hash='h-blob'`).get() as any;
    expect(row.t).toBe('blob');
    expect(row.byte_length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Executable: legacy repro fixtures are pinned (evidence cannot drift)
// ---------------------------------------------------------------------------

describe('ENG-4 2(a) — schema init boundary (executable)', () => {
  const freshDb = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE ai_messages (id TEXT PRIMARY KEY, content TEXT)`);
    return db;
  };

  it('applies the eng4 schema with per-connection FK enforcement ON (pragma outside the transaction)', () => {
    const db = freshDb();
    const result = applyEng4Schema(db);
    expect(result.statementsApplied).toBeGreaterThan(10);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'eng4_%' ORDER BY name`).all().map((r: any) => r.name);
    expect(tables).toEqual(['eng4_fact_refs', 'eng4_fact_versions', 'eng4_facts', 'eng4_handoff_acks', 'eng4_loop_versions', 'eng4_open_loops', 'eng4_payloads', 'eng4_scope_current', 'eng4_scopes', 'eng4_snapshot_changes', 'eng4_state_snapshots', 'eng4_version_coverage']);
  });

  it('is idempotent across restarts: a second apply is a no-op (ALTERs guarded)', () => {
    const db = freshDb();
    applyEng4Schema(db);
    const second = applyEng4Schema(db);
    expect(second.alterSkippedAsExisting).toBe(4); // 3 ai_messages ALTERs + eng4_state_snapshots.changes_hash (PR A); // the three ai_messages columns already exist
    // Columns exist exactly once.
    const cols = db.prepare(`PRAGMA table_info(ai_messages)`).all().map((r: any) => r.name);
    expect(cols.filter((c: string) => c === 'project_id')).toHaveLength(1);
  });

  it('a forced mid-apply failure rolls back atomically — no partial schema', () => {
    const db = freshDb();
    expect(() =>
      applyEng4Schema(db, ['CREATE TABLE t_probe (x TEXT)', 'THIS IS NOT VALID SQL'])
    ).toThrow();
    const probe = db.prepare(`SELECT name FROM sqlite_master WHERE name='t_probe'`).get();
    expect(probe).toBeUndefined();
  });
});

describe('ENG-4 2(a) — exact scope resolver (executable, injected directory)', () => {
  const directory = (rows: Record<string, Array<{ id: string; name: string; matchedBy: 'canonical_name' | 'alias' }>>): EntityDirectory => ({
    resolveEntityCandidatesExact: (name) => rows[name] ?? [],
    resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
  });

  it('resolves a canonical project name to a stable entity UUID and a deterministic scopeKey', () => {
    const dir = directory({ engram: [{ id: 'u-1', name: 'engram', matchedBy: 'canonical_name' }] });
    const res = resolveScope(dir, 't1', { project: 'engram' });
    expect(res).toEqual({ projectId: 'u-1', taskId: null, scopeKey: 'p:u-1', aliasesMatched: [] });
  });

  it('resolves a registered alias to the same UUID and reports the alias match', () => {
    const dir = directory({ 'engram system': [{ id: 'u-1', name: 'engram', matchedBy: 'alias' }] });
    const res = resolveScope(dir, 't1', { project: 'engram system' });
    expect(res.projectId).toBe('u-1');
    expect(res.scopeKey).toBe('p:u-1');
    expect(res.aliasesMatched).toEqual(['engram system']);
  });

  it('unknown ref fails closed: ids null, scopeKey null, no error dump', () => {
    const res = resolveScope(directory({}), 't1', { project: 'ghost' });
    expect(res).toEqual({ projectId: null, taskId: null, scopeKey: null, aliasesMatched: [] });
  });

  it('ambiguous ref fails closed with candidates and NO synthesized scopeKey', () => {
    const dir = directory({
      api: [
        { id: 'u-1', name: 'engram-api', matchedBy: 'alias' },
        { id: 'u-2', name: 'regional-api', matchedBy: 'alias' },
      ],
    });
    const res = resolveScope(dir, 't1', { project: 'api' });
    expect(res.projectId).toBeNull();
    expect(res.scopeKey).toBeNull();
    expect(res.ambiguousCandidates).toEqual(['engram-api', 'regional-api']);
  });

  it('a partially-resolved scope never mints a key (project ok, task unknown)', () => {
    const dir = directory({ engram: [{ id: 'u-1', name: 'engram', matchedBy: 'canonical_name' }] });
    const res = resolveScope(dir, 't1', { project: 'engram', task: 'ghost-task' });
    expect(res.projectId).toBe('u-1');
    expect(res.taskId).toBeNull();
    expect(res.scopeKey).toBeNull();
  });

  it('both-form scope key derives deterministically from UUIDs only', () => {
    const dir = directory({
      engram: [{ id: 'u-1', name: 'engram', matchedBy: 'canonical_name' }],
      eng4: [{ id: 'u-9', name: 'eng4', matchedBy: 'canonical_name' }],
    });
    expect(resolveScope(dir, 't1', { project: 'engram', task: 'eng4' }).scopeKey).toBe('p:u-1|t:u-9');
    expect(deriveScopeKey(null, null)).toBeNull();
    expect(deriveScopeKey(null, 'u-9')).toBe('t:u-9');
  });
});

describe('ENG-4 P0 — legacy repro fixtures', () => {
  it('both live repros are pinned with tool, args, observed result, and date', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/eng4-legacy-repros.json', import.meta.url));
    const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(fixtures.repros).toHaveLength(2);
    for (const r of fixtures.repros) {
      expect(r.tool).toBe('get_agent_context');
      expect(r.observedOn).toBe('2026-07-15');
      expect(r.args).toBeTruthy();
      expect(r.observed).toBeTruthy();
      expect(r.mustFailAgainstLegacy).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime behaviors — intentionally absent until Phase-2 implementation
// ---------------------------------------------------------------------------

// Scope resolution against the real store: resolver logic is EXECUTABLE in
// the 2(a) suites; repro fixture #1 and exact agent-principal mapping
// are EXECUTABLE in the 2(c) real-store suite.

// REGRESSION (sol review 2a3980bc): the graph_lookup_keys index matches
// entity rows on ANY key kind — derived handles (weight 50), embedded
// observation handles (70), bootstrap handles (65) — not just
// canonical_name/alias. The exact wrapper must re-verify candidacy against
// the entity PAYLOAD so a ref that appears only in an observation, tag, or
// bootstrap line can never resolve (and thus never mint a scopeKey).
describe('ENG-4 2(a) — exact wrapper against the REAL indexed store (regression)', () => {
  const TENANT = 'default';
  let manager: any;

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'entity', ?, 'test-agent', '[]')`
    ).run('eng4-2a-real-entity', TENANT, JSON.stringify({
      name: 'Canonical Project',
      type: 'project',
      aliases: ['real alias'],
      observations: ['checkpoint mentions derived-only-handle in passing'],
      agentBootstrap: ['wake recipe lives at bootstrap-only-handle'],
      tags: ['tag-only-handle'],
    }));
    manager.rebuildGraphLookupIndex();
  });

  afterAll(async () => {
    await manager.close();
  });

  it('sanity: the index holds the derived-only handle under a NON-alias kind (the hole path is exercised)', () => {
    const kinds = manager.getDb().prepare(
      `SELECT DISTINCT key_kind FROM graph_lookup_keys WHERE tenant_id = ? AND lookup_key = ?`
    ).all(TENANT, 'derived-only-handle').map((r: any) => r.key_kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('canonical_name');
    expect(kinds).not.toContain('alias');
  });

  it('canonical name resolves as canonical_name', () => {
    const candidates = manager.resolveEntityCandidatesExact('Canonical Project', TENANT);
    expect(candidates).toEqual([
      { id: 'eng4-2a-real-entity', name: 'Canonical Project', matchedBy: 'canonical_name' },
    ]);
  });

  it('registered alias resolves as alias', () => {
    const candidates = manager.resolveEntityCandidatesExact('real alias', TENANT);
    expect(candidates).toEqual([
      { id: 'eng4-2a-real-entity', name: 'Canonical Project', matchedBy: 'alias' },
    ]);
  });

  it('derived-only observation handle NEVER resolves (sol repro)', () => {
    expect(manager.resolveEntityCandidatesExact('derived-only-handle', TENANT)).toEqual([]);
  });

  it('bootstrap-only and tag-only handles NEVER resolve', () => {
    expect(manager.resolveEntityCandidatesExact('bootstrap-only-handle', TENANT)).toEqual([]);
    expect(manager.resolveEntityCandidatesExact('tag-only-handle', TENANT)).toEqual([]);
  });

  it('resolveScope over the real store fails closed on a derived-only ref (no scopeKey minted)', () => {
    const resolved = resolveScope(manager, TENANT, { project: 'derived-only-handle' });
    expect(resolved).toEqual({ projectId: null, taskId: null, scopeKey: null, aliasesMatched: [] });
  });
});

// Definition-vs-state separation (incl. legacy repro fixture #2) is
// EXECUTABLE in the 2(c) resume runtime suite below.

// Branch-preserving CAS is EXECUTABLE in the 2(b) checkpoint suite below;
// the resume-side view (asOf.conflicts lists all live heads) is EXECUTABLE
// in the 2(c) resume suite.

// ---------------------------------------------------------------------------
// 2(b) checkpoint runtime — authorized by sol 8ac7457b on base 023a339.
// ---------------------------------------------------------------------------

describe('ENG-4 2(b) — checkpoint runtime (branch-preserving CAS, executable)', () => {
  const TENANT = 't1';
  const directory: EntityDirectory = {
    resolveEntityCandidatesExact: (name) => {
      if (name === 'Proj') return [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }];
      if (name === 'OtherProj') return [{ id: 'u-other', name: 'OtherProj', matchedBy: 'canonical_name' }];
      return [];
    },
    resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
  };

  const freshDb = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE ai_messages (id TEXT PRIMARY KEY, content TEXT)`);
    applyEng4Schema(db);
    return db;
  };

  const state = (status: string): WorkingState => ({
    objective: 'ship 2(b)', status, owner: 'fable-engram',
    nextActions: ['handoff'], blockers: [], guardrails: ['no-live-writes'],
  });
  const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
    agentId: 'fable-engram-cli',
    scope: { project: 'Proj' },
    expectedRevision: null,
    idempotencyKey: 'k-default',
    state: state('working'),
    ...over,
  });
  const snapCount = (db: any) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots`).get() as any).n;

  it('initial write (expectedRevision=null) → written, revision 1, no parent; scope + payload rows land', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp());
    expect(res.outcome).toBe('written');
    if (res.outcome !== 'written') return;
    expect(res.revision).toBe(1);
    expect(res.parentStateId).toBeNull();
    expect(res.scopeKey).toBe('p:u-proj');
    const scope = db.prepare(`SELECT project_id, task_id FROM eng4_scopes WHERE tenant_id=? AND scope_key=?`).get(TENANT, 'p:u-proj') as any;
    expect(scope).toEqual({ project_id: 'u-proj', task_id: null });
    const payload = db.prepare(`SELECT byte_length, body FROM eng4_payloads WHERE tenant_id=? AND content_hash=?`).get(TENANT, res.contentHash) as any;
    expect(payload.byte_length).toBe(payload.body.length);
  });

  it('ONE AUTHOR RULE: author = exact opaque principal and asserted_agent_id preserves the audit input', () => {
    const db = freshDb();
    const res = performCheckpoint(db, directory, TENANT, cp()) as any;
    const row = db.prepare(`SELECT author, asserted_agent_id FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, res.stateId) as any;
    expect(row).toEqual({ author: 'fable-engram-cli', asserted_agent_id: 'fable-engram-cli' });
  });

  it('extending the current head writes a linear child (new per-scope revision)', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    const second = performCheckpoint(db, directory, TENANT, cp({
      expectedRevision: 1, idempotencyKey: 'k-2', state: state('progressed'),
    })) as any;
    expect(second.outcome).toBe('written');
    expect(second.revision).toBe(2);
    expect(second.parentStateId).toBe(first.stateId);
  });

  it('extending a STALE parent (non-head, same scope) WRITES a branch child — not a conflict', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-2', state: state('head') }));
    const branch = performCheckpoint(db, directory, TENANT, cp({
      expectedRevision: 1, idempotencyKey: 'k-3', state: state('branch'),
    })) as any;
    expect(branch.outcome).toBe('written');
    expect(branch.revision).toBe(3);
    expect(branch.parentStateId).toBe(first.stateId);
  });

  it('two writers from the same expectedRevision both succeed as branches with distinct revisions', () => {
    const db = freshDb();
    const base = performCheckpoint(db, directory, TENANT, cp()) as any;
    const a = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-a', agentId: 'agent-a', state: state('a') })) as any;
    const b = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-b', agentId: 'agent-b', state: state('b') })) as any;
    expect(a.outcome).toBe('written');
    expect(b.outcome).toBe('written');
    expect(a.revision).not.toBe(b.revision);
    expect(a.parentStateId).toBe(base.stateId);
    expect(b.parentStateId).toBe(base.stateId);
  });

  it('revision allocation + insert are atomic per write: N branch writes from one parent → N distinct revisions', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const revisions = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const res = performCheckpoint(db, directory, TENANT, cp({
        expectedRevision: 1, idempotencyKey: `k-fan-${i}`, state: state(`fan-${i}`),
      })) as any;
      expect(res.outcome).toBe('written');
      revisions.add(res.revision);
    }
    expect(revisions.size).toBe(10);
  });

  it('expectedRevision naming a nonexistent revision returns outcome=conflict listing ALL live heads', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const a = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-a', state: state('a') })) as any;
    const b = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-b', state: state('b') })) as any;
    const res = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 99, idempotencyKey: 'k-x' })) as any;
    expect(res.outcome).toBe('conflict');
    expect(res.heads.map((h: any) => h.stateId).sort()).toEqual([a.stateId, b.stateId].sort());
    expect(res.heads.every((h: any) => h.author === 'fable-engram-cli')).toBe(true);
  });

  it('a revision existing only in ANOTHER scope is unreachable: empty target scope fails CLOSED as a typed error — conflict cannot carry heads:[] (frozen schema minItems 1)', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'OtherProj' } }));
    expect(() => performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1 })))
      .toThrow(CheckpointEmptyScopeError);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_state_snapshots WHERE scope_key='p:u-proj'`).get() as any).n).toBe(0);
    // Trigger backstop: a raw insert claiming a cross-scope parent aborts.
    const otherState = db.prepare(`SELECT state_id FROM eng4_state_snapshots WHERE scope_key='p:u-other'`).get() as any;
    db.prepare(`INSERT OR IGNORE INTO eng4_scopes (tenant_id, scope_key, project_id, task_id) VALUES (?, 'p:u-proj', 'u-proj', NULL)`).run(TENANT);
    expect(() => db.prepare(
      `INSERT INTO eng4_state_snapshots
         (tenant_id, state_id, scope_key, revision, parent_state_id, content_hash,
          request_fingerprint, idempotency_key, author, asserted_agent_id, state_json)
       VALUES (?, 'sx', 'p:u-proj', 1, ?, 'h', 'f', 'kx', 'a', 'a', '{}')`
    ).run(TENANT, otherState.state_id)).toThrow(/same tenant and scope_key/);
  });

  it('expectedRevision=null on a scope that already has snapshots returns outcome=conflict', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const res = performCheckpoint(db, directory, TENANT, cp({ idempotencyKey: 'k-late' })) as any;
    expect(res.outcome).toBe('conflict');
    expect(res.heads).toHaveLength(1);
  });

  it('retry with same idempotencyKey + identical intent returns idempotent-replay of the ORIGINAL (nothing new written)', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    const replay = performCheckpoint(db, directory, TENANT, cp()) as any;
    expect(replay).toEqual({
      outcome: 'idempotent-replay',
      stateId: first.stateId,
      scopeKey: first.scopeKey,
      revision: first.revision,
      contentHash: first.contentHash,
    });
    expect(snapCount(db)).toBe(1);
  });

  it('retry of the INITIAL (null) write replays even after the scope gained snapshots — idempotency precedes CAS', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-2', state: state('head') }));
    const replay = performCheckpoint(db, directory, TENANT, cp()) as any;
    expect(replay.outcome).toBe('idempotent-replay');
    expect(replay.stateId).toBe(first.stateId);
  });

  it('same key + different content returns outcome=idempotency-mismatch and writes NOTHING', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    const res = performCheckpoint(db, directory, TENANT, cp({ state: state('DIFFERENT') })) as any;
    expect(res.outcome).toBe('idempotency-mismatch');
    expect(res.stateId).toBe(first.stateId);
    expect(res.expectedRequestFingerprint).not.toBe(res.receivedRequestFingerprint);
    expect(snapCount(db)).toBe(1);
  });

  it('same key + same content but a DIFFERENT canonical author is a mismatch — no cross-agent replay', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const res = performCheckpoint(db, directory, TENANT, cp({ agentId: 'someone-else' })) as any;
    expect(res.outcome).toBe('idempotency-mismatch');
    expect(snapCount(db)).toBe(1);
  });

  it('transport-looking suffixes are distinct principals and cannot replay another handle idempotently', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp({ agentId: 'fable-engram' })) as any;
    const mismatch = performCheckpoint(db, directory, TENANT, cp({ agentId: 'fable-engram-cli' })) as any;
    expect(mismatch.outcome).toBe('idempotency-mismatch');
    expect(mismatch.stateId).toBe(first.stateId);
    expect(snapCount(db)).toBe(1);
  });

  it('stored request_fingerprint is the EXACT RFC 8785 requestFingerprint; payload binds the exact canonical bytes', () => {
    const db = freshDb();
    const params = cp();
    const res = performCheckpoint(db, directory, TENANT, params) as any;
    const envelope = {
      scopeKey: 'p:u-proj', state: params.state, events: params.events ?? [],
      factChanges: params.factChanges ?? [], loopChanges: params.loopChanges ?? [],
      evidenceRefs: params.evidenceRefs ?? [],
    };
    const row = db.prepare(`SELECT request_fingerprint, content_hash FROM eng4_state_snapshots WHERE tenant_id=? AND state_id=?`).get(TENANT, res.stateId) as any;
    expect(row.request_fingerprint).toBe(requestFingerprint({
      canonicalAgentId: 'fable-engram-cli', scopeKey: 'p:u-proj',
      expectedRevision: null, resolvedParentStateId: null, envelope,
    }));
    expect(row.content_hash).toBe(envelopeContentHash(envelope));
    const payload = db.prepare(`SELECT byte_length, body FROM eng4_payloads WHERE tenant_id=? AND content_hash=?`).get(TENANT, res.contentHash) as any;
    const bytes = canonicalEnvelopeBytes(envelope);
    expect(payload.byte_length).toBe(bytes.length);
    expect(Buffer.from(payload.body).equals(bytes)).toBe(true);
  });

  it('replay verifies persisted payload bytes: a corrupted payload fails CLOSED, never replays garbage', () => {
    const db = freshDb();
    const first = performCheckpoint(db, directory, TENANT, cp()) as any;
    db.prepare(`UPDATE eng4_payloads SET body = CAST('corrupted' AS BLOB), byte_length = 9 WHERE tenant_id=? AND content_hash=?`).run(TENANT, first.contentHash);
    expect(() => performCheckpoint(db, directory, TENANT, cp())).toThrow(CheckpointIntegrityError);
  });

  it('a mid-write failure rolls back EVERYTHING — no partial scope/payload/snapshot/idempotency rows', () => {
    const db = freshDb();
    db.exec(`CREATE TRIGGER test_poison BEFORE INSERT ON eng4_state_snapshots
             WHEN NEW.scope_key = 'p:u-proj'
             BEGIN SELECT RAISE(ABORT, 'test poison'); END`);
    expect(() => performCheckpoint(db, directory, TENANT, cp())).toThrow(/test poison/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_scopes`).get() as any).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_payloads`).get() as any).n).toBe(0);
    expect(snapCount(db)).toBe(0);
  });

  it("tenant2 cannot replay or collide with tenant1's idempotency keys", () => {
    const db = freshDb();
    const t1 = performCheckpoint(db, directory, 't1', cp()) as any;
    const t2 = performCheckpoint(db, directory, 't2', cp()) as any;
    expect(t2.outcome).toBe('written');
    expect(t2.stateId).not.toBe(t1.stateId);
    expect(snapCount(db)).toBe(2);
  });

  it('unresolved or ambiguous scope fails CLOSED as a typed error — never one of the four outcomes', () => {
    const db = freshDb();
    expect(() => performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'nope' } })))
      .toThrow(CheckpointScopeError);
    expect(snapCount(db)).toBe(0);
  });

  it('factChanges materialize transactionally: insert with refs (dangling contradicts legal), server-owned recordedAt, canonical author', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp({
      factChanges: [{
        assertion: { subject: 'engram', predicate: 'licensed-as', object: 'Apache-2.0' },
        status: 'verified',
        evidenceRefs: ['commit:52656c6'],
        sourceRefs: ['msg:5866fa85'],
        contradicts: ['fact-not-yet-synced'],
        effectiveAt: '2026-07-15T00:00:00Z',
      }],
    }));
    const fact = db.prepare(`SELECT * FROM eng4_facts WHERE tenant_id=?`).get(TENANT) as any;
    expect(fact.subject).toBe('engram');
    expect(fact.author).toBe('fable-engram-cli');
    expect(fact.effective_at).toBe('2026-07-15T00:00:00Z');
    const snap = db.prepare(`SELECT recorded_at FROM eng4_state_snapshots WHERE tenant_id=?`).get(TENANT) as any;
    expect(fact.recorded_at).toBe(snap.recorded_at); // server-owned, same txn timestamp
    const refs = db.prepare(`SELECT ref_kind, ref FROM eng4_fact_refs WHERE tenant_id=? ORDER BY ref_kind`).all(TENANT);
    expect(refs).toEqual([
      { ref_kind: 'contradicts', ref: 'fact-not-yet-synced' },
      { ref_kind: 'evidence', ref: 'commit:52656c6' },
      { ref_kind: 'source', ref: 'msg:5866fa85' },
    ]);
  });

  it('factChange with unknown factId fails CLOSED and rolls back the WHOLE checkpoint', () => {
    const db = freshDb();
    expect(() => performCheckpoint(db, directory, TENANT, cp({
      factChanges: [{ factId: 'nope', assertion: { subject: 's', predicate: 'p', object: 'o' }, status: 'asserted', evidenceRefs: [], sourceRefs: [] }],
    }))).toThrow(CheckpointChangeError);
    expect(snapCount(db)).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_facts`).get() as any).n).toBe(0);
  });

  it('loopChanges materialize: insert, then update bumps revision; close REQUIRES an outcome (fail closed + rollback)', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp({
      loopChanges: [{ status: 'open', nextAction: 'ship 2(c)' }],
    }));
    const loop = db.prepare(`SELECT * FROM eng4_open_loops WHERE tenant_id=?`).get(TENANT) as any;
    expect(loop.owner).toBe('fable-engram-cli');
    expect(loop.revision).toBe(0);
    performCheckpoint(db, directory, TENANT, cp({
      expectedRevision: 1, idempotencyKey: 'k-2',
      loopChanges: [{ loopId: loop.loop_id, status: 'blocked', nextAction: 'await verdict', blockedOn: 'sol' }],
    }));
    const updated = db.prepare(`SELECT * FROM eng4_open_loops WHERE tenant_id=?`).get(TENANT) as any;
    expect(updated.status).toBe('blocked');
    expect(updated.revision).toBe(1);
    const before = snapCount(db);
    expect(() => performCheckpoint(db, directory, TENANT, cp({
      expectedRevision: 2, idempotencyKey: 'k-3',
      loopChanges: [{ loopId: loop.loop_id, status: 'closed', nextAction: 'n/a' }],
    }))).toThrow(CheckpointChangeError);
    expect(snapCount(db)).toBe(before);
  });

  it('every runtime result validates against the FROZEN checkpoint output schema (no runtime/contract drift)', () => {
    const db = freshDb();
    const results: unknown[] = [
      performCheckpoint(db, directory, TENANT, cp()),                                                       // written (initial)
      performCheckpoint(db, directory, TENANT, cp()),                                                       // idempotent-replay
      performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-2' })),         // written (child)
      performCheckpoint(db, directory, TENANT, cp({ state: state('DIFFERENT') })),                          // idempotency-mismatch
      performCheckpoint(db, directory, TENANT, cp({ idempotencyKey: 'k-3' })),                              // conflict (null-on-existing)
      performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 99, idempotencyKey: 'k-4' })),        // conflict (missing parent, nonempty scope)
    ];
    for (const result of results) {
      expect(validCheckpointResult(result), JSON.stringify(ajv.errorsText(validCheckpointResult.errors))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2(c) resume runtime — authorized by sol 5866fa85 on base 52656c6.
// ---------------------------------------------------------------------------

describe('ENG-4 2(c) — resume runtime (frozen bundle schema, executable)', () => {
  const TENANT = 't1';
  const DEFINITIONS: Record<string, string> = { 'u-proj': 'Charter: productize the engram memory server.' };
  const directory: ResumeDirectory = {
    resolveEntityCandidatesExact: (name) => {
      if (name === 'Proj') return [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }];
      return [];
    },
    resolveCanonicalAgent: (agentId) => ({ canonical: agentId, aliases: [agentId] }),
    getEntityDefinition: (entityId) => DEFINITIONS[entityId] ?? null,
    getCapsuleObservations: () => ({ capsules: [], candidatesConsidered: 0 }),
  };

  const freshDb = () => {
    const db = new Database(':memory:');
    // Mirrors the production shape: tenant_id exists via Migration 002 on
    // BOTH tables (fixture-fidelity rule — sol 95eba75a).
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
    objective: 'ship 2(c)', status, owner: 'fable-engram',
    nextActions: ['handoff'], blockers: [], guardrails: ['no-live-writes'],
  });
  const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
    agentId: 'fable-engram-cli', scope: { project: 'Proj' }, expectedRevision: null,
    idempotencyKey: 'k-default', state: state('working'), ...over,
  });
  const rz = (over: Partial<ResumeParams> = {}): ResumeParams => ({
    agentId: 'fable-engram-cli', scope: { project: 'Proj' }, budget: 4000, ...over,
  });
  const seedFull = (db: any) => {
    performCheckpoint(db, directory, TENANT, cp({
      events: [{ kind: 'decision', summary: 'freeze the spec', at: '2026-07-15T12:00:00Z' }],
      factChanges: [{
        assertion: { subject: 'engram', predicate: 'licensed-as', object: 'Apache-2.0' },
        status: 'verified', evidenceRefs: ['commit:c61af03'], sourceRefs: ['msg:phase0'],
        contradicts: ['dangling-other-fact'],
      }],
      loopChanges: [{ status: 'open', nextAction: 'ship 2(c)' }],
      evidenceRefs: ['commit:52656c6'],
    }));
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                VALUES ('m-scoped', 'engram-sol', 'fable-engram-cli', 'scoped body', 'high', '2026-07-16T01:00:00Z', 'u-proj', 't1')`).run();
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, tenant_id)
                VALUES ('m-unscoped', 'someone', 'fable-engram-cli', 'unscoped body', 'normal', '2026-07-16T01:01:00Z', 't1')`).run();
  };

  it('a fully-populated bundle validates against the FROZEN resume output schema (no runtime/contract drift)', () => {
    const db = freshDb();
    seedFull(db);
    const bundle = performResume(db, directory, TENANT, rz());
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.working?.status).toBe('working');
    expect(bundle.openLoops).toHaveLength(1);
    expect(bundle.messages).toEqual([{
      itemType: 'message', messageId: 'm-scoped', from: 'engram-sol', priority: 'high',
      recordedAt: '2026-07-16T01:00:00Z', body: 'scoped body', handle: null,
    }]);
    expect(bundle.currentFacts[0].contradicts).toEqual(['dangling-other-fact']); // unresolved, surfaced, not an error
    expect(bundle.currentFacts[0].effectiveAt).toBeUndefined(); // absent = unknown, never invented
    expect(bundle.decisions).toEqual([{
      id: expect.stringMatching(/:0$/), summary: 'freeze the spec',
      recordedAt: '2026-07-15T12:00:00Z', evidenceRefs: ['commit:52656c6'],
    }]);
    expect(bundle.evidence[0].kind).toBe('state-snapshot');
    expect(bundle.evidence[0].uri).toMatch(/^engram:\/\/snapshot\//);
    expect(bundle.pointers).toEqual([{ label: 'project', entity: 'u-proj', relation: 'scoped-to' }]);
  });

  it('REPRO fixture #2 flip: definition is charter prose, working is CURRENT snapshot state — never founding prose', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-2', state: state('current-truth') }));
    const bundle = performResume(db, directory, TENANT, rz());
    expect(bundle.definition).toBe('Charter: productize the engram memory server.');
    expect(bundle.working?.status).toBe('current-truth'); // Nth checkpoint, not founding observations
    expect(JSON.stringify(bundle.working)).not.toContain('Charter');
    expect(bundle.asOf.revision).toBe(2);
    expect(bundle.asOf.stale).toBe(false);
  });

  it('scope with no snapshot yet: working=null, asOf.stateId=null, stale=true — absence is explicit', () => {
    const db = freshDb();
    const bundle = performResume(db, directory, TENANT, rz());
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.working).toBeNull();
    expect(bundle.asOf).toMatchObject({ stateId: null, revision: null, stateAgeSec: null, stale: true, conflicts: [] });
    expect(bundle.definition).toBe('Charter: productize the engram memory server.');
    expect(bundle.coverage.working).toMatchObject({ includedCount: 0, totalCount: 0, contentComplete: true, omittedReason: 'none' });
  });

  it('asOf.conflicts lists ALL live heads when branches exist; current view follows the POINTER, not the max revision (ENG-4 H1, design 3429000 §3.2a)', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    // The first write set the pointer to revision 1. `a` extends the pointed
    // head and ADVANCES the pointer; `b` extends the now-stale revision 1 and
    // writes a live branch with the higher revision that is NOT current.
    // (Before H1 this test pinned `b` — the exact A→B/A→C displacement the
    // design closes.)
    const a = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-a', state: state('branch-a') })) as any;
    const b = performCheckpoint(db, directory, TENANT, cp({ expectedRevision: 1, idempotencyKey: 'k-b', state: state('branch-b') })) as any;
    const bundle = performResume(db, directory, TENANT, rz());
    expect(bundle.asOf.conflicts.map((h) => h.stateId).sort()).toEqual([a.stateId, b.stateId].sort());
    expect(b.revision).toBeGreaterThan(a.revision);
    expect(bundle.asOf.stateId).toBe(a.stateId);
    expect(bundle.working?.status).toBe('branch-a');
  });

  it('unresolved scope: explicit resolvedScope nulls with fully-accounted empty sections — never silently empty', () => {
    const db = freshDb();
    const bundle = performResume(db, directory, TENANT, rz({ scope: { project: 'unknown-thing' } }));
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.resolvedScope).toEqual({ projectId: null, taskId: null, scopeKey: null, aliasesMatched: [] });
    expect(bundle.asOf.stale).toBe(true);
    for (const section of ['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'] as const) {
      expect(bundle.coverage[section].contentComplete).toBe(true);
    }
  });

  it('tiny budget: omissions are ACCOUNTED (omittedReason=budget), totalTokenEstimate never exceeds budget, bundle still schema-valid', () => {
    const db = freshDb();
    seedFull(db);
    const bundle = performResume(db, directory, TENANT, rz({ budget: 256 }));
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(256);
    const totals = (['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'] as const)
      .map((s) => bundle.coverage[s]);
    const omitted = totals.filter((c) => c.includedCount < c.totalCount);
    expect(omitted.length).toBeGreaterThan(0);
    for (const c of omitted) expect(c.omittedReason).toBe('budget');
    for (const c of totals) expect(c.includedCount).toBeLessThanOrEqual(c.totalCount);
  });

  it('sections excluded via params report omittedReason=not-requested with the REAL totalCount — coverage closed over all seven', () => {
    const db = freshDb();
    seedFull(db);
    const bundle = performResume(db, directory, TENANT, rz({ sections: ['working', 'currentFacts'] }));
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(Object.keys(bundle.coverage).sort()).toEqual(
      ['budget', 'currentFacts', 'decisions', 'evidence', 'messages', 'openLoops', 'pointers', 'totalTokenEstimate', 'working'].sort()
    );
    expect(bundle.coverage.messages).toMatchObject({ includedCount: 0, totalCount: 1, omittedReason: 'not-requested', contentComplete: false });
    expect(bundle.messages).toEqual([]);
    expect(bundle.coverage.working.contentComplete).toBe(true);
    expect(bundle.currentFacts).toHaveLength(1);
  });

  it('cursor continuation: pages have no gaps and no repeats until every section is delivered', () => {
    const db = freshDb();
    seedFull(db);
    for (let i = 0; i < 6; i++) {
      // tenant_id EXPLICIT (sol 075379da): performResume runs as t1 — rows
      // left on the fixture default tenant would be excluded and the walk
      // would silently stop exercising multi-message pagination.
      db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                  VALUES (?, 'engram-sol', 'fable-engram-cli', ?, 'normal', ?, 'u-proj', 't1')`)
        .run(`m-extra-${i}`, `body ${i} ${'x'.repeat(120)}`, `2026-07-16T01:0${i + 2}:00Z`);
    }
    const seen = new Map<string, number>();
    const totals = new Map<string, number>();
    let cursor: string | undefined;
    let pagesWalked = 0;
    for (let page = 0; page < 20; page++) {
      pagesWalked++;
      const bundle = performResume(db, directory, TENANT, rz({ budget: 300, cursor }));
      expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
      for (const section of ['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'] as const) {
        const cov = bundle.coverage[section];
        totals.set(section, cov.totalCount);
        const items = section === 'working' ? (bundle.working ? [bundle.working] : []) : (bundle as any)[section];
        for (const item of items) {
          const key = `${section}:${JSON.stringify(item)}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      const next = (['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'] as const)
        .map((s) => bundle.coverage[s].nextCursor).find((c) => c !== null);
      if (!next) break;
      cursor = next;
    }
    for (const [, count] of seen) expect(count).toBe(1); // no repeats
    const delivered = new Map<string, number>();
    for (const key of seen.keys()) {
      const section = key.slice(0, key.indexOf(':'));
      delivered.set(section, (delivered.get(section) ?? 0) + 1);
    }
    for (const [section, total] of totals) {
      expect(delivered.get(section) ?? 0).toBe(total); // no gaps
    }
    // The walk must actually EXERCISE pagination (sol 075379da): all seven
    // t1 messages delivered, across more than one page.
    expect(totals.get('messages')).toBe(7);
    expect(delivered.get('messages')).toBe(7);
    expect(pagesWalked).toBeGreaterThan(1);
  });

  it('messages are scoped-only and resume is READ-ONLY: read/delivered state unchanged after repeated resumes', () => {
    const db = freshDb();
    seedFull(db);
    performResume(db, directory, TENANT, rz());
    performResume(db, directory, TENANT, rz());
    const bundle = performResume(db, directory, TENANT, rz());
    expect(bundle.messages.map((m: any) => m.messageId)).toEqual(['m-scoped']); // unscoped row never leaks in
    const rows = db.prepare(`SELECT id, read_at, delivered_at FROM ai_messages ORDER BY id`).all() as any[];
    for (const row of rows) {
      expect(row.read_at).toBeNull();
      expect(row.delivered_at).toBeNull();
    }
  });

  it('messages are selected for the exact resolved recipient only, even inside the same tenant and scope', () => {
    const db = freshDb();
    const insert = db.prepare(
      `INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
       VALUES (?, 'engram-sol', ?, ?, 'normal', ?, 'u-proj', 't1')`
    );
    insert.run('m-cli', 'fable-engram-cli', 'for cli only', '2026-07-16T03:00:00Z');
    insert.run('m-bare', 'fable-engram', 'for bare only', '2026-07-16T03:01:00Z');

    const cli = performResume(db, directory, TENANT, rz({ agentId: 'fable-engram-cli' }));
    expect(cli.messages.map((item: any) => item.messageId)).toEqual(['m-cli']);
    expect(JSON.stringify(cli)).not.toContain('for bare only');

    const bare = performResume(db, directory, TENANT, rz({ agentId: 'fable-engram' }));
    expect(bare.messages.map((item: any) => item.messageId)).toEqual(['m-bare']);
    expect(JSON.stringify(bare)).not.toContain('for cli only');
  });

  it("tenant isolation: tenant2 knowing tenant1's scopeKey (even resolving the same UUIDs) reads NOTHING of tenant1", () => {
    const db = freshDb();
    seedFull(db); // all under t1
    const bundle = performResume(db, directory, 't2', rz());
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.resolvedScope.scopeKey).toBe('p:u-proj'); // same key knowledge...
    expect(bundle.working).toBeNull(); // ...grants no data
    expect(bundle.openLoops).toEqual([]);
    expect(bundle.currentFacts).toEqual([]);
    expect(bundle.evidence).toEqual([]);
    expect(bundle.messages).toEqual([]); // sol 95eba75a: t1's scoped messages never leak
    expect(bundle.asOf.stale).toBe(true);
  });

  it("REGRESSION (sol 95eba75a): tenant2 resolving tenant1's project UUID receives ZERO tenant1 messages", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                VALUES ('m-t1', 'engram-sol', 'fable-engram-cli', 't1 secret', 'high', '2026-07-16T01:00:00Z', 'u-proj', 't1')`).run();
    const t1 = performResume(db, directory, 't1', rz());
    expect(t1.messages.map((m: any) => m.messageId)).toEqual(['m-t1']);
    const t2 = performResume(db, directory, 't2', rz());
    expect(t2.messages).toEqual([]);
    expect(t2.coverage.messages.totalCount).toBe(0); // not even counted
  });
});

describe('ENG-4 2(c) — resume against the REAL store (legacy repro #1 flip)', () => {
  let manager: any;

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES ('u-bda', 'default', 'entity', ?, 'test-agent', '[]')`
    ).run(JSON.stringify({
      name: 'sample-portal-app',
      type: 'project',
      observations: ['Founded 2026: customer portal for Sample Portal.'],
    }));
    // The legacy failure mode: ANOTHER entity incidentally mentions the
    // project name in an observation — the substring resolver matched it.
    manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES ('u-decoy', 'default', 'entity', ?, 'test-agent', '[]')`
    ).run(JSON.stringify({
      name: 'unrelated-notes',
      type: 'reference',
      observations: ['meeting notes mention sample-portal-app in passing'],
    }));
    manager.rebuildGraphLookupIndex();
  });

  afterAll(async () => {
    await manager.close();
  });

  it('REPRO fixture #1 flip: hyphenated multi-word project exact-resolves to ONE entity and returns a populated bundle, never project={}', () => {
    const db = manager.getDb();
    const written = performCheckpoint(db, manager, 'default', {
      agentId: 'fable-engram', scope: { project: 'sample-portal-app' },
      expectedRevision: null, idempotencyKey: 'k-repro-1', state: {
        objective: 'portal live', status: 'production', owner: 'claude-code',
        nextActions: ['P2-16'], blockers: [], guardrails: [],
      },
    }) as any;
    expect(written.outcome).toBe('written');
    const bundle = performResume(db, manager, 'default', {
      agentId: 'fable-engram', scope: { project: 'sample-portal-app' }, budget: 4000,
    });
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    expect(bundle.resolvedScope.projectId).toBe('u-bda'); // exact, single candidate — decoy mention never matched
    expect(bundle.working?.status).toBe('production'); // populated, not {}
    expect(bundle.definition).toBe('Founded 2026: customer portal for Sample Portal.');
    expect(bundle.asOf.stale).toBe(false);
  });

  it('canonical-agent real store: an active base registration never binds a transport-looking suffix', () => {
    manager.getDb().prepare(
      `INSERT INTO agent_registrations
         (agent_id, tenant_id, name, capabilities_json, metadata_json, status, registered_by)
       VALUES ('fable-engram', 'default', 'Fable Engram', '[]', '{}', 'active', 'contract-test')`
    ).run();
    const cli = manager.resolveCanonicalAgent('fable-engram-cli', 'default');
    const bare = manager.resolveCanonicalAgent('fable-engram', 'default');
    expect(cli.canonical).toBe('fable-engram-cli');
    expect(bare.canonical).toBe('fable-engram');
    expect(cli.canonical).not.toBe(bare.canonical);
  });
});

// ---------------------------------------------------------------------------
// 2(d) resource layer + session wrappers — authorized by sol b21bccde.
// ---------------------------------------------------------------------------

describe('ENG-4 2(d) — engram:// resources, handles, handoff acks (executable)', () => {
  const TENANT = 't1';
  const directory: ResumeDirectory = {
    resolveEntityCandidatesExact: (name) => {
      if (name === 'Proj') return [{ id: 'u-proj', name: 'Proj', matchedBy: 'canonical_name' }];
      if (name === 'Task') return [{ id: 'u-task', name: 'Task', matchedBy: 'canonical_name' }];
      return [];
    },
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
    objective: 'ship 2(d)', status, owner: 'fable-engram',
    nextActions: [], blockers: [], guardrails: [],
  });
  const cp = (over: Partial<CheckpointParams> = {}): CheckpointParams => ({
    agentId: 'fable-engram-cli', scope: { project: 'Proj' }, expectedRevision: null,
    idempotencyKey: 'k-default', state: state('working'), ...over,
  });
  const rz = (over: Partial<ResumeParams> = {}): ResumeParams => ({
    agentId: 'fable-engram-cli', scope: { project: 'Proj' }, budget: 8000, ...over,
  });
  const seedHandoff = (db: any, id = 'h-1', tenant = TENANT, summary = 'take over 2(d)') =>
    db.prepare(`INSERT INTO session_handoffs (id, project_id, from_agent, summary, created_at, tenant_id)
                VALUES (?, 'u-proj', 'engram-sol', ?, '2026-07-16T02:00:00Z', ?)`).run(id, summary, tenant);

  it('snapshot fetch by stateId returns the immutable snapshot; fetch by revision returns the SAME snapshot', () => {
    const db = freshDb();
    const written = performCheckpoint(db, directory, TENANT, cp()) as any;
    const byId = fetchSnapshot(db, directory, TENANT, { scope: { project: 'Proj' }, stateId: written.stateId });
    expect(byId.snapshot).toMatchObject({
      stateId: written.stateId, scopeKey: 'p:u-proj', revision: 1, parentStateId: null,
      contentHash: written.contentHash, author: 'fable-engram-cli', assertedAgentId: 'fable-engram-cli',
    });
    expect(byId.snapshot.recordedAt).toBeTruthy();
    expect(byId.snapshot.state.status).toBe('working');
    const byRev = fetchSnapshot(db, directory, TENANT, { scope: { project: 'Proj' }, revision: 1 });
    expect(byRev.snapshot.stateId).toBe(written.stateId);
  });

  it('every fetch hash+size-verifies the payload: corrupted bytes fail CLOSED', () => {
    const db = freshDb();
    const written = performCheckpoint(db, directory, TENANT, cp()) as any;
    db.prepare(`UPDATE eng4_payloads SET body = CAST('garbage' AS BLOB), byte_length = 7 WHERE tenant_id=? AND content_hash=?`)
      .run(TENANT, written.contentHash);
    expect(() => fetchSnapshot(db, directory, TENANT, { scope: { project: 'Proj' }, stateId: written.stateId }))
      .toThrow(CheckpointIntegrityError);
  });

  it('URIs are URL-encoded — raw scope delimiters never appear; parse round-trips; fetch-by-URI works', () => {
    const db = freshDb();
    const written = performCheckpoint(db, directory, TENANT, cp({ scope: { project: 'Proj', task: 'Task' } })) as any;
    expect(written.scopeKey).toBe('p:u-proj|t:u-task');
    const uri = buildSnapshotUri(written.scopeKey, written.stateId);
    const path = uri.slice('engram://'.length);
    expect(path).not.toContain('|');
    expect(path).not.toContain(':');
    const parsed = parseEngramUri(uri);
    expect(parsed).toEqual({ kind: 'snapshot', segments: [written.scopeKey, written.stateId] });
    const fetched = fetchResourceByUri(db, TENANT, uri) as any;
    expect(fetched.kind).toBe('state-snapshot');
    expect(fetched.contentHash).toBe(written.contentHash);
  });

  it('changes-since is cursor-backed and COMPLETE across pages, revision-ordered, no dupes', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    for (let r = 1; r <= 4; r++) {
      performCheckpoint(db, directory, TENANT, cp({ expectedRevision: r, idempotencyKey: `k-${r + 1}`, state: state(`rev-${r + 1}`) }));
    }
    const collected: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = changesSince(db, directory, TENANT, { scope: { project: 'Proj' }, sinceRevision: 1, cursor }, 2);
      collected.push(...result.items.map((i) => i.revision));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(collected).toEqual([2, 3, 4, 5]);
  });

  it('LOSSLESS ROUND-TRIP: the resume evidence handle fetches back the exact bytes, hash+size verified', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const bundle = performResume(db, directory, TENANT, rz());
    const handle = bundle.evidence[0] as any;
    const fetched = fetchResourceByUri(db, TENANT, handle.uri) as any;
    expect(fetched.byteLength).toBe(handle.byteLength);
    expect(fetched.contentHash).toBe(handle.contentHash);
    const digest = createHash('sha256').update(fetched.body).digest('hex');
    expect(digest).toBe(handle.contentHash);
    expect(fetched.body.length).toBe(handle.byteLength);
  });

  it('oversized message body is null + handle; the handle fetch returns the FULL body', () => {
    const db = freshDb();
    performCheckpoint(db, directory, TENANT, cp());
    const bigBody = 'B'.repeat(3000);
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                VALUES ('m-big', 'engram-sol', 'fable-engram-cli', ?, 'normal', '2026-07-16T02:00:00Z', 'u-proj', 't1')`).run(bigBody);
    const bundle = performResume(db, directory, TENANT, rz());
    const item = bundle.messages.find((m: any) => m.messageId === 'm-big') as any;
    expect(item.body).toBeNull();
    expect(item.handle.kind).toBe('message');
    expect(parseEngramUri(item.handle.uri)).toEqual({
      kind: 'message',
      segments: ['p:u-proj', 'fable-engram-cli', 'm-big'],
    });
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    const fetched = fetchResourceByUri(db, TENANT, item.handle.uri) as any;
    expect(fetched.body).toBe(bigBody);
  });

  it('handoffs appear in the messages section with ackedByMe=false; reading NEVER consumes', () => {
    const db = freshDb();
    seedHandoff(db);
    performResume(db, directory, TENANT, rz());
    const bundle = performResume(db, directory, TENANT, rz());
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    const handoff = bundle.messages.find((m: any) => m.itemType === 'handoff') as any;
    expect(handoff).toMatchObject({ handoffId: 'h-1', from: 'engram-sol', ackedByMe: false, body: 'take over 2(d)' });
    const row = db.prepare(`SELECT consumed_at, active FROM session_handoffs WHERE id='h-1'`).get() as any;
    expect(row).toEqual({ consumed_at: null, active: 1 }); // unlike legacy begin_session
  });

  it('begin_session acks ONLY the listed ids for THAT agent; other agents still see ackedByMe=false', () => {
    const db = freshDb();
    seedHandoff(db);
    const mine = performBeginSession(db, directory, TENANT, {
      agentId: 'fable-engram-cli', scope: { project: 'Proj' }, budget: 8000, ackHandoffIds: ['h-1'],
    });
    expect((mine.messages.find((m: any) => m.itemType === 'handoff') as any).ackedByMe).toBe(true);
    const theirs = performResume(db, directory, TENANT, rz({ agentId: 'someone-else' }));
    expect((theirs.messages.find((m: any) => m.itemType === 'handoff') as any).ackedByMe).toBe(false);
  });

  it('begin_session WITHOUT ackHandoffIds acks NOTHING (never auto-consume)', () => {
    const db = freshDb();
    seedHandoff(db);
    performBeginSession(db, directory, TENANT, { agentId: 'fable-engram-cli', scope: { project: 'Proj' }, budget: 8000 });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_handoff_acks`).get() as any).n).toBe(0);
  });

  it('transport-looking suffixes have distinct acknowledgement views', () => {
    const db = freshDb();
    seedHandoff(db);
    ackHandoffs(db, TENANT, directory.resolveCanonicalAgent('fable-engram-cli').canonical, ['h-1']);
    const cliBundle = performResume(db, directory, TENANT, rz({ agentId: 'fable-engram-cli' }));
    expect((cliBundle.messages.find((m: any) => m.itemType === 'handoff') as any).ackedByMe).toBe(true);
    const bareBundle = performResume(db, directory, TENANT, rz({ agentId: 'fable-engram' }));
    expect((bareBundle.messages.find((m: any) => m.itemType === 'handoff') as any).ackedByMe).toBe(false);
  });

  it('acking a nonexistent handoffId fails CLOSED and the whole batch rolls back (atomic)', () => {
    const db = freshDb();
    seedHandoff(db);
    expect(() => ackHandoffs(db, TENANT, 'fable-engram', ['h-1', 'h-bogus'])).toThrow(HandoffAckError);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM eng4_handoff_acks`).get() as any).n).toBe(0);
  });

  it("tenant2 cannot acknowledge tenant1's handoffs even knowing the id", () => {
    const db = freshDb();
    seedHandoff(db);
    expect(() => ackHandoffs(db, 't2', 'fable-engram', ['h-1'])).toThrow(HandoffAckError);
  });

  it("tenant2 knowing tenant1's stateId/revision/URI cannot fetch tenant1 snapshots", () => {
    const db = freshDb();
    const written = performCheckpoint(db, directory, TENANT, cp()) as any;
    expect(() => fetchSnapshot(db, directory, 't2', { scope: { project: 'Proj' }, stateId: written.stateId }))
      .toThrow(ResourceNotFoundError);
    expect(() => fetchSnapshot(db, directory, 't2', { scope: { project: 'Proj' }, revision: 1 }))
      .toThrow(ResourceNotFoundError);
    expect(() => fetchResourceByUri(db, 't2', buildSnapshotUri(written.scopeKey, written.stateId)))
      .toThrow(ResourceNotFoundError);
  });

  it('end_session is a thin checkpoint delegation', () => {
    const db = freshDb();
    const result = performEndSession(db, directory, TENANT, cp()) as any;
    expect(result.outcome).toBe('written');
    expect(result.revision).toBe(1);
  });

  // REGRESSIONS (sol 037cfc22): handles are SCOPE-BOUND — a same-tenant
  // agent knowing a raw row id cannot dereference another project's rows.
  it("same-tenant CROSS-PROJECT message dereference fails CLOSED — a known row id in project B is unreachable via a project-A-scoped handle", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                VALUES ('m-secret', 'x', 'y', 'other-project-secret', 'normal', '2026-07-16T02:00:00Z', 'u-other', 't1')`).run();
    expect(() => fetchResourceByUri(db, TENANT, buildMessageUri('p:u-proj', 'y', 'm-secret')))
      .toThrow(ResourceNotFoundError);
    // Sanity: reachable under ITS OWN scope binding.
    expect((fetchResourceByUri(db, TENANT, buildMessageUri('p:u-other', 'y', 'm-secret')) as any).body)
      .toBe('other-project-secret');
  });

  it('same-tenant CROSS-RECIPIENT message dereference fails CLOSED, while the exact recipient handle works', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, project_id, tenant_id)
                VALUES ('m-recipient', 'x', 'agent-y', 'recipient-secret', 'normal', '2026-07-16T02:00:00Z', 'u-proj', 't1')`).run();
    // The old scope+id shape would have exposed this existing row before the
    // recipient segment became mandatory. It is no longer dereferenceable.
    expect(() => fetchResourceByUri(
      db,
      TENANT,
      `engram://message/${encodeURIComponent('p:u-proj')}/${encodeURIComponent('m-recipient')}`
    )).toThrow(ResourceNotFoundError);
    expect(() => fetchResourceByUri(db, TENANT, buildMessageUri('p:u-proj', 'agent-x', 'm-recipient')))
      .toThrow(ResourceNotFoundError);
    expect((fetchResourceByUri(db, TENANT, buildMessageUri('p:u-proj', 'agent-y', 'm-recipient')) as any).body)
      .toBe('recipient-secret');
  });

  it('same-tenant CROSS-PROJECT handoff dereference fails CLOSED; task-only scope binds no project and dereferences nothing', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO session_handoffs (id, project_id, from_agent, summary, created_at, tenant_id)
                VALUES ('h-secret', 'u-other', 'x', 'other-project-handoff', '2026-07-16T02:00:00Z', 't1')`).run();
    expect(() => fetchResourceByUri(db, TENANT, buildHandoffUri('p:u-proj', 'h-secret')))
      .toThrow(ResourceNotFoundError);
    expect(() => fetchResourceByUri(db, TENANT, buildHandoffUri('t:u-task', 'h-secret')))
      .toThrow(ResourceNotFoundError);
    expect((fetchResourceByUri(db, TENANT, buildHandoffUri('p:u-other', 'h-secret')) as any).body)
      .toBe('other-project-handoff');
  });

  it('positive round trips under task-only and both-form scopes: the handle a resume emits dereferences to the full body', () => {
    const db = freshDb();
    const bigBody = 'T'.repeat(3000);
    db.prepare(`INSERT INTO ai_messages (id, from_agent, to_agent, content, priority, created_at, task_id, tenant_id)
                VALUES ('m-task', 's', 'fable-engram-cli', ?, 'normal', '2026-07-16T02:00:00Z', 'u-task', 't1')`).run(bigBody);
    const taskOnly = performResume(db, directory, TENANT, rz({ scope: { task: 'Task' } }));
    const taskItem = taskOnly.messages.find((m: any) => m.messageId === 'm-task') as any;
    expect(taskItem.body).toBeNull();
    expect((fetchResourceByUri(db, TENANT, taskItem.handle.uri) as any).body).toBe(bigBody);
    const bothForm = performResume(db, directory, TENANT, rz({ scope: { project: 'Proj', task: 'Task' } }));
    const bothItem = bothForm.messages.find((m: any) => m.messageId === 'm-task') as any;
    expect((fetchResourceByUri(db, TENANT, bothItem.handle.uri) as any).body).toBe(bigBody);
  });

  it('malformed scope segments in message/handoff handles fail CLOSED', () => {
    const db = freshDb();
    expect(() => fetchResourceByUri(db, TENANT, `engram://message/${encodeURIComponent('not-a-scope')}/agent-a/${encodeURIComponent('m-1')}`))
      .toThrow(ResourceNotFoundError);
    expect(() => fetchResourceByUri(db, TENANT, `engram://handoff/${encodeURIComponent('not-a-scope')}/${encodeURIComponent('h-1')}`))
      .toThrow(ResourceNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Step-3 item A — legacy handoff name→UUID backfill proof (hard registration
// gate, sol 4320b5c5). Isolated :memory: DBs only; the artifact is INERT.
// ---------------------------------------------------------------------------

describe('STEP-3 A — handoff backfill/cutover proof (executable)', () => {
  const directoryFor = (byTenant: Record<string, Record<string, Array<{ id: string; name: string; matchedBy: 'canonical_name' | 'alias' }>>>) => ({
    resolveEntityCandidatesExact: (name: string, tenantId: string) => byTenant[tenantId]?.[name] ?? [],
  });

  const freshDb = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE shared_memory (id TEXT PRIMARY KEY, tenant_id TEXT, memory_type TEXT, content TEXT)`);
    db.exec(`CREATE TABLE session_handoffs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_agent TEXT NOT NULL,
      summary TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      consumed_at TEXT, active INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT DEFAULT 'default'
    )`);
    db.prepare(`INSERT INTO shared_memory VALUES ('u-alpha', 't1', 'entity', '{"name":"alpha"}')`).run();
    const seed = db.prepare(`INSERT INTO session_handoffs (id, project_id, from_agent, summary, tenant_id) VALUES (?, ?, 'x', 'take over', ?)`);
    seed.run('h-uuid', 'u-alpha', 't1');    // already a UUID in ITS tenant
    seed.run('h-name', 'alpha', 't1');      // resolvable name
    seed.run('h-unknown', 'mystery', 't1'); // no candidate
    seed.run('h-amb', 'dup', 't1');         // two distinct candidates
    seed.run('h-cross', 'alpha', 't2');     // same NAME, other tenant — must not map
    return db;
  };
  const directory = directoryFor({
    t1: {
      alpha: [{ id: 'u-alpha', name: 'alpha', matchedBy: 'canonical_name' }],
      dup: [
        { id: 'u-d1', name: 'dup-one', matchedBy: 'alias' },
        { id: 'u-d2', name: 'dup-two', matchedBy: 'alias' },
      ],
    },
    t2: {},
  });

  it('plan is a READ-ONLY dry run classifying every row DISTINCTLY: alreadyUuid / mapped / unknown / ambiguous, tenant-locally', () => {
    const db = freshDb();
    const before = db.prepare(`SELECT * FROM session_handoffs ORDER BY id`).all();
    const plan = planHandoffBackfill(db, directory);
    expect(plan.totals).toEqual({ rows: 5, alreadyUuid: 1, mapped: 1, unknown: 2, ambiguous: 1 });
    expect(plan.mapped).toEqual([{ handoffId: 'h-name', tenantId: 't1', fromName: 'alpha', toProjectId: 'u-alpha', matchedBy: 'canonical_name' }]);
    expect(plan.unknown.map((u: any) => u.handoffId).sort()).toEqual(['h-cross', 'h-unknown']); // cross-tenant name NEVER maps
    expect(plan.ambiguous).toEqual([{ handoffId: 'h-amb', tenantId: 't1', name: 'dup', candidates: ['dup-one', 'dup-two'], candidateIds: ['u-d1', 'u-d2'] }]);
    expect(db.prepare(`SELECT * FROM session_handoffs ORDER BY id`).all()).toEqual(before); // dry run mutated nothing
  });

  it('apply updates ONLY mapped rows and ONLY project_id — unknown/ambiguous/cross-tenant untouched, nothing consumed or deactivated', () => {
    const db = freshDb();
    const result = applyHandoffBackfill(db, planHandoffBackfill(db, directory), directory);
    expect(result.updated).toBe(1);
    const rows = Object.fromEntries((db.prepare(`SELECT id, project_id, consumed_at, active FROM session_handoffs`).all() as any[]).map((r) => [r.id, r]));
    expect(rows['h-name']).toEqual({ id: 'h-name', project_id: 'u-alpha', consumed_at: null, active: 1 });
    expect(rows['h-unknown'].project_id).toBe('mystery');
    expect(rows['h-amb'].project_id).toBe('dup');
    expect(rows['h-cross'].project_id).toBe('alpha');
    expect(rows['h-uuid'].project_id).toBe('u-alpha');
  });

  it('repeat runs are idempotent: the second plan maps nothing and the second apply updates nothing', () => {
    const db = freshDb();
    applyHandoffBackfill(db, planHandoffBackfill(db, directory), directory);
    const second = planHandoffBackfill(db, directory);
    expect(second.totals.mapped).toBe(0);
    expect(second.totals.alreadyUuid).toBe(2); // h-uuid + the newly-mapped h-name
    expect(applyHandoffBackfill(db, second, directory).updated).toBe(0);
  });

  it('a mid-apply failure rolls back the WHOLE batch — no partially-backfilled state', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO shared_memory VALUES ('u-poison', 't1', 'entity', '{"name":"poison"}')`).run();
    db.prepare(`INSERT INTO session_handoffs (id, project_id, from_agent, summary, tenant_id) VALUES ('h-poison', 'poison', 'x', 's', 't1')`).run();
    db.exec(`CREATE TRIGGER test_poison BEFORE UPDATE ON session_handoffs
             WHEN NEW.project_id = 'u-poison'
             BEGIN SELECT RAISE(ABORT, 'test poison'); END`);
    const plan = planHandoffBackfill(db, directoryFor({
      t1: {
        alpha: [{ id: 'u-alpha', name: 'alpha', matchedBy: 'canonical_name' }],
        poison: [{ id: 'u-poison', name: 'poison', matchedBy: 'canonical_name' }],
      },
    }));
    expect(plan.totals.mapped).toBe(2);
    const poisonDir = directoryFor({
      t1: {
        alpha: [{ id: 'u-alpha', name: 'alpha', matchedBy: 'canonical_name' }],
        poison: [{ id: 'u-poison', name: 'poison', matchedBy: 'canonical_name' }],
      },
    });
    expect(() => applyHandoffBackfill(db, plan, poisonDir)).toThrow(/test poison/);
    const rows = Object.fromEntries((db.prepare(`SELECT id, project_id FROM session_handoffs`).all() as any[]).map((r) => [r.id, r.project_id]));
    expect(rows['h-name']).toBe('alpha'); // first update rolled back with the batch
    expect(rows['h-poison']).toBe('poison');
  });

  it('an unrecognized plan version is refused outright', () => {
    const db = freshDb();
    expect(() => applyHandoffBackfill(db, { reportVersion: 99, mapped: [] }, directory)).toThrow(/unrecognized backfill plan/);
  });

  // REGRESSIONS (sol b2543ebc P1): the plan is UNTRUSTED — apply revalidates
  // every entry in-transaction and one bad entry kills the whole batch.
  it("REPRO: a tampered plan pointing a t1 handoff at an entity that exists ONLY in t2 fails CLOSED — nothing updated", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO shared_memory VALUES ('u-foreign', 't2', 'entity', '{"name":"foreign"}')`).run();
    expect(() => applyHandoffBackfill(db, {
      reportVersion: 1,
      mapped: [{ handoffId: 'h-name', tenantId: 't1', fromName: 'alpha', toProjectId: 'u-foreign' }],
    }, directory)).toThrow(/not an entity in tenant t1/);
    expect((db.prepare(`SELECT project_id FROM session_handoffs WHERE id='h-name'`).get() as any).project_id).toBe('alpha');
  });

  it('a nonexistent destination fails CLOSED', () => {
    const db = freshDb();
    expect(() => applyHandoffBackfill(db, {
      reportVersion: 1,
      mapped: [{ handoffId: 'h-name', tenantId: 't1', fromName: 'alpha', toProjectId: 'u-nowhere' }],
    }, directory)).toThrow(/not an entity in tenant/);
  });

  it('a tampered target (existing same-tenant entity that current resolution does NOT yield) fails CLOSED and rolls back valid siblings', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO shared_memory VALUES ('u-other-real', 't1', 'entity', '{"name":"other"}')`).run();
    const good = { handoffId: 'h-name', tenantId: 't1', fromName: 'alpha', toProjectId: 'u-alpha' };
    const tampered = { handoffId: 'h-unknown', tenantId: 't1', fromName: 'mystery', toProjectId: 'u-other-real' };
    expect(() => applyHandoffBackfill(db, { reportVersion: 1, mapped: [good, tampered] }, directory))
      .toThrow(/stale\/remapped\/tampered/);
    expect((db.prepare(`SELECT project_id FROM session_handoffs WHERE id='h-name'`).get() as any).project_id).toBe('alpha'); // whole batch rolled back
  });

  it('duplicate mapped entries are rejected outright', () => {
    const db = freshDb();
    const entry = { handoffId: 'h-name', tenantId: 't1', fromName: 'alpha', toProjectId: 'u-alpha' };
    expect(() => applyHandoffBackfill(db, { reportVersion: 1, mapped: [entry, { ...entry }] }, directory))
      .toThrow(/duplicate mapped entry/);
  });

  it('a STALE plan (resolution changed since planning — now ambiguous) fails CLOSED', () => {
    const db = freshDb();
    const plan = planHandoffBackfill(db, directory);
    // Between plan and apply, 'alpha' became ambiguous in t1.
    const driftedDirectory = directoryFor({
      t1: {
        alpha: [
          { id: 'u-alpha', name: 'alpha', matchedBy: 'canonical_name' },
          { id: 'u-alpha-2', name: 'alpha-two', matchedBy: 'alias' },
        ],
      },
    });
    expect(() => applyHandoffBackfill(db, plan, driftedDirectory)).toThrow(/stale\/remapped\/tampered/);
    expect((db.prepare(`SELECT project_id FROM session_handoffs WHERE id='h-name'`).get() as any).project_id).toBe('alpha');
  });

  it('malformed entries (missing fields) are rejected outright', () => {
    const db = freshDb();
    expect(() => applyHandoffBackfill(db, {
      reportVersion: 1,
      mapped: [{ handoffId: 'h-name', tenantId: 't1', toProjectId: 'u-alpha' }],
    }, directory)).toThrow(/malformed mapped entry/);
  });
});

// ---------------------------------------------------------------------------
// Step-3 item B — registration + tool diet (sol 4320b5c5). Local test server
// on :memory: only; flips the five registration-gated todos.
// ---------------------------------------------------------------------------

describe('STEP-3 B — registration, tool diet, resources (executable)', () => {
  let server: any;

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { NeuralMCPServer } = await import('../src/unified-neural-mcp-server.js');
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
  });

  const call = async (name: string, args: Record<string, any>) =>
    (server as any)._handleToolCall(name, args);

  it('tools/list is exactly the retained, read-discovery, and two ENG-4 state surfaces', async () => {
    const listed = (await (server as any)._handleToolsList()).tools.map((t: any) => t.name).sort();
    expect(listed).toEqual([...RETAINED_LEGACY_TOOLS, ...READ_DISCOVERY_TOOLS, 'resume', 'checkpoint'].sort());
    for (const retired of RETIRED_TOOLS) expect(listed).not.toContain(retired);
    expect(listed.filter((n: string) => /snapshot|history|changes|get_checkpoint/.test(n))).toEqual([]);
  });

  it('resume and checkpoint are registered ATOMICALLY: listed schema is the frozen input schema the handler validates against', async () => {
    const listed = (await (server as any)._handleToolsList()).tools;
    const resumeTool = listed.find((t: any) => t.name === 'resume');
    expect(resumeTool.inputSchema).toBe(RESUME_INPUT_SCHEMA); // same object, not a copy
    const badInput = await call('resume', { agentId: 'a' });
    expect(badInput.isError).toBe(true);
    expect(String(badInput.content?.[0]?.text ?? '')).toMatch(/invalid params/);
  });

  // REGRESSIONS (sol Step-3 verdict a6c75553): lifecycle wrapper DISCOVERY
  // must be truthful — an agent following tools/list can never be handed a
  // schema the committed B2 handlers reject.
  it('lifecycle wrapper discovery is TRUTHFUL: end_session advertises the frozen checkpoint schema, begin_session advertises both supported shapes', async () => {
    const listed = (await (server as any)._handleToolsList()).tools;
    const beginTool = listed.find((t: any) => t.name === 'begin_session');
    const endTool = listed.find((t: any) => t.name === 'end_session');

    // end_session IS checkpoint: same frozen object, not a lookalike copy.
    expect(endTool.inputSchema).toBe(CHECKPOINT_INPUT_SCHEMA);
    expect(endTool.description).toMatch(/checkpoint/);
    expect(endTool.description).not.toMatch(/Slack|handoff flag/i);
    expect(beginTool.inputSchema).toBe(BEGIN_SESSION_DISCOVERY_INPUT_SCHEMA);
    expect(beginTool.description).not.toMatch(/skeleton|Slack/i);
    expect(beginTool.description).toMatch(/NEVER auto-consumes/i);

    // The advertised end_session schema accepts the supported checkpoint
    // shape and REJECTS the retired legacy {projectId, summary} shape.
    expect(validCheckpoint({
      agentId: 'fable-engram', scope: { project: 'engram' }, expectedRevision: null,
      idempotencyKey: 'k-discovery', state: { objective: 'o', status: 's', owner: 'me', nextActions: [], blockers: [], guardrails: [] },
    })).toBe(true);
    expect(validCheckpoint({ agentId: 'a', projectId: 'engram', summary: 'done' })).toBe(false);

    // The advertised begin_session schema accepts BOTH supported shapes —
    // wrapper (scope/budget/ackHandoffIds) and pinned legacy (adapter) —
    // and rejects a shapeless call.
    const validBeginDiscovery = ajv.compile(beginTool.inputSchema as any);
    expect(validBeginDiscovery({ agentId: 'a', scope: { project: 'engram' }, budget: 1024 })).toBe(true);
    expect(validBeginDiscovery({ agentId: 'a', scope: { project: 'engram' }, budget: 1024, ackHandoffIds: ['h1'] })).toBe(true);
    expect(validBeginDiscovery({ agentId: 'a', projectId: 'engram' })).toBe(true);
    expect(validBeginDiscovery({ agentId: 'a', projectId: 'engram', maxTokens: 2000 })).toBe(true);
    expect(validBeginDiscovery({ agentId: 'a' })).toBe(false);

    // MIXED legacy+wrapper shapes are schema-REJECTED (sol 4c587d4f): the
    // handler branches on args.scope and would IGNORE projectId/maxTokens,
    // so a schema that let them validate as legacy would advertise
    // semantics (projectId→scope, maxTokens→budget) the handler ignores.
    expect(validBeginDiscovery({ agentId: 'a', scope: { project: 'scope-A' }, projectId: 'legacy-B', maxTokens: 512 })).toBe(false);
    expect(validBeginDiscovery({ agentId: 'a', scope: { project: 'scope-A' }, budget: 1024, projectId: 'legacy-B' })).toBe(false);
    expect(validBeginDiscovery({ agentId: 'a', projectId: 'legacy-B', budget: 512 })).toBe(false);
    expect(validBeginDiscovery({ agentId: 'a', projectId: 'legacy-B', ackHandoffIds: ['h1'] })).toBe(false);
    // …while the legacy branch stays permissive on NON-wrapper extras,
    // matching the pre-diet advertised contract.
    expect(validBeginDiscovery({ agentId: 'a', projectId: 'engram', userId: 'u-1', someLegacyExtra: true })).toBe(true);
  });

  it('advertised lifecycle contracts are LIVE contracts: schema-following calls succeed through the registered handlers; the retired end_session shape gets the migration error', async () => {
    await call('create_entities', { entities: [{ name: 'discovery-proj', entityType: 'project', observations: ['charter: discovery truth'] }] });
    const closed = await call('end_session', {
      agentId: 'fable-engram', scope: { project: 'discovery-proj' }, expectedRevision: null,
      idempotencyKey: 'k-discovery-end1', state: { objective: 'discovery truth', status: 'green', owner: 'fable-engram', nextActions: [], blockers: [], guardrails: [] },
    });
    expect(closed.structuredContent.outcome).toBe('written');
    const legacy = await call('end_session', { agentId: 'fable-engram', projectId: 'discovery-proj', summary: 'done' });
    expect(legacy.isError).toBe(true);
    expect(String(legacy.content?.[0]?.text ?? '')).toMatch(/checkpoint/);
    // begin_session legacy shape (still advertised) works via the adapter.
    const bundle = await call('begin_session', { agentId: 'fable-engram', projectId: 'discovery-proj' });
    expect(bundle.structuredContent.working.status).toBe('green');
    // MIXED shapes are OUTSIDE the advertised contract (schema-rejected,
    // sol 4c587d4f); the handler's off-contract behavior is nonetheless
    // DETERMINISTIC — args.scope wins, projectId/maxTokens are ignored —
    // pinned here so any future change to that preference is a visible diff.
    const mixed = await call('begin_session', {
      agentId: 'fable-engram', scope: { project: 'discovery-proj' }, projectId: 'no-such-project', maxTokens: 512,
    });
    expect(mixed.structuredContent.working.status).toBe('green'); // scope won: discovery-proj state, not 'no-such-project'
    expect(mixed.structuredContent.coverage.budget).toBe(4000);   // wrapper default; maxTokens ignored
  });

  it('end-to-end through the REGISTERED handlers: checkpoint writes, resume returns a validated bundle, text fallback IS the same validated object', async () => {
    await call('create_entities', { entities: [{ name: 'step3-proj', entityType: 'project', observations: ['charter: prove registration'] }] });
    const cpResult = await call('checkpoint', {
      agentId: 'fable-engram', scope: { project: 'step3-proj' }, expectedRevision: null,
      idempotencyKey: 'k-step3-b1', state: { objective: 'register', status: 'green', owner: 'fable-engram', nextActions: [], blockers: [], guardrails: [] },
    });
    expect(cpResult.structuredContent.outcome).toBe('written');
    expect(JSON.parse(cpResult.content[0].text)).toEqual(cpResult.structuredContent); // same validated object
    const rz = await call('resume', { agentId: 'fable-engram', scope: { project: 'step3-proj' }, budget: 4000 });
    expect(validBundle(rz.structuredContent), JSON.stringify(validBundle.errors)).toBe(true);
    expect(rz.structuredContent.working.status).toBe('green');
    expect(JSON.parse(rz.content[0].text)).toEqual(rz.structuredContent);
  });

  it('malformed output fails CLOSED before transport via the SAME compiled {$data:true} validators the handler uses (all builds)', () => {
    expect(() => validateEng4Output('resume', { schemaVersion: 1 })).toThrow(Eng4OutputValidationError);
    expect(() => validateEng4Output('checkpoint', { outcome: 'conflict', heads: [] })).toThrow(Eng4OutputValidationError);
    // The closedness rule is $data-backed — a lying coverage object must die here.
    expect(() => validateEng4Output('checkpoint', { outcome: 'written' })).toThrow(Eng4OutputValidationError);
  });

  it('engram:// resources are DISCOVERABLE via templates and READABLE via the verified scope-bound path; history is never a tool', async () => {
    expect(ENG4_RESOURCE_TEMPLATES.map((t) => t.uriTemplate)).toEqual([
      'engram://snapshot/{scopeKey}/{stateId}',
      'engram://message/{scopeKey}/{recipientAgentId}/{messageId}',
      'engram://handoff/{scopeKey}/{handoffId}',
    ]);
    const rz = await call('resume', { agentId: 'fable-engram', scope: { project: 'step3-proj' }, budget: 4000 });
    const handle = rz.structuredContent.evidence[0];
    const read = (server as any)._handleResourceRead(handle.uri);
    expect(read.contents[0].mimeType).toBe('application/json');
    const digest = createHash('sha256').update(Buffer.from(read.contents[0].text, 'utf8')).digest('hex');
    expect(digest).toBe(handle.contentHash);
  });

  it('no-other-DB-path: eng4 runtime modules never open a database — they only ever use the injected server handle', () => {
    const eng4Dir = fileURLToPath(new URL('../src/unified-server/eng4/', import.meta.url));
    for (const file of ['init.ts', 'resolver.ts', 'checkpoint.ts', 'resume.ts', 'resource.ts', 'session.ts', 'register.ts', 'canonical.ts', 'contracts.ts', 'schemas.ts']) {
      const source = readFileSync(`${eng4Dir}${file}`, 'utf8');
      expect(source.includes('new Database('), `${file} must not open its own DB`).toBe(false);
      expect(source.includes("require('better-sqlite3')"), `${file} must not open its own DB`).toBe(false);
    }
  });
});

// Budget & lossless reachability: fully EXECUTABLE across the 2(c) resume
// suite (accounting/closedness/ceiling/cursors) and the 2(d) suite
// (evidence-handle round-trip with hash+size verification).

// Scoped messages: scoped-only selection + read-only guarantee are
// EXECUTABLE in the 2(c) suite; oversized-body handle substitution and its
// round-trip are EXECUTABLE in the 2(d) suite.

// History v1: fetch/verification/URI/changes-since are EXECUTABLE in the
// 2(d) suite; tools-list closure + resources discoverability are EXECUTABLE
// in the Step-3 B registration suite.

// Facts runtime behaviors (unresolved contradicts surfaced, server-owned
// recordedAt, effectiveAt verbatim-or-absent) are EXECUTABLE across the
// 2(c) materialization and resume suites.

// Handoff acknowledgement (read-never-consumes, explicit per-agent acks,
// handoff items with caller-specific ackedByMe) is EXECUTABLE in the 2(d)
// suite.

// Asserted identity (exact opaque per-agent author and ack views),
// handoff ack fail-closed (atomic same-tenant existence check, cross-tenant
// denial), and the remaining tenant-isolation cases (stateId/revision/URI
// resource fetches) are all EXECUTABLE in the 2(d) suite.

// Idempotency content verification (b2e6fc7c #4) is EXECUTABLE in the 2(b)
// checkpoint runtime suite above: exact stored fingerprint, replay,
// mismatch-writes-nothing, and exact-canonical-bytes binding.

// Fail-closed output validation (compiled-once {$data:true} validators in
// every build, pre-transport rejection, text-fallback-from-same-object) and
// the no-other-DB-path boundary are EXECUTABLE in the Step-3 B registration
// suite. The 2(a) schema-init suite covers the DDL application boundary.
