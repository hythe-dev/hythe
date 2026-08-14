/**
 * ENG-4 MCP schema definitions — resume outputSchema (structuredContent) and
 * checkpoint input/output schemas. Amended per engram-sol Track B review
 * 4179250c (Ajv-proven gaps closed; see tests/contract-eng4-p0.test.ts for
 * the executable proofs).
 *
 * REGISTERED since Step-3 B1: eng4/register.ts serves these exact frozen
 * objects in tools/list and validates handler input against the same
 * compiled instances. EXACTLY TWO eng4 tools exist in this design: resume
 * and checkpoint (the B2 lifecycle wrappers advertise the discovery schemas
 * at the bottom of this file). Snapshot history is a typed RESOURCE
 * (SNAPSHOT_SELECTOR_SCHEMA below describes its parameters) and MUST NOT be
 * registered as a tool.
 */

/**
 * Canonical engram:// URI grammar (round-3 fix): scheme + kind + one or more
 * path segments composed ONLY of unreserved characters and percent-escapes.
 * Raw scope delimiters (':' '|') are structurally impossible in a segment —
 * a scopeKey like `p:u-1` must travel as `p%3Au-1`.
 */
export const ENGRAM_URI_PATTERN =
  '^engram://[a-z][a-z-]*(?:/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+)+$';
const AGENT_ID_PATTERN = '^[A-Za-z0-9_.:-]+$';

/** Scope: at least one of project/task is REQUIRED (both allowed). */
const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { project: { type: 'string', minLength: 1 }, task: { type: 'string', minLength: 1 } },
  anyOf: [{ required: ['project'] }, { required: ['task'] }],
} as const;

/**
 * Coverage closedness (review e0d81d4d #2). Locked relationships require an
 * Ajv instance created with { $data: true } — a runtime requirement pinned
 * in the contract tests: contentComplete=true ⇒ includedCount===totalCount
 * ∧ omittedReason='none' ∧ nextCursor=null; contentComplete=false ⇒ an
 * explicit non-'none' reason.
 */
const SECTION_COVERAGE = {
  type: 'object',
  additionalProperties: false,
  required: ['includedCount', 'totalCount', 'contentComplete', 'omittedReason', 'nextCursor', 'tokenEstimate'],
  properties: {
    // includedCount can never exceed totalCount — for complete AND
    // incomplete sections (round-3 fix: the invariant previously applied
    // only via the contentComplete=true branch).
    includedCount: { type: 'integer', minimum: 0, maximum: { $data: '1/totalCount' } },
    totalCount: { type: 'integer', minimum: 0 },
    contentComplete: { type: 'boolean' },
    omittedReason: { enum: ['budget', 'cursor', 'not-requested', 'none'] },
    nextCursor: { type: ['string', 'null'] },
    tokenEstimate: { type: 'integer', minimum: 0 },
  },
  allOf: [
    {
      if: { properties: { contentComplete: { const: true } } },
      then: {
        properties: {
          includedCount: { const: { $data: '1/totalCount' } },
          omittedReason: { const: 'none' },
          nextCursor: { type: 'null' },
        },
      },
    },
    {
      if: { properties: { contentComplete: { const: false } } },
      then: { properties: { omittedReason: { enum: ['budget', 'cursor', 'not-requested'] } } },
    },
  ],
} as const;

/**
 * Typed handle: resource-addressed (product-stable, URL-encoded engram://
 * URIs), never a tool call. Snapshot/payload handles MUST carry
 * contentHash + byteLength + mediaType so fetched bodies are verifiable
 * (review e0d81d4d #4); message/observation handles are reference-only.
 */
const CONTENT_HANDLE = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri', 'contentHash', 'byteLength', 'mediaType'],
      properties: {
        kind: { enum: ['state-snapshot', 'payload'] },
        uri: { type: 'string', pattern: ENGRAM_URI_PATTERN },
        contentHash: { type: 'string', minLength: 1 },
        byteLength: { type: 'integer', minimum: 0 },
        mediaType: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uri'],
      properties: {
        kind: { enum: ['message', 'observation'] },
        uri: { type: 'string', pattern: ENGRAM_URI_PATTERN },
        contentHash: { type: 'string' },
        byteLength: { type: 'integer', minimum: 0 },
        mediaType: { type: 'string' },
      },
    },
  ],
} as const;

const STATE_HEAD = {
  type: 'object',
  additionalProperties: false,
  required: ['stateId', 'revision', 'author', 'recordedAt'],
  properties: {
    stateId: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    author: { type: 'string' },
    recordedAt: { type: 'string' },
  },
} as const;

const WORKING_STATE = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'status', 'owner', 'nextActions', 'blockers', 'guardrails'],
  properties: {
    objective: { type: 'string' },
    status: { type: 'string' },
    owner: { type: 'string' },
    nextActions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    guardrails: { type: 'array', items: { type: 'string' } },
  },
} as const;

const FACT_ASSERTION = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'predicate', 'object'],
  properties: {
    subject: { type: 'string', minLength: 1 },
    predicate: { type: 'string', minLength: 1 },
    object: { type: 'string', minLength: 1 },
  },
} as const;

const FACT_STATUS = { enum: ['asserted', 'verified', 'disputed', 'superseded'] } as const;

/** resume() input schema — agentId is the ASSERTED caller identity (b2e6fc7c #1). */
export const RESUME_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope', 'budget'],
  properties: {
    agentId: { type: 'string', minLength: 1, maxLength: 100, pattern: AGENT_ID_PATTERN, description: 'ASSERTED exact opaque caller identity within the operator/API-key trust boundary (platform max 100). Case and transport-looking suffixes are identity-significant; this principal owns authorship, acks, and views.' },
    scope: SCOPE_SCHEMA,
    budget: { type: 'integer', minimum: 256, description: 'Hard total token budget for the bundle.' },
    sections: {
      type: 'array',
      items: { enum: ['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'] },
    },
    cursor: { type: 'string' },
  },
} as const;

/**
 * resume() outputSchema — the structuredContent bundle. Section order is
 * contractual; coverage accounting is mandatory (silent trimming = failure);
 * message items are body XOR handle so omitted bytes stay reachable.
 */
export const RESUME_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'resolvedScope', 'asOf', 'definition', 'working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers', 'coverage'],
  properties: {
    schemaVersion: { const: 1 },
    resolvedScope: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'taskId', 'scopeKey', 'aliasesMatched'],
      properties: {
        projectId: { type: ['string', 'null'], description: 'Stable entity UUID, never a name.' },
        taskId: { type: ['string', 'null'], description: 'Stable entity UUID, never a name.' },
        scopeKey: {
          type: ['string', 'null'],
          description: 'NULL for unknown/ambiguous refs — never synthesized for an unresolved scope.',
        },
        aliasesMatched: { type: 'array', items: { type: 'string' } },
        ambiguousCandidates: { type: 'array', items: { type: 'string' } },
      },
    },
    asOf: {
      type: 'object',
      additionalProperties: false,
      required: ['assembledAt', 'stateId', 'revision', 'stateAgeSec', 'stale', 'conflicts'],
      properties: {
        assembledAt: { type: 'string' },
        stateId: { type: ['string', 'null'] },
        revision: { type: ['integer', 'null'] },
        stateAgeSec: { type: ['integer', 'null'] },
        stale: { type: 'boolean' },
        conflicts: { type: 'array', items: STATE_HEAD },
      },
    },
    definition: { type: ['string', 'null'], description: 'Charter prose — never current state.' },
    working: { anyOf: [WORKING_STATE, { type: 'null' }] },
    openLoops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['loopId', 'scopeKey', 'projectId', 'taskId', 'owner', 'status', 'openedAt', 'updatedAt', 'nextAction', 'revision'],
        properties: {
          loopId: { type: 'string' },
          scopeKey: { type: 'string', minLength: 1 },
          projectId: { type: ['string', 'null'] },
          taskId: { type: ['string', 'null'] },
          owner: { type: 'string' },
          status: { enum: ['open', 'blocked', 'closed'] },
          openedAt: { type: 'string' },
          updatedAt: { type: 'string' },
          dueAt: { type: 'string' },
          blockedOn: { type: 'string' },
          nextAction: { type: 'string' },
          closeEvent: {
            type: 'object',
            additionalProperties: false,
            required: ['closedAt', 'closedBy', 'outcome'],
            properties: { closedAt: { type: 'string' }, closedBy: { type: 'string' }, outcome: { type: 'string' } },
          },
          revision: { type: 'integer', minimum: 0 },
        },
      },
    },
    // Typed inbox items (b2e6fc7c #2): messages AND handoffs, one section,
    // one coverage. Handoff items carry handoffId + caller-specific
    // ackedByMe; resume never consumes — acking is explicit via the
    // begin_session wrapper's ackHandoffIds. body XOR handle on every item.
    messages: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['itemType', 'messageId', 'from', 'priority', 'recordedAt', 'body', 'handle'],
            properties: {
              itemType: { const: 'message' },
              messageId: { type: 'string' },
              from: { type: 'string' },
              priority: { enum: ['low', 'normal', 'high', 'urgent'] },
              recordedAt: { type: 'string' },
              body: { type: 'string' },
              handle: { type: 'null' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['itemType', 'messageId', 'from', 'priority', 'recordedAt', 'body', 'handle'],
            properties: {
              itemType: { const: 'message' },
              messageId: { type: 'string' },
              from: { type: 'string' },
              priority: { enum: ['low', 'normal', 'high', 'urgent'] },
              recordedAt: { type: 'string' },
              body: { type: 'null' },
              handle: CONTENT_HANDLE,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['itemType', 'handoffId', 'from', 'recordedAt', 'ackedByMe', 'body', 'handle'],
            properties: {
              itemType: { const: 'handoff' },
              handoffId: { type: 'string', minLength: 1 },
              from: { type: 'string' },
              recordedAt: { type: 'string' },
              ackedByMe: { type: 'boolean', description: "THIS caller's ack state only." },
              body: { type: 'string' },
              handle: { type: 'null' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['itemType', 'handoffId', 'from', 'recordedAt', 'ackedByMe', 'body', 'handle'],
            properties: {
              itemType: { const: 'handoff' },
              handoffId: { type: 'string', minLength: 1 },
              from: { type: 'string' },
              recordedAt: { type: 'string' },
              ackedByMe: { type: 'boolean' },
              body: { type: 'null' },
              handle: CONTENT_HANDLE,
            },
          },
        ],
      },
    },
    currentFacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['factId', 'assertion', 'status', 'evidenceRefs', 'sourceRefs', 'author', 'recordedAt', 'contradicts'],
        properties: {
          factId: { type: 'string' },
          assertion: FACT_ASSERTION,
          status: FACT_STATUS,
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          sourceRefs: { type: 'array', items: { type: 'string' } },
          author: { type: 'string' },
          recordedAt: { type: 'string' },
          effectiveAt: { type: 'string', description: 'Optional, when-true-in-world; absent = unknown; never server-invented.' },
          contradicts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'summary', 'recordedAt', 'evidenceRefs'],
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
          recordedAt: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    evidence: { type: 'array', items: CONTENT_HANDLE },
    pointers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'entity', 'relation'],
        properties: { label: { type: 'string' }, entity: { type: 'string' }, relation: { type: 'string' } },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['totalTokenEstimate', 'budget', 'working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers'],
      properties: {
        totalTokenEstimate: { type: 'integer', minimum: 0 },
        budget: { type: 'integer', minimum: 0 },
        working: SECTION_COVERAGE,
        openLoops: SECTION_COVERAGE,
        messages: SECTION_COVERAGE,
        currentFacts: SECTION_COVERAGE,
        decisions: SECTION_COVERAGE,
        evidence: SECTION_COVERAGE,
        pointers: SECTION_COVERAGE,
      },
    },
  },
} as const;

/** checkpoint() input schema — CAS + idempotency required; changes fully typed; agentId = author. */
export const CHECKPOINT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope', 'expectedRevision', 'idempotencyKey', 'state'],
  properties: {
    agentId: { type: 'string', minLength: 1, maxLength: 100, pattern: AGENT_ID_PATTERN, description: 'ASSERTED exact opaque caller identity (platform max 100); case and transport-looking suffixes are identity-significant, and the raw asserted id is preserved in audit metadata.' },
    scope: SCOPE_SCHEMA,
    expectedRevision: { type: ['integer', 'null'], description: 'CAS guard; null asserts first write in scope.' },
    idempotencyKey: { type: 'string', minLength: 8 },
    state: WORKING_STATE,
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'summary'],
        properties: { kind: { type: 'string' }, summary: { type: 'string' }, at: { type: 'string' } },
      },
    },
    factChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assertion', 'status', 'evidenceRefs', 'sourceRefs'],
        properties: {
          factId: { type: 'string' },
          assertion: FACT_ASSERTION,
          status: FACT_STATUS,
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          sourceRefs: { type: 'array', items: { type: 'string' } },
          effectiveAt: { type: 'string' },
          contradicts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    loopChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'nextAction'],
        properties: {
          loopId: { type: 'string' },
          status: { enum: ['open', 'blocked', 'closed'] },
          nextAction: { type: 'string' },
          owner: { type: 'string' },
          dueAt: { type: 'string' },
          blockedOn: { type: 'string' },
          closeOutcome: { type: 'string' },
        },
      },
    },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** checkpoint() outputSchema — written | idempotent-replay | conflict (>=1 head). */
export const CHECKPOINT_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'stateId', 'scopeKey', 'revision', 'parentStateId', 'contentHash'],
      properties: {
        outcome: { const: 'written' },
        stateId: { type: 'string' },
        scopeKey: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        parentStateId: { type: ['string', 'null'] },
        contentHash: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'stateId', 'scopeKey', 'revision', 'contentHash'],
      properties: {
        outcome: { const: 'idempotent-replay' },
        stateId: { type: 'string' },
        scopeKey: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 0 },
        contentHash: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'heads'],
      properties: {
        outcome: { const: 'conflict' },
        heads: { type: 'array', minItems: 1, items: STATE_HEAD },
      },
    },
    {
      // Same idempotencyKey, DIFFERENT REQUEST FINGERPRINT (different
      // semantic intent — author, CAS position, or content; content hashes
      // may be identical). Comparison IS the RFC 8785 requestFingerprint
      // from canonical.ts; the field names say exactly that.
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'stateId', 'expectedRequestFingerprint', 'receivedRequestFingerprint'],
      properties: {
        outcome: { const: 'idempotency-mismatch' },
        stateId: { type: 'string' },
        expectedRequestFingerprint: { type: 'string', minLength: 1 },
        receivedRequestFingerprint: { type: 'string', minLength: 1 },
      },
    },
  ],
} as const;

/**
 * Snapshot RESOURCE selector — parameters of the eng4://snapshot/... resource
 * template. EXACTLY ONE of stateId | revision. THIS IS NOT A TOOL SCHEMA and
 * must never be registered in tools/list (exactly-two-primitives rule);
 * history access is via ContentHandle uris or resume cursors only.
 */
export const SNAPSHOT_SELECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: SCOPE_SCHEMA,
    stateId: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 0 },
  },
  oneOf: [
    { required: ['stateId'], not: { required: ['revision'] } },
    { required: ['revision'], not: { required: ['stateId'] } },
  ],
} as const;

/**
 * begin_session wrapper schema (reviews 07b3906e #2 + 5868b61b #4). MCP-
 * visible since the B2 handler landed: UnifiedToolSchemas.begin_session
 * advertises BEGIN_SESSION_DISCOVERY_INPUT_SCHEMA below (wrapper shape OR
 * pinned legacy shape) — schema and behavior stay atomic (sol Step-3
 * verdict a6c75553). Backward-compatible
 * additive mapping (pinned + tested): projectId → scope.project,
 * maxTokens → budget (omitted = legacy default 4000), userId →
 * deprecatedUserId (version-gated; see adaptLegacyBeginSessionArgs).
 * Handoff acknowledgement is EXPLICIT via ackHandoffIds — the wrapper never
 * auto-consumes, resume stays read-only, and the ack write requires an
 * atomic same-tenant existence check (migration 005). Not a bootstrap
 * primitive: tools/list keeps exactly resume + checkpoint on the eng4
 * surface.
 */
/**
 * Legacy begin_session adapter (r3 verdict 5957b1b2 #2) — the pinned,
 * TESTED transition contract; schema + handler land atomically in 2(a):
 * - projectId → scope.project.
 * - maxTokens → budget: OMITTED keeps the legacy default 4000 (the live
 *   getAgentContext default — r4 finding 68ea4b77: '?? 256' would have
 *   silently shrunk omitted-caller budgets ~16x); EXPLICIT values below the
 *   wrapper floor are clamped to 256 (preserving intent, not rejecting).
 * - userId → DEPRECATED, version-gated: the adapter surfaces it as
 *   deprecatedUserId so the legacy user-scoped-context path can keep
 *   honoring it OUTSIDE resume until the v1 cut removes it; it is never
 *   silently erased and never becomes a resume/tenant input (tenant comes
 *   from RequestContext).
 */
export function adaptLegacyBeginSessionArgs(legacy: {
  agentId: string;
  projectId: string;
  maxTokens?: number;
  userId?: string;
}): { agentId: string; scope: { project: string }; budget: number; deprecatedUserId?: string } {
  const out: { agentId: string; scope: { project: string }; budget: number; deprecatedUserId?: string } = {
    agentId: legacy.agentId,
    scope: { project: legacy.projectId },
    budget: legacy.maxTokens === undefined ? 4000 : Math.max(legacy.maxTokens, 256),
  };
  if (legacy.userId !== undefined) out.deprecatedUserId = legacy.userId;
  return out;
}

export const BEGIN_SESSION_WRAPPER_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'scope', 'budget'],
  properties: {
    agentId: { type: 'string', minLength: 1, maxLength: 100, pattern: AGENT_ID_PATTERN },
    scope: RESUME_INPUT_SCHEMA.properties.scope,
    budget: { type: 'integer', minimum: 256 },
    ackHandoffIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Handoffs this agent explicitly acknowledges (per-agent, per-tenant; each must exist in the same tenant or the whole call fails closed).',
    },
  },
} as const;

/**
 * Pinned legacy begin_session call shape — still ACCEPTED by the B2 wrapper
 * via adaptLegacyBeginSessionArgs until the owner-gated cutover. Permissive
 * on unknown extras (matching the pre-diet advertised contract) EXCEPT the
 * wrapper keys (scope/budget/ackHandoffIds), which are excluded so a mixed
 * legacy+wrapper call can never schema-validate as legacy while the handler
 * takes the wrapper path (sol Step-3 check verdict 4c587d4f) — mixed shapes
 * are OUTSIDE the advertised contract entirely.
 */
export const BEGIN_SESSION_LEGACY_INPUT_SCHEMA = {
  type: 'object',
  required: ['agentId', 'projectId'],
  not: { anyOf: [{ required: ['scope'] }, { required: ['budget'] }, { required: ['ackHandoffIds'] }] },
  properties: {
    agentId: { type: 'string', minLength: 1, maxLength: 100, pattern: AGENT_ID_PATTERN, description: 'Agent opening the session' },
    projectId: { type: 'string', minLength: 1, description: 'Adapted to scope.project by the wrapper' },
    maxTokens: { type: 'integer', minimum: 1, description: 'Adapted to budget (omitted = 4000; explicit values below 256 are clamped to 256)' },
    userId: { type: 'string', description: 'DEPRECATED; honored outside resume until the v1 cut' },
  },
} as const;

/**
 * DISCOVERY schema for the begin_session compatibility wrapper (B2): the
 * tools/list contract must advertise exactly what the committed handler
 * accepts (sol Step-3 verdict a6c75553) — either the wrapper shape
 * (scope/budget/ackHandoffIds) or the pinned legacy shape, which the
 * handler adapts via adaptLegacyBeginSessionArgs. Mixed shapes are
 * schema-REJECTED (sol 4c587d4f): the branches are mutually exclusive, so
 * a schema-valid call always has exactly one, unambiguous semantics.
 */
export const BEGIN_SESSION_DISCOVERY_INPUT_SCHEMA = {
  type: 'object',
  oneOf: [BEGIN_SESSION_WRAPPER_INPUT_SCHEMA, BEGIN_SESSION_LEGACY_INPUT_SCHEMA],
} as const;
