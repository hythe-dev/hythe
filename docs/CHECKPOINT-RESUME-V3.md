# Checkpoint / resume v3 — heads, the pointer, reconciliation, record and patch

`resultVersion: 3` is the opt-in that turns `checkpoint` / `resume` from
"branch-preserving CAS with conflicts as heads" into a full head-selection and
reconciliation model. It is on `main` and deployed to the reference
production host; it is not yet in a published `@hythe/mcp` release. Every v1
and v2 request and result shape is frozen and unchanged — a client that never
sends `resultVersion: 3` sees nothing new except that `working` now follows the
scope's current-head pointer (below).

Design note: [`design/ENG4-HEAD-RECONCILIATION.md`](design/ENG4-HEAD-RECONCILIATION.md).
Contract tests: `tests/contract-eng4-h1-head-pointer.test.ts` … `contract-eng4-h5-record-patch.test.ts`.

## 1. The problem v3 solves

Under v1/v2 a scope could accumulate live heads forever (`asOf.conflicts`
listed all of them on every call, and the highest revision silently became
"current"), any writer extending an older parent could displace the working
lane's state by producing a higher revision, and facts/loops were scope-global
rows updated in place — a write from an abandoned branch destroyed the
accepted value immediately. v3 adds:

| Piece | What it gives you |
|---|---|
| **Current-head pointer** | An explicit, per-scope pointer to the current head. Only a write whose parent *is* the pointed head advances it. Any other parent still branches (frozen CAS) but never becomes current by accident. |
| **Reconcile** | One operation that names the exact live-head set and pointer (both compare-and-set), keeps one survivor, retires every other head, and resolves divergent fact/loop values causally. Snapshots are never deleted. |
| **Versioned facts and loops** | Every fact/loop change is materialized as an append-only version bound to the snapshot and change ordinal that wrote it, hash-verified against the snapshot payload. |
| **v3 read model** | `resume` selects `currentFacts` / `openLoops` only from verified versions on the accepted lineage, carries provenance on every item, and surfaces everything else as `divergentValues` / `legacyValues` instead of hiding it. |
| **record / patch** | Log fact/loop changes without resending state, or apply an RFC 7396 merge patch to the state — both only on the pointed head, conflict otherwise. |

## 2. Reading: `resume` with `resultVersion: 3`

```
resume({agentId: "agent-a", scope: {project: "hello-fleet"}, budget: 6000,
        sections: ["working", "heads", "currentFacts", "openLoops", "divergentValues", "legacyValues"],
        resultVersion: 3})
```

`heads`, `divergentValues` and `legacyValues` are sections like any other:
they are returned only when requested (their coverage says `not-requested`
otherwise), and `legacyValues` is always budgeted last. The bundle is the v2
bundle plus:

- `asOf.selection` — how "current" was chosen:
  `pointer` (normal), `max-revision` (a scope written before v3, no pointer yet:
  current = highest-revision live head, explicitly flagged), `empty-scope`, or
  `invalid-designation` (the pointer names a snapshot that is no longer live —
  `working` is `null`, nothing is guessed).
- `asOf.pointer` — `{stateId, revision, advancedAt, advancedBy, reason}` with
  `reason` ∈ `first-write` | `advance` | `reconcile`, or `null`.
- `asOf.liveHeadCount`, `asOf.divergentHeadCount`, `asOf.retiredHeadCount`,
  `asOf.opaqueDivergentCount` — fixed-size counters.
- `heads` — a budgeted section listing every live head:
  `{stateId, revision, author, recordedAt, isCurrent, parentRetired}`.
- `currentFacts` / `openLoops` — only values with a proven version on the
  **accepted lineage**; each item carries
  `provenance: {stateId, revision, ordinal, outsideAcceptedLineage}`.
- `divergentValues` — materialized fact/loop values on other lineages:
  `{kind, id, lineageHead, stateId, revision, ordinal, opaque, value, isV1CurrentValue, resolved}`.
  An `opaque: true` entry is an unversioned terminal (value `null`) that shares
  an id with an accepted value.
- `legacyValues` — the in-place v1 rows for ids that have no proven accepted
  version (`accepted: false`, `provenance: null`). They are the explicit
  alternate path, never silently promoted.
- `coverage.currentFacts` / `coverage.openLoops` gain `suppressedCount` and two
  new `omittedReason` values: `unversioned` (no proven version) and
  `undesignated` (the scope has no accepted lineage yet). Closed coverage
  accounting still holds: a bundle can never pretend to be complete.

Example `asOf` from a reconciled scope:

```json
{"selection": "pointer",
 "pointer": {"stateId": "…r", "revision": 4, "advancedAt": "…", "advancedBy": "agent-a", "reason": "reconcile"},
 "liveHeadCount": 1, "divergentHeadCount": 0, "retiredHeadCount": 1, "opaqueDivergentCount": 0,
 "conflicts": []}
```

## 3. Writing: `checkpoint` with `resultVersion: 3`

### 3.1 `write` (the default operation)

Unchanged request. Semantics under the pointer:

- parent **is** the pointed head → written, pointer advances (`reason: advance`);
- parent is any other existing snapshot in the scope → written as a **branch**
  (frozen CAS), pointer unchanged — it shows up in `heads`, never as current;
- parent is a **retired** head → refused unless `acknowledgeRetired: true`; the
  write is then live but never current (`parentRetired: true`);
- first write in a scope (`expectedRevision: null`) → sets the pointer
  (`reason: first-write`).

The result is the v2 `written` shape (`changes` included).

### 3.2 `reconcile` — fold the heads back into one

```
checkpoint({agentId: "agent-a", scope: {project: "hello-fleet"},
            resultVersion: 3, operation: "reconcile",
            expectedHeads: ["…a", "…c"],      // the EXACT live-head set now
            expectedPointer: "…a",            // the pointer now, or null
            survivor: "…a",                   // becomes the parent
            expectedRevision: 3,              // the survivor's revision
            reason: "fold the audit branch",
            idempotencyKey: "reconcile-hello-1",
            state: {objective: "…", status: "green", owner: "agent-a",
                    nextActions: ["…"], blockers: [], guardrails: []}})
```

Rules:

- Both CAS values must match exactly, otherwise the result is
  `{outcome: "conflict", heads: [...], pointer: <stateId|null>}` — restate both
  from the response and retry.
- Every head except the survivor is **retired** (recorded, never deleted); the
  reconcile snapshot becomes the pointer (`reason: reconcile`).
- Divergent fact/loop values are resolved **causally**. `strict` defaults to
  `true`: any unresolved materialized divergent terminal refuses the call. To
  resolve, pass `resolutions: [{kind, id, divergentStateId, decision}]` —
  `accept` must be bound to a same-request change with an equal value
  (`acceptedOrdinal` = its index in `factChanges` / `loopChanges`), `reject`
  needs nothing else; `rejectLineages: [headId, …]` rejects every unresolved
  terminal of those heads at once. Opaque (unversioned) terminals can only be
  rejected. `strict: false` records what stayed unresolved instead of
  refusing.
- A survivor that descends from previously retired snapshots re-adopts them;
  that requires `acknowledgeRetired: true` and is recorded as `adoptedRetired`.

Result (v2 `written` plus a `reconciled` block):

```json
{"outcome": "written", "revision": 4, "stateId": "…r", "parentStateId": "…a", "changes": {"facts": [], "loops": []},
 "reconciled": {"survivor": "…a", "retired": ["…c"], "pointer": "…r",
                "resolutions": [], "adoptedRetired": [], "unresolvedDivergent": {"facts": 0, "loops": 0}}}
```

The normalized reconciliation record is bound into the snapshot payload;
replaying the same `idempotencyKey` returns the same block and the server
verifies the retirement/merge-input/resolution rows against it on every read.

### 3.3 `record` — changes without resending state

```
checkpoint({agentId: "agent-a", scope: {project: "hello-fleet"},
            resultVersion: 3, operation: "record",
            expectedRevision: 4,                  // must be the POINTER's revision
            idempotencyKey: "record-hello-1",
            factChanges: [{assertion: {subject: "build", predicate: "status", object: "green"},
                           status: "verified", evidenceRefs: ["ci:123"], sourceRefs: ["agent-a"]}],
            loopChanges: [{status: "open", nextAction: "agent-b reviews"}]})
```

`state` is forbidden; the new snapshot carries the parent's state
byte-for-byte from its hash-verified payload. The result is the v3 `written`
shape, so `changes.facts[i].factId` / `changes.loops[i].loopId` are usable
immediately — no `resume` round trip to learn a new loop id.

### 3.4 `patch` — RFC 7396 merge patch on the state

```
checkpoint({agentId: "agent-a", scope: {project: "hello-fleet"},
            resultVersion: 3, operation: "patch",
            expectedRevision: 5, idempotencyKey: "patch-hello-1",
            statePatch: {status: "blocked", blockers: ["waiting on review"]}})
```

`null` deletes a key; nested objects merge; **arrays replace wholesale** (so
`nextActions: [...]` always restates the whole list). The materialized state
must be a complete valid working state or the call fails closed — nothing is
written. An empty patch is a legal no-op snapshot. The raw patch is bound into
the idempotency fingerprint: the same patch with permuted keys replays, a
different patch under the same key is `idempotency-mismatch`.

### 3.5 Admission for `record` / `patch`

Both admit **only the pointed head** as parent. A stale parent, a live
non-pointer head, a retired head, a scope without a pointer (`max-revision`)
or an invalid designation all return
`{outcome: "conflict", heads: [...], pointer: ...}` — never a branch. A scope
with no history is a typed error (write first with `expectedRevision: null`).

## 4. Typed failures

Failures are tool errors whose text starts with `eng4:`. The ones you will meet:

| Situation | Error |
|---|---|
| v3 `write` on a retired parent without `acknowledgeRetired: true` | `… is a retired head — a resultVersion 3 write must set acknowledgeRetired: true …` |
| `reconcile` / `record` / `patch` on a scope with no history | `… on a scope with no history` |
| `reconcile` with a survivor outside `expectedHeads`, or `expectedRevision` ≠ the survivor's revision | request rejected, nothing written |
| `reconcile` (strict) with an unresolved divergent terminal | `… unresolved divergent terminal …` |
| `patch` whose result is not a complete valid working state, or carries a prototype key | `statePatch does not yield a complete valid working state` / `statePatch carries the prototype key …` |
| pointed head whose stored state no longer validates (schema drift) | `… send a full write to re-establish one` |
| persisted payload failing hash/size verification | `persisted payload failed hash/size verification …` (fail closed, nothing served) |

Input-schema violations (a v1/v2 request carrying any v3 field, `state`
together with `record`/`patch`, `patch` without `statePatch`,
`acknowledgeRetired` on `record`/`patch`) fail validation before any read.

## 5. Adopting a scope that was written before v3

A scope whose snapshots predate v3 has no pointer and no versions. Under v3 it
reports `selection: "max-revision"`, lists every live head, and suppresses
`currentFacts` / `openLoops` as `undesignated` with the v1 rows in
`legacyValues`; `record` / `patch` answer `conflict`. v1/v2 reads are
unaffected. Adopt it with **one reconcile**:

1. `resume` with `resultVersion: 3` and `sections: ["working", "heads", "legacyValues"]`
   with a budget large enough that `coverage.heads.contentComplete` is `true`
   (a v1 `resume` shows the same facts and loops in their familiar shape).
2. `checkpoint` with `operation: "reconcile"`, `expectedHeads` = every
   `heads[].stateId`, `expectedPointer: null`, `survivor` = the head you want
   (normally the one with `isCurrent: true`), `expectedRevision` = its
   revision, a `reason`, and the survivor's working state restated in full.
3. Restate the facts and loops that should be authoritative under v3 as
   `factChanges` / `loopChanges` in that same reconcile, with their existing
   `factId` / `loopId` (they come back in `changes` with `created: false`).
   Pre-v3 rows have no versions, so nothing is divergent and nothing needs
   `resolutions`; only what you restate becomes a verified version on the
   accepted lineage — the rest is accounted as `unversioned` and stays readable
   through `legacyValues` and through v1 / v2.
4. `resume` again: `selection` is `pointer` (`reason: reconcile`), every other
   head is retired, and `record` / `patch` are admitted on the new pointer.

Measured on a copy of a production scope with 26 live heads and 86 legacy
facts (2026-09-05): the reconcile retired 25 heads with zero resolutions
needed, the one restated fact became the only `currentFacts` entry with
provenance on the reconcile snapshot, `record` was admitted immediately after,
and the v1 view was unchanged. The reconcile is idempotent under its
`idempotencyKey`, so a retry after a timeout is safe.

## 6. Integrity guarantees behind all of this

- Snapshot rows are immutable by trigger; state is always materialized from the
  hash- and size-verified canonical payload, never from an unverified column.
- Within one `resume` or `checkpoint` call every payload is selected, hashed
  and parsed exactly once; nothing is cached across calls, so an out-of-band
  change is caught on the next call. `engram://snapshot/…` resources serve
  exactly the bytes that passed verification.
- Version, coverage, retirement, merge-input and resolution rows are verified
  bidirectionally against the payload-bound records before any v3 selection;
  any mismatch fails closed.
- The idempotency fingerprint binds the operation, the resolved parent, the
  normalized reconcile request or raw patch, and — for a retired-parent write —
  the acknowledgement, so a retry that changes intent is `idempotency-mismatch`,
  never a replay.
