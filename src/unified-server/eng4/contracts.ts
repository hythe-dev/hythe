/**
 * ENG-4 v1 contracts — resume / checkpoint / bundle sections.
 *
 * Spec of record: neural entity `engram-eng4-spec` (frozen 2026-07-15,
 * observation e51a0eb0). Amended per engram-sol Track B review 4179250c.
 * This module is SCAFFOLD ONLY: types compile and are exercised by the
 * executable invariant tests, but no runtime tool is wired to them yet.
 * Deferred non-goals stay absent: no confidence, no validFrom/validTo,
 * no time-based asOf replay.
 *
 * Design invariants (spec A-items / review fixes in parentheses):
 * - EXACTLY TWO primitives: resume + checkpoint. History fetch is a typed
 *   RESOURCE addressed via ContentHandle — never a third tool (review #5).
 * - Storage identity is stable entity UUIDs + a deterministic NOT NULL
 *   scopeKey; a scope requires project or task (review #1).
 * - revision is unique per scope; branches are parent-linked; parents never
 *   cross scopes (review #2).
 * - Facts are typed subject/predicate/object assertions with source refs and
 *   contradiction links (review #3).
 * - Scope resolution is exact/canonical THEN typed graph walk — substring and
 *   semantic matching are forbidden in the resume path (A3).
 * - entity definition and current state are separate fields (A4).
 * - checkpoint is CAS-guarded and idempotent; concurrent heads are surfaced,
 *   never silently resolved (A5).
 * - Budgets follow lossless reachability: every omission is accounted for and
 *   fetchable via a typed handle; an inline body and a handle are mutually
 *   exclusive per item (A2, review #4).
 * - TENANT ISOLATION (review b2e6fc7c #3): tenant identity comes from
 *   RequestContext server-side and is NEVER a caller parameter and NEVER
 *   leaked in bundles; every eng4 storage row is tenant-composite-keyed, so
 *   knowing another tenant's scopeKey/stateId/URI grants nothing.
 * - FAIL-CLOSED OUTPUT (review b2e6fc7c #5): the Ajv {$data:true} validators
 *   are compiled once and validate runtime output in ALL builds including
 *   production; the MCP text fallback is derived from the SAME validated
 *   object as structuredContent.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Caller-supplied scope. AT LEAST ONE of project/task is required (both
 * allowed) — enforced at the type level as a union; names/aliases are
 * accepted here and exact-resolved server-side.
 */
export type ScopeRef =
  | { project: string; task?: string }
  | { task: string; project?: string };

/**
 * Deterministic, NOT NULL storage scope key derived from resolved entity
 * UUIDs — never from names (review #1; UUIDs survive renames):
 *   project only:  `p:<projectUuid>`
 *   task only:     `t:<taskUuid>`
 *   both:          `p:<projectUuid>|t:<taskUuid>`
 * NULL never participates in uniqueness; SQLite UNIQUE treats NULLs as
 * distinct, which broke idempotency in the unamended DDL (sol repro).
 */
export type ScopeKey = string;

/** Server-resolved scope. Resolution is exact/canonical only (A3). */
export interface ResolvedScope {
  /** Stable entity UUID, not a name. */
  projectId: string | null;
  /** Stable entity UUID, not a name. */
  taskId: string | null;
  /**
   * NULL for unknown/ambiguous refs — a storage key is NEVER synthesized
   * for an unresolved scope (review e0d81d4d #3).
   */
  scopeKey: ScopeKey | null;
  /** Aliases that matched during resolution, for caller transparency. */
  aliasesMatched: string[];
  /**
   * Set when the ref was ambiguous (several canonical candidates). The call
   * fails closed with these candidates rather than guessing.
   */
  ambiguousCandidates?: string[];
}

// ---------------------------------------------------------------------------
// Facts (control plane — review #3)
// ---------------------------------------------------------------------------

export type FactStatus = 'asserted' | 'verified' | 'disputed' | 'superseded';

/** Typed assertion — subject/predicate/object, not free prose. */
export interface FactAssertion {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Fact time model (v1): recordedAt is server-owned and required; effectiveAt
 * is optional, caller-supplied, and NEVER server-invented — absent means
 * unknown. confidence and validTo are deferred non-goals.
 */
export interface CurrentFact {
  factId: string;
  assertion: FactAssertion;
  status: FactStatus;
  /** Pointers to supporting artifacts (commits, observations, handles). */
  evidenceRefs: string[];
  /** Pointers to where the fact came from (messages, docs, agents). */
  sourceRefs: string[];
  author: string;
  recordedAt: string; // ISO, server-owned
  effectiveAt?: string; // ISO, optional, when-true-in-world
  /** factIds this fact contradicts; surfaced to the caller, never hidden. */
  contradicts: string[];
}

/** Caller-supplied fact change inside checkpoint (server assigns id/time). */
export interface FactChange {
  factId?: string; // present = update/supersede that fact
  assertion: FactAssertion;
  status: FactStatus;
  evidenceRefs: string[];
  sourceRefs: string[];
  effectiveAt?: string;
  contradicts?: string[];
}

// ---------------------------------------------------------------------------
// State / revisions (control plane)
// ---------------------------------------------------------------------------

/**
 * An immutable state snapshot (A5, history v1).
 * revision is UNIQUE PER SCOPE (monotonic assignment at write time), so
 * fetch-by-revision is deterministic even when concurrent heads exist;
 * branches remain distinguishable via parentStateId (review #2). Parents
 * never reference a snapshot from another scope.
 */
export interface StateSnapshot {
  stateId: string;
  scopeKey: ScopeKey;
  revision: number;
  parentStateId: string | null;
  /** sha256 of the canonical CONTENT envelope (resource bytes). */
  contentHash: string;
  /** Exact opaque agent principal — the one author rule (5868b61b #2). */
  author: string;
  /** Raw asserted id, audit metadata only. */
  assertedAgentId: string;
  recordedAt: string;
  state: WorkingState;
}

export interface WorkingState {
  objective: string;
  status: string;
  owner: string;
  nextActions: string[];
  blockers: string[];
  guardrails: string[];
}

// ---------------------------------------------------------------------------
// Open loops
// ---------------------------------------------------------------------------

export type LoopStatus = 'open' | 'blocked' | 'closed';

/**
 * Structured loop record — never free prose (A8). A resume SECTION only in
 * v1: there is no open_loops alias tool (review #5, reviewer call resolved).
 */
export interface OpenLoop {
  loopId: string;
  scopeKey: ScopeKey;
  projectId: string | null;
  taskId: string | null;
  owner: string;
  status: LoopStatus;
  openedAt: string;
  updatedAt: string;
  dueAt?: string;
  blockedOn?: string;
  nextAction: string;
  /** Set when status === 'closed'. */
  closeEvent?: { closedAt: string; closedBy: string; outcome: string };
  revision: number;
}

/** Caller-supplied loop change inside checkpoint. */
export interface LoopChange {
  loopId?: string; // present = update that loop
  status: LoopStatus;
  nextAction: string;
  owner?: string;
  dueAt?: string;
  blockedOn?: string;
  closeOutcome?: string; // required by the server when status === 'closed'
}

// ---------------------------------------------------------------------------
// Handles, messages (A2, A6 — body XOR handle, review #4)
// ---------------------------------------------------------------------------

/**
 * Typed handle to full content omitted from the bundle (A2). History fetch
 * (kind 'state-snapshot') goes through THIS — addressed as a typed resource,
 * explicitly never registered as a tool (review #5). Selector for snapshots
 * is exactly one of stateId | revision (enforced by schema + tests).
 *
 * URIs use the product-stable, URL-encoded `engram://` template (review
 * e0d81d4d #4), e.g. engram://snapshot/<encodeURIComponent(scopeKey)>/<stateId>;
 * raw scope delimiters never appear in a URI.
 *
 * Snapshot/payload handles MUST be verifiable: contentHash + byteLength +
 * mediaType are required so a fetched body can be hash/size-checked.
 * Message/observation handles are reference-only. Message URIs bind the
 * exact recipient as well as tenant, scope, and row id; they remain bearer
 * capabilities unless the transport authenticates that recipient.
 */
export type ContentHandle =
  | {
      kind: 'state-snapshot' | 'payload';
      /** engram:// resource URI (URL-encoded path segments). */
      uri: string;
      contentHash: string;
      byteLength: number;
      mediaType: string;
    }
  | {
      kind: 'message' | 'observation';
      /** engram:// resource URI (URL-encoded path segments). */
      uri: string;
      contentHash?: string;
      byteLength?: number;
      mediaType?: string;
    };

/**
 * Typed inbox items in the resume messages section (A6 + review b2e6fc7c
 * #2): scoped MESSAGES and HANDOFFS travel in one section with one coverage
 * accounting. resume() NEVER marks messages read and NEVER consumes
 * handoffs — handoff acknowledgement is explicit (per-agent, per-tenant)
 * via the begin_session wrapper's ackHandoffIds. Exactly one of body/handle
 * is non-null on every item (XOR).
 */
interface InboxItemBase {
  from: string;
  recordedAt: string;
}
type BodyXorHandle = { body: string; handle: null } | { body: null; handle: ContentHandle };

export type InboxItem =
  | (InboxItemBase & {
      itemType: 'message';
      messageId: string;
      priority: 'low' | 'normal' | 'high' | 'urgent';
    } & BodyXorHandle)
  | (InboxItemBase & {
      itemType: 'handoff';
      handoffId: string;
      /** THIS caller's ack state — other agents' acks are invisible here. */
      ackedByMe: boolean;
    } & BodyXorHandle);

// ---------------------------------------------------------------------------
// Coverage accounting (A2 — silent trimming is failure)
// ---------------------------------------------------------------------------

/**
 * Coverage closedness (review e0d81d4d #2): the bundle carries coverage for
 * ALL SEVEN sections on every response — sections excluded via `sections`
 * report omittedReason='not-requested'. Locked relationships:
 * contentComplete=true ⇒ includedCount===totalCount ∧ omittedReason='none'
 * ∧ nextCursor=null; contentComplete=false ⇒ an explicit reason and a
 * cursor/handles path to the remainder.
 */
export interface SectionCoverage {
  includedCount: number;
  totalCount: number;
  contentComplete: boolean;
  /**
   * 'undesignated' / 'unversioned' are schemaVersion=3 ONLY (H4, §6.4/§6.5):
   * currentFacts/openLoops ids suppressed because the scope has no accepted
   * lineage, or because the id's newest accepted-lineage change has no
   * proven version. totalCount includes them; legacyValues is the explicit
   * alternate retrieval path; nextCursor is null.
   */
  omittedReason: 'budget' | 'cursor' | 'not-requested' | 'none' | 'undesignated' | 'unversioned';
  nextCursor: string | null;
  tokenEstimate: number;
  /**
   * schemaVersion=3 ONLY, currentFacts/openLoops: how many of totalCount are
   * SUPPRESSED ids (never delivered on any page; see legacyValues). Fixed
   * size, so the count is visible on every page regardless of budget/cursor
   * (independent review of PR #14, finding 2).
   */
  suppressedCount?: number;
}

export type ResumeSectionName =
  | 'working'
  | 'openLoops'
  | 'messages'
  | 'currentFacts'
  | 'decisions'
  | 'evidence'
  | 'pointers'
  /** schemaVersion>=2 ONLY: the budgeted capsule section (item 0 = current, rest = conflicts). */
  | 'capsule'
  /** schemaVersion=3 ONLY (H1): every live head, budgeted, ordered right after capsule. */
  | 'heads'
  /** schemaVersion=3 ONLY (H4): materialized divergent terminal values off the accepted lineage. */
  | 'divergentValues'
  /** schemaVersion=3 ONLY (H4): non-authoritative in-place rows (undesignated scope or unversioned id); LAST in order (§9.3). */
  | 'legacyValues';

/** The seven frozen v1 sections. */
export type ResumeSectionNameV1 = Exclude<ResumeSectionName, 'capsule' | 'heads' | 'divergentValues' | 'legacyValues'>;

// ---------------------------------------------------------------------------
// resume (primitive 1 of exactly 2)
// ---------------------------------------------------------------------------

export interface ResumeParams {
  /**
   * ASSERTED caller identity (reviews b2e6fc7c #1 + 07b3906e #3): required
   * because the shared API key cannot distinguish agents; bounded to the
   * platform's 100-char convention. The exact, case-sensitive, tenant-scoped
   * handle owns authorship, acknowledgements, and unread views. Display names,
   * metadata aliases, historical identity changes, and transport suffixes do
   * not merge principals. Distinct asserted handles therefore keep distinct
   * views; the raw asserted id is also preserved in audit metadata.
   */
  agentId: string;
  scope: ScopeRef;
  /**
   * Bundle-shape opt-in (2026-09-03, data-audit HIGH 1). Absent or 1 → the
   * frozen schemaVersion=1 bundle. 2 → schemaVersion=2: the v1 bundle plus
   * `capsule`, the scope entity's rehydration capsule selected BY KIND
   * (newest unsuperseded observation with metadata.kind='capsule'), never by
   * recency alone, with any other unsuperseded capsules reported as conflicts.
   * 3 (ENG-4 H-series, INTERNAL until H5 finalizes it — design 3429000
   * §2.10) → schemaVersion=3: the v2 bundle plus the fixed-size head-selection
   * fields on asOf and the budgeted `heads` section (H1).
   */
  resultVersion?: 1 | 2 | 3;
  /** Hard total token budget for the assembled bundle. */
  budget: number;
  /** Optional subset of sections; default = all, in canonical order. */
  sections?: ResumeSectionName[];
  /** Pagination cursor from a prior coverage.nextCursor. */
  cursor?: string;
}

/**
 * begin_session is an OPTIONAL lifecycle wrapper over resume — never an
 * alternate bootstrap primitive. It must not auto-consume handoffs: acking
 * is explicit via ackHandoffIds (review b2e6fc7c #2). end_session is the
 * corresponding wrapper over checkpoint.
 */
export interface BeginSessionWrapperParams {
  agentId: string;
  scope: ScopeRef;
  budget: number;
  /** Handoffs this agent explicitly acknowledges (per-agent, per-tenant). */
  ackHandoffIds?: string[];
}

/** Staleness/conflict header — rot must be visible, never silent (A4, A5). */
export interface AsOfHeader {
  assembledAt: string;
  stateId: string | null;
  revision: number | null;
  stateAgeSec: number | null;
  stale: boolean;
  /** Concurrent heads, if the state has forked. Never auto-resolved. */
  conflicts: Array<{ stateId: string; revision: number; author: string; recordedAt: string }>;
  // --- schemaVersion=3 ONLY (ENG-4 H1, design 3429000 §3.5): fixed-size
  // head-selection fields. Absent on the frozen v1/v2 bundles.
  /** How `working` was chosen — the ONE resolver's mode (heads.ts). */
  selection?: HeadSelection;
  /** The scope's current-head pointer row, or null (empty/legacy scope). */
  pointer?: ScopePointerView | null;
  liveHeadCount?: number;
  /** Live heads other than the effective current head. */
  divergentHeadCount?: number;
  /** Retired snapshots in the scope (H3). */
  retiredHeadCount?: number;
  /** H4: UNRESOLVED divergent terminals with no truthful value (unversioned) — rejections a reconcile still owes; they are also listed in divergentValues with value null. */
  opaqueDivergentCount?: number;
}

export type HeadSelection = 'empty-scope' | 'max-revision' | 'pointer' | 'invalid-designation';

export interface ScopePointerView {
  stateId: string;
  revision: number;
  advancedAt: string;
  advancedBy: string;
  reason: 'first-write' | 'advance' | 'reconcile';
}

/**
 * One live head in the schemaVersion=3 `heads` section (H1). `isCurrent` is
 * true for exactly the effective current head (never more than one; zero
 * under 'empty-scope' / 'invalid-designation'). `parentRetired` is required
 * and constantly false until H3 starts setting it — the item shape does not
 * change then (19826044 precision item).
 */
export interface HeadItem {
  stateId: string;
  revision: number;
  author: string;
  recordedAt: string;
  isCurrent: boolean;
  parentRetired: boolean;
}

/**
 * The resume bundle (structuredContent). Section order is contractual:
 * identity/guardrails → current state → blockers/loops → next actions →
 * scoped unread messages → facts/decisions → evidence/pointers → coverage.
 */
/**
 * One rehydration-capsule observation on the scope entity (resultVersion=2).
 * Selected BY KIND: metadata.kind === 'capsule' and not superseded by ANY
 * observation on that entity. Recency alone never decides — an unrelated
 * newer append cannot displace it (data-audit HIGH 1, 2026-09-03).
 */
export interface CapsuleObservation {
  observationId: string;
  entityId: string;
  recordedAt: string;
  author: string;
  canonicalFact: string | null;
  contents: string[];
}

export interface ResumeCapsule {
  /**
   * Newest unsuperseded kind=capsule observation. null when none exists OR
   * when the budget/cursor omitted it — coverage.capsule and `complete`
   * distinguish the two; `current: null` is never silently "absent".
   */
  current: CapsuleObservation | null;
  /** Every OTHER unsuperseded kind=capsule observation delivered on this page, newest first — a fork to reconcile. */
  conflicts: CapsuleObservation[];
  /** Every visible observation on the scope entity examined (FULL indexed scan, not a window). */
  candidatesConsidered: number;
  /**
   * true iff current AND all conflicts are delivered on this page
   * (== coverage.capsule.contentComplete). false → continue with
   * coverage.capsule.nextCursor or a larger budget; nothing was trimmed silently.
   */
  complete: boolean;
}

export interface ResumeBundle {
  /**
   * 1 = frozen bundle (default); 2 = v1 + capsule (request resultVersion=2);
   * 3 = v2 + head-selection asOf fields + `heads` (request resultVersion=3;
   * INTERNAL increment until H5 — design 3429000 §2.10).
   */
  schemaVersion: 1 | 2 | 3;
  resolvedScope: ResolvedScope;
  asOf: AsOfHeader;
  /** Charter/definition line — creation-time prose, NEVER current state (A4). */
  definition: string | null;
  /** Present ONLY on schemaVersion>=2. */
  capsule?: ResumeCapsule;
  /** Present ONLY on schemaVersion=3: every live head, budgeted (H1). */
  heads?: HeadItem[];
  /** Present ONLY on schemaVersion=3 (H4): materialized divergent terminals off the accepted lineage. */
  divergentValues?: unknown[];
  /** Present ONLY on schemaVersion=3 (H4): non-authoritative in-place rows; last section. */
  legacyValues?: unknown[];
  working: WorkingState | null;
  openLoops: OpenLoop[];
  messages: InboxItem[];
  currentFacts: CurrentFact[];
  decisions: Array<{ id: string; summary: string; recordedAt: string; evidenceRefs: string[] }>;
  evidence: ContentHandle[];
  pointers: Array<{ label: string; entity: string; relation: string }>;
  /** All seven v1 sections present ALWAYS (closedness — review e0d81d4d #2); `capsule` coverage ONLY on schemaVersion>=2; `heads` ONLY on 3. */
  coverage: Record<ResumeSectionNameV1, SectionCoverage> & {
    capsule?: SectionCoverage;
    heads?: SectionCoverage;
    divergentValues?: SectionCoverage;
    legacyValues?: SectionCoverage;
    totalTokenEstimate: number;
    budget: number;
  };
}

// ---------------------------------------------------------------------------
// checkpoint (primitive 2 of exactly 2)
// ---------------------------------------------------------------------------

export interface CheckpointParams {
  /**
   * ASSERTED caller identity (reviews b2e6fc7c #1 + 5868b61b #2). ONE
   * AUTHOR RULE: snapshot/fact authorship, ack ownership, and views belong
   * to this exact, case-sensitive, tenant-scoped handle. No alias family or
   * transport-suffix expansion is authorized. The same asserted id is kept
   * as audit metadata (assertedAgentId); the server never substitutes its own
   * identity.
   */
  agentId: string;
  scope: ScopeRef;
  /**
   * BRANCH-PRESERVING CAS (frozen semantics, review e0d81d4d #1):
   * expectedRevision identifies an EXISTING IMMUTABLE SAME-SCOPE PARENT —
   * liveness is NOT required. Extending any existing parent (stale included)
   * WRITES a branch child with a new globally-unique-per-scope revision;
   * revision allocation and insert happen in ONE transaction. Null asserts
   * "first write in this scope". outcome=conflict is reserved for: a missing
   * or wrong-scope parent, or null when the scope already has snapshots.
   * Concurrent heads therefore accumulate as branches and surface via
   * resume asOf.conflicts — divergence is visible, never blocked or lost.
   */
  expectedRevision: number | null;
  /**
   * Dedupes retries with CONTENT VERIFICATION (review b2e6fc7c #4): the
   * server compares the REQUEST FINGERPRINT (canonical.ts
   * requestFingerprint — exact RFC 8785 JCS with conformance vectors)
   * BEFORE replay. The fingerprint binds full semantic intent:
   * canonicalAgentId + expectedRevision + resolvedParentStateId + the
   * canonical content envelope — so a different agent, or the same agent
   * against a different CAS position, can NEVER replay someone else's
   * write (5868b61b #3). Same (tenant, scope, key) + same fingerprint →
   * idempotent-replay of the original; same key + different fingerprint →
   * outcome 'idempotency-mismatch', fail closed. The RESOURCE
   * contentHash/byteLength bind to the content envelope bytes alone
   * (envelopeContentHash) — operation fingerprint and resource hash are
   * deliberately distinct.
   */
  idempotencyKey: string;
  /**
   * Result-shape opt-in (PR A, 2026-09-03). Absent or 1 → the exact frozen
   * v1 result. 2 → written/idempotent-replay additionally carry `changes`
   * (CheckpointChanges). Bound into requestFingerprint only when 2, so a
   * same-key retry with a different resultVersion is an idempotency-mismatch
   * and legacy fingerprints are unchanged.
   */
  resultVersion?: 1 | 2 | 3;
  state: WorkingState;
  events?: Array<{ kind: string; summary: string; at?: string }>;
  factChanges?: FactChange[];
  loopChanges?: LoopChange[];
  evidenceRefs?: string[];
  // --- ENG-4 H3, resultVersion 3 ONLY (design §4, §4.5, §5.1). A v1/v2
  // request carrying any of these fails input validation.
  /** Absent → legacy `write`. `record`/`patch` arrive with H5. */
  operation?: CheckpointOperation;
  /** v3 `write` extending a RETIRED parent must say so (§4.5); never moves the pointer. */
  acknowledgeRetired?: boolean;
  /** reconcile: the EXACT live-head set (CAS); sorted server-side. */
  expectedHeads?: string[];
  /** reconcile: CAS on the pointer row's stateId (null = no row / legacy scope). */
  expectedPointer?: string | null;
  /** reconcile: the head that becomes this snapshot's parent; ∈ expectedHeads. */
  survivor?: string;
  /** reconcile: required free text. */
  reason?: string;
  /** reconcile: default true — any unresolved materialized divergent terminal refuses the call. */
  strict?: boolean;
  /** reconcile: explicit per-terminal resolutions. */
  resolutions?: DivergenceResolutionRequest[];
  /** reconcile: divergent head ids whose unresolved terminals are all rejected (expanded server-side). */
  rejectLineages?: string[];
}

export type CheckpointOperation = 'write' | 'reconcile';

/** One requested resolution of a divergent terminal change (§6.3). */
export interface DivergenceResolutionRequest {
  kind: 'fact' | 'loop';
  id: string;
  /** The terminal change's snapshot on the divergent lineage. */
  divergentStateId: string;
  decision: 'accept' | 'reject';
  /** accept ONLY: ordinal of this request's own factChanges/loopChanges entry re-asserting the value. */
  acceptedOrdinal?: number;
}

/** A resolution as recorded (payload-bound and in eng4_divergence_resolutions). */
export interface ResolutionRecord {
  kind: 'fact' | 'loop';
  id: string;
  divergentStateId: string;
  decision: 'accept' | 'reject';
  acceptedOrdinal: number | null;
}

/**
 * The normalized reconciliation record — bound into the reconcile
 * snapshot's envelope (contentHash) and mirrored by the merge-input,
 * retirement and resolution rows, which replay and resume verify against it.
 */
export interface ReconciliationRecord {
  expectedHeads: string[];
  survivor: string;
  retired: string[];
  expectedPointer: string | null;
  reason: string;
  strict: boolean;
  resolutions: ResolutionRecord[];
  /** Retired snapshots on the survivor's own chain re-adopted by this reconcile (requires acknowledgeRetired). */
  adoptedRetired: string[];
  unresolvedDivergent: { facts: number; loops: number };
}

/** v3 `written`/`idempotent-replay` block for operation reconcile (§4.6). */
export interface ReconciledBlock {
  survivor: string;
  retired: string[];
  pointer: string;
  resolutions: ResolutionRecord[];
  adoptedRetired: string[];
  /** Zero under strict (the default) by construction. */
  unresolvedDivergent: { facts: number; loops: number };
}

/**
 * What a checkpoint materialized (PR A, 2026-09-03). POSITIONAL: facts[i]
 * is the row factChanges[i] resolved to, loops[i] the row loopChanges[i]
 * resolved to. `created` is false when the caller supplied an existing id
 * that was updated in place. Recorded in eng4_snapshot_changes inside the
 * checkpoint transaction and integrity-bound by a stored digest
 * (eng4_state_snapshots.changes_hash) that replay verifies fail-closed; NOT
 * part of the canonical envelope (contentHash unaffected). Returned only when
 * the request opts in with resultVersion=2.
 */
export interface CheckpointChanges {
  facts: Array<{ factId: string; created: boolean }>;
  loops: Array<{ loopId: string; created: boolean }>;
}

export type CheckpointResult =
  | {
      outcome: 'written';
      stateId: string;
      scopeKey: ScopeKey;
      revision: number;
      parentStateId: string | null;
      contentHash: string;
      /** Present ONLY when the request set resultVersion>=2; empty arrays when nothing changed. */
      changes?: CheckpointChanges;
      /** Present ONLY on a resultVersion 3 `reconcile` (H3). */
      reconciled?: ReconciledBlock;
    }
  | {
      outcome: 'idempotent-replay';
      stateId: string;
      scopeKey: ScopeKey;
      revision: number;
      contentHash: string;
      /**
       * Present ONLY when the (fingerprint-matched) request set resultVersion=2,
       * and then never null: v2 is bound into the fingerprint, so a matched v2
       * replay was written by the ledger-aware writer; an absent ledger is
       * corruption and throws CheckpointIntegrityError instead. The SAME
       * changes the original write returned, read from the verified ledger.
       */
      changes?: CheckpointChanges;
      /** Present ONLY on a resultVersion 3 `reconcile` replay, after §4.3 parity. */
      reconciled?: ReconciledBlock;
    }
  | {
      outcome: 'conflict';
      /**
       * Returned ONLY for a missing/wrong-scope parent or null-on-existing-
       * scope (frozen semantics — stale parents WRITE branches instead), and
       * (H3, v3 reconcile) for a head-set or pointer CAS mismatch.
       * Lists all live heads (>= 1) so the caller can pick a real parent.
       */
      heads: Array<{ stateId: string; revision: number; author: string; recordedAt: string }>;
      /** Present ONLY on resultVersion 3: the pointer's stateId now (null = none). */
      pointer?: string | null;
    }
  | {
      /**
       * Same idempotencyKey, DIFFERENT REQUEST FINGERPRINT — i.e. different
       * semantic intent: canonical author, CAS position, or content
       * (reviews b2e6fc7c #4 + 5868b61b #3 + r3 5957b1b2 #1). Content hashes
       * can be IDENTICAL in an author/CAS-only mismatch, so the fields name
       * what is actually compared. Fail closed — nothing written, nothing
       * replayed.
       */
      outcome: 'idempotency-mismatch';
      stateId: string;
      expectedRequestFingerprint: string;
      receivedRequestFingerprint: string;
    };

// ---------------------------------------------------------------------------
// History v1 — typed RESOURCE, not a tool (review #5)
// ---------------------------------------------------------------------------

/**
 * Selector for a snapshot resource fetch — EXACTLY ONE of stateId | revision,
 * scoped. Materializes as a ContentHandle uri (eng4://snapshot/...); the
 * changes-since view is a cursor over the same resource space. There is no
 * get_checkpoint tool; folding history into resume cursors is the only other
 * sanctioned access path.
 */
export type SnapshotSelector =
  | { scope: ScopeRef; stateId: string; revision?: never }
  | { scope: ScopeRef; revision: number; stateId?: never };

export interface ChangesSinceQuery {
  scope: ScopeRef;
  sinceRevision: number;
  cursor?: string;
}
