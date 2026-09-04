/**
 * RFC 8785 (JSON Canonicalization Scheme) implementation for ENG-4
 * idempotency content verification (review 07b3906e #4).
 *
 * Exact algorithm, per the RFC:
 * - Object properties sorted by UTF-16 code units of their names.
 * - No insignificant whitespace.
 * - Strings serialized with JSON escaping (two-character escapes where
 *   defined, lowercase \u00xx otherwise) — matches ECMAScript
 *   JSON.stringify, which is what this implementation delegates to for
 *   primitive serialization.
 * - Numbers serialized in ECMAScript shortest-round-trip format (again,
 *   JSON.stringify semantics). NaN/Infinity are invalid JSON and rejected.
 * - undefined values, functions, and symbols are REJECTED (fail closed)
 *   rather than silently dropped — silent dropping would let two different
 *   inputs canonicalize identically.
 *
 * THE HASHED CHECKPOINT ENVELOPE (defined here, once): the idempotency
 * content hash is sha256 over the UTF-8 bytes of
 * canonicalize({ scopeKey, state, events, factChanges, loopChanges,
 * evidenceRefs }). The asserted agentId and expectedRevision are EXCLUDED —
 * identity and CAS position are not content. Resource contentHash and
 * byteLength bind to these exact canonical bytes.
 */
import { createHash } from 'crypto';

/**
 * RFC 8785 §3.2.2.2: lone surrogates MUST terminate with an error — a
 * malformed string must never canonicalize. Applied recursively to string
 * VALUES and object KEYS alike.
 */
function assertWellFormed(str: string): void {
  for (let i = 0; i < str.length; i++) {
    const cu = str.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`canonicalize: lone high surrogate at index ${i}`);
      }
      i++; // valid pair — skip the low half
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      throw new TypeError(`canonicalize: lone low surrogate at index ${i}`);
    }
  }
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new TypeError('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (t === 'string') {
    assertWellFormed(value as string);
    return JSON.stringify(value);
  }
  if (t === 'boolean') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalize: unsupported type ${t}`);
  }
  if (Array.isArray(value)) {
    // Accepts only I-JSON-compatible plain data: sparse arrays are
    // JSON-inexpressible and would collapse ([,] -> "[]", colliding with a
    // real empty array) — fail closed (r3 verdict 5957b1b2 #3).
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      // OWN property required — `i in value` would accept INHERITED numeric
      // properties (Array.prototype[0] = 'x' un-hides a hole; sol repro,
      // supplement 6dcf226d).
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new TypeError(`canonicalize: sparse array (missing index ${i})`);
      }
      const v = value[i];
      if (v === undefined) throw new TypeError('canonicalize: undefined array element');
      parts.push(canonicalize(v));
    }
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code units
    const parts: string[] = [];
    for (const k of keys) {
      assertWellFormed(k);
      const v = obj[k];
      if (v === undefined) throw new TypeError(`canonicalize: undefined property ${k}`);
      parts.push(`${JSON.stringify(k)}:${canonicalize(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError('canonicalize: unsupported value');
}

/** The exact checkpoint-content envelope that gets hashed (see header). */
export interface CheckpointContentEnvelope {
  scopeKey: string;
  state: unknown;
  events: unknown[];
  factChanges: unknown[];
  loopChanges: unknown[];
  evidenceRefs: string[];
  /**
   * ENG-4 H3 (design §4.2 step 4): a RECONCILE snapshot's envelope carries
   * the normalized reconciliation record so contentHash binds it and the
   * snapshot resource is self-contained. Present ONLY on reconcile
   * snapshots — a `write` envelope is byte-identical to before.
   */
  reconciliation?: unknown;
}

/** Canonical UTF-8 bytes of the envelope — the ONLY hashable representation. */
export function canonicalEnvelopeBytes(envelope: CheckpointContentEnvelope): Buffer {
  return Buffer.from(
    canonicalize({
      scopeKey: envelope.scopeKey,
      state: envelope.state,
      events: envelope.events ?? [],
      factChanges: envelope.factChanges ?? [],
      loopChanges: envelope.loopChanges ?? [],
      evidenceRefs: envelope.evidenceRefs ?? [],
      ...(envelope.reconciliation !== undefined ? { reconciliation: envelope.reconciliation } : {}),
    }),
    'utf8'
  );
}

/** sha256 hex of the canonical envelope bytes — the idempotency content hash. */
export function envelopeContentHash(envelope: CheckpointContentEnvelope): string {
  return createHash('sha256').update(canonicalEnvelopeBytes(envelope)).digest('hex');
}

/**
 * OPERATION idempotency fingerprint (review 5868b61b #3, option a) — kept
 * DISTINCT from the resource content hash. The fingerprint binds the full
 * semantic intent of the write: WHO (the exact opaque agent principal),
 * WHERE in history (expectedRevision +
 * resolved parent identity), and WHAT (the canonical content envelope).
 * Same (tenant, scope, idempotencyKey) with a differing fingerprint =>
 * outcome 'idempotency-mismatch'. Resource contentHash stays bound to the
 * content envelope bytes alone (envelopeContentHash) — no conflation.
 */
export function requestFingerprint(input: {
  canonicalAgentId: string;
  scopeKey: string;
  expectedRevision: number | null;
  resolvedParentStateId: string | null;
  envelope: CheckpointContentEnvelope;
  /**
   * Result-shape discriminant (PR A, 2026-09-03). Bound into the fingerprint
   * ONLY when it is 2: a legacy request (absent or 1) produces the exact v1
   * fingerprint, byte-for-byte, so retries that began before an upgrade
   * still replay after it. It is NOT part of the content envelope/contentHash.
   */
  resultVersion?: 1 | 2 | 3;
  /**
   * ENG-4 H3 (design §5.1 rule, applied to reconcile now): the operation
   * discriminant is bound ONLY when present and ≠ 'write' — legacy bytes
   * unchanged.
   */
  operation?: 'write' | 'reconcile' | 'record' | 'patch';
  /**
   * ENG-4 H5 (§5.4): the RAW RFC 7396 merge patch of a `patch` request,
   * bound as sent (canonicalized) — the materialized state is derived inside
   * the transaction and bound by contentHash, not by the fingerprint. For
   * record/patch the fingerprint's content carries `state: null` (the request
   * has no state); the resolved parent binds what the state is derived from.
   */
  patch?: unknown;
  /**
   * ENG-4 H3 (§4.1, §6.3 Q4): the NORMALIZED reconcile request — sorted
   * expectedHeads, expectedPointer, survivor, reason, strict, explicit
   * resolutions sorted, and the RAW sorted rejectLineages shorthand (never
   * its expansion, which depends on database state) — so a retry can locate
   * the prior snapshot before any recomputation. Present only for reconcile.
   */
  reconcile?: unknown;
}): string {
  const canonical = canonicalize({
    canonicalAgentId: input.canonicalAgentId,
    scopeKey: input.scopeKey,
    expectedRevision: input.expectedRevision,
    resolvedParentStateId: input.resolvedParentStateId,
    ...(input.resultVersion === 2 ? { resultVersion: 2 } : {}),
    ...(input.resultVersion === 3 ? { resultVersion: 3 } : {}),
    ...(input.operation !== undefined && input.operation !== 'write' ? { operation: input.operation } : {}),
    ...(input.reconcile !== undefined ? { reconcile: input.reconcile } : {}),
    ...(input.patch !== undefined ? { patch: input.patch } : {}),
    // Content is the BASE envelope — the reconciliation record is derived
    // inside the transaction and bound by contentHash, not by the fingerprint.
    content: canonicalize({
      scopeKey: input.envelope.scopeKey,
      state: input.envelope.state,
      events: input.envelope.events ?? [],
      factChanges: input.envelope.factChanges ?? [],
      loopChanges: input.envelope.loopChanges ?? [],
      evidenceRefs: input.envelope.evidenceRefs ?? [],
    }),
  });
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}
