# ENG-4 design note: current-head selection, fork reconciliation, and versioned checkpoint operations

| | |
|---|---|
| Status | **ACCEPTED v5.1** — reviewed by Tomas and merged to main as 3429000 (PR #10, 2026-09-03). Implementation proceeds per §7, one gated PR per step: **H1 in progress** (branch `feat/eng4-h1-head-pointer`; `src/unified-server/eng4/heads.ts`, `tests/contract-eng4-h1-head-pointer.test.ts`). Prior draft history: v5.1 was codex-hythe's takeover revision incorporating review 12281537 while claude-hythe was temporarily disabled. §2.10 is **RULED**: the H-series is `resultVersion: 3` (Tomas, 2026-09-03). |
| Author | claude-hythe through v5; codex-hythe takeover revision v5.1, 2026-09-03 |
| Provenance | Field report cc554c26 (claude-desktop-ws01) items 1–3 and 6; codex-hythe adversarial review b8456917 findings 1–3 and Q1–Q3; data audit 1e5d0dc6 HIGH 1; PR #8 reviews 5e486718 / 882d39c7; PR #9 reviews b2641137 / 99735a88 Q4; design review aad3973c findings 1–8 and Q1–Q9; design re-review 19826044 findings 1–4, precision items, and Q1–Q4; design re-review 89c01374 blockers 1–4 and open-question rulings; design re-review 12281537 issues 1–4 and §9 answers |
| Gates | Nothing in this note is authorized to ship. Each section ends with the PR it would become; every PR needs its own review. No Pavilion action is implied. |

## 0. Summary

Today the checkpoint/resume pair is branch-preserving on write but has no notion of *which* branch is current, no way to retire a branch, and no branch awareness for facts and loops. Three consequences were observed on one scope in one day:

1. `resume` selects the **max-revision live head** as current. Any writer extending an older parent produces a higher revision and silently becomes "current". The audit lane's review-progress snapshots displaced the working lane's state four times on 2026-09-03 (revisions 47/48, 54/55, 60, 65 over lane revisions 46, 53, 59, 63).
2. Live heads **only accumulate**. The scope `hythe-rehydration-loop` has 13 live heads; `resume.asOf.conflicts` lists all of them on every call and the list can never shrink.
3. **Facts and loops are scope-global rows** updated in place, last-writer-wins. A write from an abandoned branch destroys the accepted value immediately; nothing records which branch wrote what.

These gaps are why the field report's two most-requested features — `record` (fact/loop changes without resending state) and `statePatch` (merge-patch on state) — were ruled **not shippable yet** in b8456917 finding 1: under max-revision selection either op, run against a stale-but-valid parent, would *promote stale working state to current* as a side effect of logging one fact.

This note proposes, in dependency order:

- **A. An advancing current-head pointer** — an explicit, scope-level, same-scope-constrained pointer to the current head itself. A write whose parent *is* the pointed head advances the pointer atomically; a write from any other parent keeps its branch but never advances it. There is no anchor and no "max revision among descendants"; a broken pointer is reported as invalid, never guessed around.
- **B. Version foundation plus atomic, integrity-bound reconciliation** — H2 first installs append-only fact/loop versions, an exact per-ledger-tuple coverage manifest, dual writes, and a verified backfill for every ledger-bound snapshot. H3 reconciliation then names the exact expected live-head set and pointer (both CAS), chooses one survivor, retires the rest, resolves divergent values **causally** (strict by default), and binds the normalized reconciliation record into the verified snapshot payload. Snapshots are never deleted.
- **C. Versioned checkpoint operations** — an explicit `operation` discriminant (`write` | `record` | `patch` | `reconcile`) on `resultVersion: 3`. `record` and `patch` require the pointed head as parent and **conflict** instead of branching; they materialize the parent's state from its hash-verified payload. Legacy `write`, its v1 fingerprint, and the frozen v2 shapes stay byte-identical.
- **D. Versioned fact/loop materialization and selection** — append-only, integrity-bound coverage and version rows keyed by snapshot and change ordinal are verified as exact bidirectional sets against hash-verified payloads and the digest-verified ledger *before* selection. The v3 view selects the newest proven version on the **accepted-value lineage** and surfaces everything else as divergent until a reconcile resolves it causally. Rows without proven versions are never promoted into authoritative sections; the in-place tables remain the frozen v1/v2 view only.

Implementation order: H1 pointer → H2 version foundation → H3 reconciliation → H4 v3 read surfaces → H5 record/patch. Everything new that `resume` returns is a budgeted section; `asOf` gains only fixed-size fields. **Release rule (§2.10):** H1–H4 are internal-only increments of the v3 schema; v3 is published and Pavilion-deployed as a public schema only once H5 finalizes it.

## 1. Facts on the ground (verified 2026-09-03)

**Code** (`src/unified-server/eng4/`, main at 1021928):

- `checkpoint.ts` `liveHeads()`: heads are snapshots that no other snapshot in the scope names as `parent_state_id`. There is no retirement, tombstone, or designation anywhere.
- `resume.ts`: `current = heads[heads.length - 1]` — max-revision. `asOf.conflicts = heads.length > 1 ? heads : []` includes the current head itself.
- CAS (frozen, review e0d81d4d #1): `expectedRevision` names any *existing* same-scope parent, live or not. Extending a stale parent **writes a branch child**; `conflict` is reserved for a missing parent or `null` on a non-empty scope. Unchanged for `operation: write`.
- Idempotency precedes CAS (`performCheckpoint`: replay lookup by `(tenant, scope, idempotencyKey)` happens before parent validation). Reconcile relies on this (§4.6).
- `trg_eng4_snapshots_parent_scope` enforces that a parent is in the same scope. `eng4_state_snapshots` has no UPDATE-immutability trigger, and `state_json` is not hash-verified; only `eng4_payloads.body` is (`verifyPayloadIntegrity`).
- `applyFactChanges`: an existing `factId` is `UPDATE`d in place; refs deleted and re-inserted. `applyLoopChanges`: `UPDATE ... revision = revision + 1`. Neither row records the writing snapshot. PR #8's ledger (`eng4_snapshot_changes`, digest-bound by `changes_hash`) records snapshot → change ids for every write since #8.
- PR #8 established the extension pattern: `resultVersion: 2` bound into `requestFingerprint` only when 2; exact-object result branches. PR #9 established that every v2 payload lives inside the closed budget/coverage model.

**Store** (`hythe-rehydration-loop`, revision 70): 13 live heads. None can be retired. `resume` returns all 13 in `conflicts` on every call.

## 2. Constraints

1. **Exactly two primitives.** Everything below extends `checkpoint` and `resume`.
2. **Frozen v1 and frozen v2.** v1 request/result/bundle shapes and v1 `requestFingerprint` bytes unchanged. The `resultVersion: 2` shapes shipped in #8/#9 are frozen as shipped: a v2 request carrying any H-series field (`operation`, `expectedHeads`, `acknowledgeRetired`, …) **fails input validation**; a v2 result/bundle never carries H-series fields. New semantics ride on `resultVersion: 3` and an explicit `operation`; omission of `operation` means legacy `write`.
3. **Branch-preserving CAS stays for `write`.** Only new operations get stricter parent rules.
4. **Never delete snapshots.** Retirement is a recorded act.
5. **Tenant identity from request context only**; every new table composite-keyed on `tenant_id`.
6. **One transaction per checkpoint.** Idempotency check, CAS, snapshot, designation, retirements, merge inputs, materialization, ledger, digests — all inside the existing transaction or nothing.
7. **Closed accounting.** Anything new that `resume` returns beyond fixed-size scalars is a budgeted section with coverage, cursor, and explicit completeness.
8. **Same-scope by structure** (aad3973c finding 1). Every new cross-reference between snapshots, and between a scope and a snapshot, is enforced structurally — composite keys on `(tenant_id, scope_key, state_id)` — not by convention.
9. **Fail closed, never fail open** (aad3973c finding 2). An invariant violation is reported as invalid; it never degrades to a guess.
10. **Result-version gate** (19826044 finding 4 — **RULED by Tomas, 2026-09-03: `resultVersion: 3`**; 89c01374 blocker 3). PRs #8/#9 define exact `resultVersion: 2` shapes, and the queue independently permits a #7+#8+#9 Pavilion deploy. H1 adds required `asOf` fields and `heads`; H4 changes `currentFacts`/`openLoops` and adds `divergentValues`/`legacyValues`; H5 adds the final operation variants. Therefore: **v2 stays exactly as #8/#9 shipped it** (frozen, deployable independently of this note); the **H-series is `resultVersion: 3`** = v2 + H-series fields, exact objects, same conditional-spread fingerprint rule (`resultVersion` bound into the checkpoint fingerprint only when ≠ 1). A v3 request on a server that only knows v2 fails input validation, never degrades. **Partial-release rule:** the exact v3 schema is not final until H5. H1–H4 therefore merge to main as *internal* increments — contract-tested, not published to npm and not deployed to Pavilion as a public v3 schema. v3 is published/deployed once, after H5. Allocating a result version per increment was considered and rejected (five public versions for one feature). Everywhere below, "v3" means this single final version and "v2+" no longer appears.

## 3. A — The advancing current-head pointer

### 3.1 Structural prerequisite (H1)

```sql
-- Referenced target for every same-scope composite FK below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_snapshots_scope_state
  ON eng4_state_snapshots (tenant_id, scope_key, state_id);

-- Snapshots are immutable. Exactly ONE post-insert transition is legal —
-- PR #8's in-transaction digest write (changes_hash NULL → NOT NULL) with
-- every other column byte-identical. Every other UPDATE, and every DELETE,
-- is rejected (19826044 finding 3).
CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_immutable
  BEFORE UPDATE ON eng4_state_snapshots
  WHEN NOT (
       OLD.changes_hash IS NULL AND NEW.changes_hash IS NOT NULL
   AND NEW.tenant_id = OLD.tenant_id AND NEW.state_id = OLD.state_id
   AND NEW.scope_key = OLD.scope_key AND NEW.revision = OLD.revision
   AND NEW.parent_state_id IS OLD.parent_state_id
   AND NEW.content_hash = OLD.content_hash AND NEW.request_fingerprint = OLD.request_fingerprint
   AND NEW.idempotency_key = OLD.idempotency_key AND NEW.author = OLD.author
   AND NEW.asserted_agent_id IS OLD.asserted_agent_id AND NEW.recorded_at = OLD.recorded_at
   AND NEW.state_json = OLD.state_json)
  BEGIN SELECT RAISE(ABORT, 'eng4: snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_no_delete
  BEFORE DELETE ON eng4_state_snapshots
  BEGIN SELECT RAISE(ABORT, 'eng4: snapshots are never deleted'); END;
```

Tests (direct SQL): one UPDATE per column is rejected; the single legal digest transition succeeds; a second `changes_hash` update is rejected; DELETE is rejected. If a future column is added to the table the trigger must be extended in the same PR (a contract test asserts the trigger's column list equals `PRAGMA table_info`).

### 3.2 Pointer row

```sql
CREATE TABLE IF NOT EXISTS eng4_scope_current (
  tenant_id   TEXT NOT NULL,
  scope_key   TEXT NOT NULL,
  state_id    TEXT NOT NULL,             -- THE current head itself (always a live head by construction)
  advanced_at TEXT NOT NULL,
  advanced_by TEXT NOT NULL,             -- canonical agent principal of the write that moved it
  reason      TEXT NOT NULL CHECK (reason IN ('first-write','advance','reconcile')),
  PRIMARY KEY (tenant_id, scope_key),
  FOREIGN KEY (tenant_id, scope_key)           REFERENCES eng4_scopes(tenant_id, scope_key),
  FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
```

The composite FK makes `(scope P, state from scope Q)` unrepresentable (aad3973c finding 1). The row is a **pointer to the head**, not an anchor of a lineage (89c01374 blocker 1).

### 3.2a Advance rule — the invariant that kills stale-parent promotion

Inside every checkpoint transaction, after the snapshot insert:

```
if pointer exists and new.parent_state_id == pointer.state_id:
    pointer := new (reason 'advance')          -- the chosen lineage moves forward
else:
    pointer unchanged                            -- a branch was written; it is live but NOT current
```

This is unconditional on `operation`: a legacy v1 `write` on the pointed head advances the pointer too (there is no way to extend the current head *without* becoming current, which is what "current" means), and a legacy `write` on any other parent never advances it. `reconcile` sets the pointer explicitly (§4). Nothing else can move it.

**The A→B / A→C attack** (89c01374): pointer at A; a write A→B advances the pointer to B; a stale writer later writes A→C. C's parent is A ≠ pointer (B), so the pointer stays at B; C is a live divergent head with a higher revision and it is **not** current. An earlier draft's anchor rule would have picked C by revision; in v5.1 revision never enters the decision. This is a contract test in H1.

**Concurrent children.** In the present single-process synchronous better-sqlite3 model two writers cannot interleave inside the transaction, so exactly one of two writes on the same pointed head runs first and advances the pointer; the second sees a parent that is no longer the pointer: `write` branches (frozen CAS) without advancing, `record`/`patch` conflict (§5.1). If independent writer processes are ever supported, the advance must run under an immediate write transaction with `SQLITE_BUSY` treated as retryable (19826044 Q8).

### 3.3 One resolver: `effectiveCurrentHead(scope)`

Used by `resume` (to pick `working`) and by `record`/`patch` (as the only admissible parent). It is the single definition of "current" (aad3973c finding 5) and it never consults revision numbers once a pointer exists.

```
pointer := eng4_scope_current[scope] or null
live    := liveHeads(scope)                      -- §4.4 definition (no child AND not retired)
if pointer is null:
    if live is empty: return { head: null, selection: 'empty-scope' }
    return { head: maxRevision(live), selection: 'max-revision' }   -- legacy scopes only, explicitly flagged
if pointer.state_id ∈ live:
    return { head: pointer.state_id, selection: 'pointer' }
return { head: null, selection: 'invalid-designation' }             -- fail closed
```

- **`pointer`** is the only non-legacy success mode. There is no "forked lineage" mode any more: a fork is simply one or more live heads that are not the pointer, listed in the `heads` section (§3.5) until reconciled.
- **`invalid-designation`** is an invariant failure: the pointer only ever moves to a child of itself (§3.2a) or to a reconcile snapshot (§4), and a reconcile retires other heads in the same transaction, so a pointed head that is not live cannot arise from correct operation. `resume` then returns `working: null`, `stale: true`, and `asOf.pointer` showing the broken row; `record`/`patch` conflict. Repair is a reconcile with the CAS in §4.2 — never an automatic fallback (aad3973c finding 2).
- Legacy `max-revision` exists only for scopes that predate H1 and have never reconciled, and it governs `working` only — never accepted fact/loop values (§6.5).

### 3.4 First write

The first snapshot in a scope sets the pointer to itself (`reason: 'first-write'`) inside its own transaction, so new scopes never run in legacy mode. There is **no** standalone `designate` operation (aad3973c Q1: a no-fork repair is `reconcile` with `expectedHeads = {sole head}`; a corrupt pointer is repaired by a reconcile that names it in `expectedPointer`).

### 3.5 What `resume` v3 adds

`asOf` gains only fixed-size fields (v3):

```
asOf.selection:        'empty-scope' | 'max-revision' | 'pointer' | 'invalid-designation'
asOf.pointer:          { stateId, revision, advancedAt, advancedBy, reason } | null
asOf.liveHeadCount:    integer
asOf.divergentHeadCount: integer      -- live heads other than the effective current head
asOf.retiredHeadCount: integer
```

The head list itself becomes a **budgeted v3 section** `heads` (aad3973c finding 6), ordered right after `capsule`: items are `{ stateId, revision, author, recordedAt, isCurrent, parentRetired }` for every live head, with coverage/cursor/completeness like every other section. Under H1/H2 there are no retirements yet, so `parentRetired` is a required field that is always `false`; H3 starts setting it without changing the item shape (19826044 precision item). v1 `asOf.conflicts` and the frozen v2 bundle are unchanged.

→ **PR H1** (internal increment of v3): unique index, immutability + no-delete triggers, `eng4_scope_current` as a pointer, the advance rule in every checkpoint transaction, the resolver, first-write pointer, resume v3 `asOf` fields and `heads` section; v2 input schemas reject H-series fields. Contract tests: the A→B / A→C attack (pointer stays at B, C is divergent, `working` is B's); concurrent-children semantics; every `selection` value including `invalid-designation` (constructed by direct SQL); cross-scope pointer rejected by FK; per-column snapshot UPDATE, second digest write and DELETE rejected; v1 and v2 bundles byte-identical; `heads` budget omission with cursor.

## 4. B — Atomic, integrity-bound reconciliation

### 4.1 Request (checkpoint, `resultVersion: 3`)

```jsonc
{
  "agentId": "...", "scope": {...}, "idempotencyKey": "...", "resultVersion": 3,
  "operation": "reconcile",
  "expectedRevision": <revision of the survivor>,
  "expectedHeads": ["<stateId>", ...],     // EXACT live-head set; minItems 1, uniqueItems; normalized (sorted) before anything else
  "expectedPointer": "<stateId>" | null,     // CAS on eng4_scope_current.state_id (null = no row / legacy scope)
  "survivor": "<stateId>",                 // ∈ expectedHeads
  "reason": "required free text",
  "strict": true,                          // default true (§6.3); false is the audited escape hatch
  "resolutions": [ { "kind": "fact"|"loop", "id": "...", "divergentStateId": "...", "decision": "accept"|"reject", "acceptedOrdinal": 0 /* accept only */ } ],
  "rejectLineages": ["<divergent head stateId>", ...],   // optional shorthand: expands server-side to per-value rejects (§6.3)
  "state": {...},                          // full v1 working state — the reconciled truth
  // factChanges / loopChanges / events / evidenceRefs as in write (every accept MUST name its matching re-asserting change)
}
```

`expectedHeads` is kept as the explicit set (Q2); it is sorted before fingerprinting, persistence, comparison and replay so permutations never cause idempotency mismatches (finding 7). A digest may be added as an aid, never as a replacement.

### 4.2 Semantics (one transaction, in this order)

1. **Idempotency first** — unchanged from today and load-bearing here (finding 4): a retry of an already-successful reconcile must replay *before* the head-set CAS, because the successful reconcile changed the live set.
2. `liveHeads(scope)` as a set must equal `expectedHeads`; else `outcome: 'conflict'` with the real heads. `eng4_scope_current.state_id` (or null) must equal `expectedPointer`; else `conflict` carrying the real pointer. Both CAS in the same transaction (Q7, Q8).
3. `survivor ∈ expectedHeads`; `expectedRevision` = survivor's revision; else typed error.
4. Insert the reconcile snapshot with `parent_state_id = survivor` (single parent; frozen chain shape kept). The **envelope** carries the normalized reconciliation record so `contentHash` binds it and the snapshot resource is self-contained:

```jsonc
"reconciliation": { "expectedHeads": [sorted], "survivor": "...", "retired": [sorted], "expectedPointer": ..., "reason": "...", "strict": true, "resolutions": [sorted by (kind,id,divergentStateId)] }
```

5. Record merge inputs and retirements, both same-scope by structure (finding 1, Q9):

```sql
CREATE TABLE IF NOT EXISTS eng4_snapshot_merge_inputs (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, state_id TEXT NOT NULL, input_state_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, state_id, input_state_id),
  FOREIGN KEY (tenant_id, scope_key, state_id)       REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
  FOREIGN KEY (tenant_id, scope_key, input_state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
CREATE TABLE IF NOT EXISTS eng4_head_retirements (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, state_id TEXT NOT NULL,
  retired_by_state_id TEXT NOT NULL, retired_at TEXT NOT NULL, retired_by TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, state_id),
  FOREIGN KEY (tenant_id, scope_key, state_id)             REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
  FOREIGN KEY (tenant_id, scope_key, retired_by_state_id)  REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
```

6. Evaluate divergence causally (§6.3) against `resolutions` and the expanded `rejectLineages`; under `strict: true` (default) any unresolved divergent terminal value fails the call with a typed error and nothing is written. Persist every resolution as an `eng4_divergence_resolutions` row keyed by this snapshot. This step requires the version data of §6 (see the dependency order in §7 — reconciliation ships **after** versioned materialization, never before).
7. Set the pointer to the reconcile snapshot (`reason: 'reconcile'`).
8. Materialize facts/loops (§6), ledger, `changes_hash` exactly as `write` does.

### 4.3 Replay integrity (finding 4)

On idempotent replay of a reconcile, the server re-reads `eng4_snapshot_merge_inputs`, `eng4_head_retirements` and `eng4_divergence_resolutions` for the snapshot and verifies **exact parity** with the `reconciliation` record in the hash-verified payload: same input set, same retired set, same resolution set (including the deterministic expansion of `rejectLineages`), `snapshot.parent_state_id == payload.survivor`, every retirement's `retired_by_state_id == this snapshot`, and the pointer row (if still pointing here) consistent.

**Resolution rows are also verified on every ordinary v3 `resume`** (12281537 issue 2): the server derives the expected resolution set from every hash-verified reconciliation payload on the current accepted lineage, compares it bidirectionally by cardinality, keys, decision and accepted ordinal to the table rows for those snapshots, and then validates every `accept` against the referenced digest-verified change-ledger row and canonical payload value. A row counts only if its `resolved_by_state_id` is on the current accepted lineage. Missing, extra, or altered rows are corruption → `CheckpointIntegrityError`; a direct `INSERT` of a well-formed same-scope row can therefore never mark a value resolved because no immutable payload vouches for it. This is the same fail-closed shape PR #8 uses for the change ledger.

### 4.4 `liveHeads()` after H3

A live head is a snapshot with **no child in its scope and no row in `eng4_head_retirements`**. Retired snapshots remain fetchable resources; `changesSince` still walks them.

### 4.5 Resurrection

Extending a retired parent with `operation: write` stays legal under the frozen v1 CAS. Under `resultVersion: 3` it additionally requires `acknowledgeRetired: true` (aad3973c Q3), so a stale client cache cannot do it by accident. Either way the child's parent is not the pointer, so by §3.2a the pointer does not move: the child is a live head that is never current, it appears in the `heads` section with `parentRetired: true`, and it must be reconciled like any other head. Nothing is lost and nothing silently becomes current.

### 4.6 Result (v3)

`written` + `changes` (PR #8) + `reconciled: { survivor, retired: [sorted], pointer, resolutions: [...], unresolvedDivergent: { facts, loops } }` (the counts are zero under `strict: true` by construction). Replay returns the same block after the §4.3 parity check.

### 4.7 Rejected alternatives

- *Tombstone without expected-set CAS*: any writer could hide another lane's branch. Rejected (b8456917 finding 3).
- *Child-of-abandoned-head*: head count never drops. Rejected.
- *Multi-parent as the only mechanism*: would change the frozen `liveHeads` definition. Single `parent_state_id` + merge inputs keeps the chain and adds ancestry as data.

→ **PR H3** (internal increment of v3; depends on H1 **and H2 — the version data must exist before any branch can be retired**, 12281537 issue 3): merge-input, retirement and resolution tables, `operation: 'reconcile'` with both CAS, causal resolution with `strict` default and `rejectLineages`, envelope-bound reconciliation record, replay parity, resolution verification on ordinary resume, `liveHeads` exclusion, pointer set on reconcile, `acknowledgeRetired`, `heads` items with `parentRetired`. Contract tests: head-set mismatch and pointer mismatch each conflict; permuted `expectedHeads` replays idempotently; parity failure throws; extra direct-INSERT resolution row is ignored/fails closed on resume; `accept` without a matching same-request change is rejected; cross-scope inputs/retirements rejected by FK; retired resources still resolve; resurrection requires acknowledgment under v3 and never moves the pointer.

## 5. C — Versioned checkpoint operations: `record` and `patch`

Scheduled as H5: gated on H1's pointer and H3's reconciliation so every `conflict` has a way out; H2/H4 supply the authoritative value model used by the final public v3 bundle.

### 5.1 Discriminant

`operation?: 'write' | 'record' | 'patch' | 'reconcile'`, valid only with `resultVersion: 3` (a v2 request carrying it fails input validation); absent → `write`. Bound into `requestFingerprint` **only when present and ≠ 'write'** (conditional spread, legacy bytes unchanged).

| operation | `state` | admissible parent | otherwise |
|---|---|---|---|
| `write` (default) | required, full | any existing same-scope parent | **branch** (frozen) |
| `record` | forbidden | the pointed head (`effectiveCurrentHead`, selection `pointer`) | `conflict` (carries the pointer) |
| `patch` | forbidden; `statePatch` required | the pointed head (selection `pointer`) | `conflict` |
| `reconcile` | required, full | survivor per §4 | `conflict` on either CAS |

"Pointed head" (aad3973c finding 5): `expectedRevision` must equal the revision of the pointer *now*. A successful `record`/`patch` advances the pointer by §3.2a like any other write on the pointed head. In `invalid-designation`, `max-revision`, or `empty-scope` mode both ops conflict (a legacy scope must reconcile once to leave `max-revision`).

### 5.2 Parent state comes from the verified payload (finding 8, Q4)

`record` and `patch` materialize the parent's state from the parent's **hash/size-verified canonical payload** (`verifyPayloadIntegrity` + parse `envelope.state`), never from `state_json`. With the immutability trigger (§3.1) and verified bytes, "parent id + resolved parent in the fingerprint" is sufficient: the parent cannot change under the fingerprint.

### 5.3 `record`

New snapshot with the parent's verified state verbatim. Envelope = `{ state: parentState, factChanges, loopChanges, events, evidenceRefs }` so `contentHash` binds the full materialized envelope. `requestFingerprint` binds `operation: 'record'` + resolved parent + the non-state changes.

### 5.4 `patch`

`statePatch` is an RFC 7396 merge patch against the verified parent state. Arrays replace wholesale — this does **not** solve retire-one-guardrail; that stays a separate design item. The materialized state must validate against `WORKING_STATE` or the call fails closed. `contentHash` binds the materialized envelope; `requestFingerprint` binds `operation: 'patch'` + resolved parent + the raw patch + non-state changes.

→ **PR H5** (internal increment of v3; depends on H1 and H3 so `conflict` has a way out): discriminant, `record`, `patch`, fingerprint binding, verified-payload materialization, schema branches. Contract tests: non-leaf parent conflicts for both ops in every selection mode; record preserves state byte-for-byte from the verified payload; patch validation; fingerprint isolation (`write` unchanged; `record` ≠ `patch` ≠ `write` for the same key); replay parity.

## 6. D — Versioned fact/loop materialization

### 6.1 Why a flag is not enough (aad3973c finding 3)

Attack: the designated lineage A holds fact F = good. A legacy `write` extends a retired head R and updates the same `factId` to F = bad. The in-place `UPDATE` destroys *good* immediately; a `fromRetiredHead` flag would only warn after the accepted value is gone. And "last writer has a retirement row" is the wrong predicate anyway: the last writer may be an ancestor inside an abandoned lineage that itself has no retirement row.

### 6.2 Model

Append-only versions, keyed by the writing snapshot **and change ordinal**, same-scope by structure at both ends (19826044 finding 2):

```sql
-- Same-scope parent targets: a fact/loop belongs to exactly one scope.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_facts_scope_id ON eng4_facts (tenant_id, scope_key, fact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_loops_scope_id ON eng4_open_loops (tenant_id, scope_key, loop_id);

CREATE TABLE IF NOT EXISTS eng4_fact_versions (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, fact_id TEXT NOT NULL,
  state_id TEXT NOT NULL, ordinal INTEGER NOT NULL,            -- = eng4_snapshot_changes (state_id, 'fact', ordinal)
  subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  status TEXT NOT NULL, effective_at TEXT, refs_json TEXT NOT NULL,
  author TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, fact_id, state_id, ordinal),
  FOREIGN KEY (tenant_id, scope_key, fact_id)  REFERENCES eng4_facts(tenant_id, scope_key, fact_id),
  FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
CREATE TRIGGER IF NOT EXISTS trg_eng4_fact_versions_immutable BEFORE UPDATE ON eng4_fact_versions
  BEGIN SELECT RAISE(ABORT, 'eng4: fact versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_eng4_fact_versions_no_delete BEFORE DELETE ON eng4_fact_versions
  BEGIN SELECT RAISE(ABORT, 'eng4: fact versions are append-only'); END;
-- eng4_loop_versions + its two triggers: same shape over the loop columns, FK to (tenant_id, scope_key, loop_id).

CREATE TABLE IF NOT EXISTS eng4_version_coverage (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, state_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','loop')), ordinal INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('materialized','unversioned')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('pre-h2-inherited-owner')),
  CHECK ((disposition = 'materialized' AND reason IS NULL) OR
         (disposition = 'unversioned' AND reason IS NOT NULL)),
  PRIMARY KEY (tenant_id, state_id, kind, ordinal),
  FOREIGN KEY (tenant_id, state_id, kind, ordinal)
    REFERENCES eng4_snapshot_changes(tenant_id, state_id, kind, ordinal),
  FOREIGN KEY (tenant_id, scope_key, state_id)
    REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
-- UPDATE and DELETE are forbidden by append-only triggers as for version tables.
```

A version in scope P can no longer reference a fact owned by scope Q; "append-only" is enforced by triggers, not prose. The coverage manifest gives every digest-bound ledger tuple exactly one explicit disposition, so an intentionally unversioned historical change is distinguishable from a deleted or missing version row.

**Integrity binding — bidirectional, before selection** (89c01374 blocker 4). A missing version row is invisible to a check that only inspects returned rows: selection would silently fall back to an older value. The durable cutover marker is the existing immutable `eng4_state_snapshots.changes_hash`:

- `changes_hash IS NOT NULL` means the snapshot has a digest-verified ledger and therefore **must** have one exact coverage row per ledger tuple; tuples marked `materialized` must have the exact version value implied by that ledger and its hash-verified payload, while `unversioned` is permitted only for a historical value that cannot be reconstructed exactly;
- `changes_hash IS NULL` is pre-ledger history and must have zero ledger, coverage, and version rows. Its fact/loop effects remain unversioned and non-authoritative in v3 until explicitly re-asserted. A ledger row under a null digest is corruption, not legacy history.

H2 installs the version and coverage tables and, in the same migration, performs a **verified backfill of every existing snapshot with non-null `changes_hash`**. For each such snapshot it verifies payload integrity and ledger digest/contiguity, emits one coverage row per `(state_id, kind, ordinal, change_id)`, and inserts a version whenever the complete post-change value is reconstructible. Fact changes and loop creations are reconstructible from the payload, ledger, snapshot metadata and immutable rows. A historical loop update that omitted `owner` may have inherited an overwritten pre-ledger value; if that exact value cannot be proven, its coverage is `unversioned` with reason `pre-h2-inherited-owner` instead of guessing. Any integrity failure—or any null-digest snapshot that already has ledger, coverage, or version rows—aborts the migration. The backfill is all-or-nothing. Only after it succeeds are dual writes enabled for all subsequent `write`, `record`, `patch`, and `reconcile` operations, regardless of requested result version; those writes know the materialized result and therefore always emit `materialized` coverage plus an exact version. This removes the ambiguous state where a missing version could be mistaken for intentional pre-version history.

The v3 read path enumerates the expected tuples for every snapshot in the lineages under consideration and compares them to coverage and version rows by **cardinality, keys, disposition, deterministic reason and values** before selection. A null-digest snapshot with any ledger/coverage/version row; a missing, extra or mismatched coverage row; a version for `unversioned` coverage; or a missing, extra or mismatched version for `materialized` coverage is `CheckpointIntegrityError` for the whole resume. H2's direct database tests exercise the verifier before the public read model exists; H4 exercises the same verifier through `resume`. Corruption fixtures drop an append-only trigger, delete one coverage row or one expected version row, and prove fail-closed behavior.

Every post-H2 materialization appends version rows **and** performs today's in-place update. The in-place tables are the frozen v1/v2 view (last-writer-wins, unchanged); versions are the v3 view. The same `factId` may appear more than once in one checkpoint; the total order over versions **within one lineage** is `(snapshot revision, change ordinal)` — that order is never used to compare across lineages (§6.3).

### 6.3 v3 selection: the accepted-value lineage, and causal resolution of divergence

Two ancestries, kept apart (19826044 finding 1):

- **`historicalAncestry(head)`** — everything reachable backwards through `parent_state_id` **and** `eng4_snapshot_merge_inputs`. Causal history; what resources and `changesSince` walk. Never a source of accepted values.
- **`acceptedLineage`** — the pointed head and its `parent_state_id` chain. A reconcile snapshot is on this line, so whatever the reconcile **itself** wrote is accepted; the branches it merged are not.

For each `fact_id` / `loop_id`, `resume` v3 first finds the newest **coverage tuple** (order `(revision, ordinal)` *within the accepted lineage*) whose `state_id ∈ acceptedLineage`. It returns the corresponding version only when that tuple is `materialized`; an `unversioned` newest tuple suppresses the id under §6.4 and never falls back to an older value. Every materialized version outside the accepted lineage is a **divergent value**, returned in the budgeted section `divergentValues` (`{ kind, id, lineageHead, stateId, revision, ordinal, value, isV1CurrentValue, resolved }`), never merged silently.

**Divergent lineages and terminal changes.** For a fact/loop, a *divergent lineage* is the chain of any live or retired head that is not on the accepted lineage, taken from its fork point with the accepted lineage forward. Its *terminal change* is the newest coverage tuple for that id on that chain. A `materialized` terminal has a terminal value; an `unversioned` terminal is opaque. Only terminal changes need resolving; interior versions are history.

An H2-backfilled terminal tuple whose coverage is `unversioned` is an **opaque terminal**: its id and provenance are proven but its historical value is not. Reconcile may only `reject` it (directly or through `rejectLineages`); `accept` cannot pass exact-value verification. It may not remain unresolved even with `strict: false`, because v3 has no truthful value to expose in `divergentValues`. The typed error lists `(kind, id, divergentStateId, reason)`, and the branch can instead be extended with a complete re-assertion before reconciliation. An unversioned terminal on the survivor lineage remains non-authoritative under §6.4 unless the reconcile itself re-asserts it.

**Resolution is causal, never revision-relative** (89c01374 blocker 2). A divergent terminal change is *resolved* iff a **verified** (§4.3) `eng4_divergence_resolutions` row exists for `(kind, id, divergentStateId = that terminal change's state_id)` written by a reconcile snapshot on the accepted lineage. Revision numbers play no part: survivor S holding *good@12* while non-survivor R holds *bad@11* leaves *bad* **unresolved** — it is a terminal value on a divergent lineage with no resolution row (the counterexample test).

**`accept` is bound to a matching change in the same request** (12281537 issue 2). An `accept` resolution is valid only if the reconcile's own `factChanges`/`loopChanges` contain, at a stated ordinal, a change for that id whose canonical value (RFC 8785 over the fields the version stores) **equals** the divergent terminal value; the resolution row records `accepted_ordinal`, and the reconciliation payload binds `(kind, id, divergentStateId, decision, acceptedOrdinal)`. An `accept` without such a change is a typed error and nothing is written — strict can never pass with an accept while the accepted lineage still holds the old value. A `reject` needs no change (the accepted value or absence stands) but is payload-bound the same way. **`rejectLineages`** (Q4) is a shorthand limited to exact live-or-retired divergent head ids named in the request: it expands deterministically, inside the CAS transaction, to per-terminal-value rejects, sorted, and the expansion is written into the payload; the raw sorted shorthand is what the fingerprint binds so replay can locate the snapshot before recomputation, after which payload/row expansion parity is verified. Overlapping or contradictory explicit resolutions are rejected.

```sql
CREATE TABLE IF NOT EXISTS eng4_divergence_resolutions (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','loop')), change_id TEXT NOT NULL,
  divergent_state_id TEXT NOT NULL,         -- the terminal change's snapshot
  resolved_by_state_id TEXT NOT NULL,       -- the reconcile snapshot (on the accepted lineage)
  decision TEXT NOT NULL CHECK (decision IN ('accept','reject')),
  accepted_ordinal INTEGER,                 -- NOT NULL iff decision='accept': the reconcile's own change that re-asserts the value
  CHECK ((decision = 'accept' AND accepted_ordinal IS NOT NULL) OR
         (decision = 'reject' AND accepted_ordinal IS NULL)),
  PRIMARY KEY (tenant_id, scope_key, kind, change_id, divergent_state_id),
  FOREIGN KEY (tenant_id, scope_key, divergent_state_id)   REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
  FOREIGN KEY (tenant_id, scope_key, resolved_by_state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
  FOREIGN KEY (tenant_id, resolved_by_state_id, kind, accepted_ordinal)
    REFERENCES eng4_snapshot_changes(tenant_id, state_id, kind, ordinal)
);
-- append-only triggers as for version tables
```

**Reconcile behaviour.** A reconcile enumerates every unresolved divergent terminal change across the heads it is merging and matches them against its `resolutions`. Opaque terminals must be rejected as described above. For materialized terminals, `strict: true`, the **default** (89c01374 ruling on §9.2), fails with a typed error listing the unresolved `(kind, id, divergentStateId)` tuples if any remain, writing nothing. `strict: false` is the audited escape hatch for materialized values only: the reconcile commits, `reconciled.unresolvedDivergent` carries the counts, and the values stay listed as divergent with `resolved: false` until a later reconcile resolves them.

Codex's v2 attack (S *good@10*, R *bad@12*, reconcile picks S without touching F): under strict default the reconcile is **refused** until it carries a resolution for F; under `strict: false` it commits with *good* accepted and *bad* listed divergent/unresolved. Either way *bad* never becomes accepted by revision.

**Loops** follow the same rule (19826044 Q3): a close written outside the accepted lineage leaves the loop *open* in v3 and lists the close as a divergent terminal value until a reconcile explicitly accepts it.

Provenance on every v3 item: `{ stateId, revision, ordinal, outsideAcceptedLineage: boolean }`.

### 6.4 Rows without a proven H2 version

A fact/loop id whose **newest accepted-lineage change has no verified materialized version is never authoritative in v3 — whether or not an older version or pointer exists** (12281537 issue 1). It is omitted from `currentFacts`/`openLoops` and exposed only in the non-authoritative section `legacyValues` as `{ kind, id, value: <in-place row>, provenance: null, accepted: false }`. The suppressed ids are accounted in `currentFacts`/`openLoops` coverage as `omittedReason: 'unversioned'`, `includedCount: 0` for those ids, `totalCount` including them, `contentComplete: false`, `nextCursor: null`, with `legacyValues` as the explicit alternate retrieval path (12281537 Q3). The id becomes authoritative only when a reconcile (or any later write on the accepted lineage) re-asserts it — creating a verified version — or through H2's proven ledger-bound backfill. Anything older than the ledger remains unknowable and cannot be backfilled by inference. The attack this closes: a legacy scope where the survivor's last write of F was *good* but the in-place row holds *bad* from the losing branch; the first strict reconcile has no version rows to see the divergence, so with no F change it commits — and F must then be **absent** from accepted facts with *bad* still in `legacyValues`, never promoted by the mere existence of a pointer (H4 test). Core H4 ships deterministic `null` provenance for every genuinely unversioned row — no flag, no second truth mode (19826044 Q4).

### 6.5 Legacy scopes (no pointer) under v3 — no accepted values

A non-empty scope without a pointer (pre-H1, never reconciled) has **no accepted lineage**, and v3 does not synthesize one from max revision (89c01374 ruling on §9.4): `currentFacts` and `openLoops` are returned **empty** with coverage `omittedReason: 'undesignated'`, `includedCount: 0`, `totalCount: <suppressed legacy-row count>`, `contentComplete: false`, `nextCursor: null` (12281537 Q3), and the in-place rows are exposed only in the non-authoritative budgeted section `legacyValues`. `working` keeps the explicitly flagged `max-revision` legacy selection from H1 (it is a whole snapshot, not a merged value). The scope leaves this mode with its first `reconcile` — after which §6.4 still governs every id that has no verified version on the new accepted lineage. That first reconcile on `hythe-rehydration-loop` is the acceptance canary.

→ **PR H2** (internal increment of v3; depends on H1; **the data foundation for reconciliation**): unique same-scope parents, version and coverage tables with append-only triggers, transactional verified backfill of every non-null-`changes_hash` snapshot, explicit `unversioned` coverage where an exact historical result is unprovable, dual materialization on every later operation, and the shared bidirectional verifier exercised directly in tests. No public read-model change. → **PR H4** (depends on H3): `acceptedLineage` vs `historicalAncestry` (one deduplicating indexed recursive CTE each, computed on demand — fork points are **not** persisted on retirement rows because a later reconcile can choose a different survivor and move them, 12281537 Q2; cache only after profiling, keyed by pointer + head/resolution set + schema version), v3 selection, `divergentValues` and `legacyValues` sections, `'undesignated'`/`'unversioned'` coverage, and `null` provenance for genuinely unversioned rows. Contract tests (H2 + H4 together): verified-backfill success and all-or-nothing failure; null-digest rows plus missing/extra coverage fail closed; omitted-owner historical loop update becomes explicit `unversioned` coverage; every post-H2 tuple is `materialized`; opaque divergent terminals must be rejected even under non-strict reconcile; the §6.1 attack; the §6.3 merge-input attack (S good@10, R bad@12) under strict (refused) and non-strict (good accepted, bad divergent); the **lower-revision counterexample** (S good@12, R bad@11 → bad still unresolved); the **unversioned-after-reconcile attack** (legacy scope, survivor's F=good unversioned, in-place F=bad from the losing branch, strict reconcile with no F change → F absent from accepted facts, bad in `legacyValues`); loop close off-lineage stays open; version/coverage row tampering or deletion rejected by trigger; **corruption fixtures**: triggers dropped, one expected coverage or version row deleted → v3 resume fails closed; cross-scope version rejected by FK; payload/ledger mismatch fails closed; legacy scope returns empty accepted sections + `legacyValues`; budget omission of `divergentValues` with cursor.

## 7. Rollout and acceptance

| Step | Content | Gate | Acceptance canary (on an internal build; v3 is public only after H5) |
|---|---|---|---|
| H1 | advancing pointer, resolver, immutability/no-delete triggers, resume v3 `asOf` + `heads` | codex acceptance of this note | the A→B / A→C attack test; `resume` v3 on `hythe-rehydration-loop` reports `selection: 'max-revision'`, `liveHeadCount: 13`, a complete `heads` section with `parentRetired: false` throughout; a fresh scope's first write sets the pointer; direct-SQL cross-scope pointer, per-column snapshot UPDATE, second digest write, and DELETE are all rejected; v2 requests carrying H-series fields fail validation |
| H2 | versioned fact/loop materialization + exact coverage manifest + verified ledger-bound backfill + dual writes + bidirectional parity (data foundation) | codex review; H1 merged | every ledger tuple gets exact `materialized` or justified `unversioned` coverage or the migration rolls back; null-digest history has no ledger/coverage/version rows; every later checkpoint produces verified materialized coverage and version rows; direct verifier corruption fixtures fail closed |
| H3 | reconcile: head mechanics + causal resolution (strict) + resolution verification | codex review; **H2 merged** | one `reconcile` on `hythe-rehydration-loop` naming all 13 heads and the null pointer; strict refusal until materialized terminals are resolved and every opaque terminal is rejected; afterwards `divergentHeadCount: 0`, `retiredHeadCount: 12`, the pointer is the reconcile snapshot, every retired snapshot resource resolves, replay parity holds |
| H4 | v3 read model: accepted-lineage selection, `divergentValues`, `legacyValues`, coverage reasons | codex review; H3 merged | the §6.1, §6.3, lower-revision and unversioned-after-reconcile attack tests; legacy scope reports no accepted values; genuinely pre-ledger rows report `null` |
| H5 | `record` / `patch`; **finalizes and publishes v3** | codex review; H1 and H3 merged (H4 for the publish) | `record` against a non-pointer parent → `conflict`; a pointer-parent `record` returns loop ids without a `resume` round-trip and advances the pointer (field report item 2 closed end to end) |

Order is H1 → H2 → H3 → H4 → H5 (12281537 issue 3: version data precedes any retirement of a branch). H1–H4 merge to main as internal increments: contract-tested, not published to npm, not deployed to Pavilion as a public schema. The first v3 publish/deploy follows H5 and is itself deploy-gated by the owner.

## 8. Resolved in design draft v2 (from review aad3973c)

| # | Finding | Resolution |
|---|---|---|
| 1 | cross-scope state ids representable | composite `(tenant, scope, state)` FKs on every new reference, backed by a unique index (§3.1, §3.2, §4.2) |
| 2 | `max-revision-fallback` fail-open | removed; `invalid-designation` returns `working: null`, conflicts record/patch, repaired only by CAS'd reconcile (§3.3) |
| 3 | provenance flag cannot protect values | versioned materialization + current-lineage selection + `divergentValues`; `null` provenance for unknowable history (§6) |
| 4 | reconciliation not integrity-bound | reconciliation record in the hash-verified envelope + row parity on replay; idempotency before CAS (§4.2–4.3) |
| 5 | anchor vs effective head ambiguous | one `effectiveCurrentHead` resolver; record/patch require the exact leaf; forked mode admits the selected leaf with the fork visible (§3.3, §5.1) |
| 6 | `divergentHeads` unbudgeted | `heads` is a budgeted section; `asOf` carries counts only (§3.5) |
| 7 | `expectedHeads` normalization | minItems 1, uniqueItems, sorted before fingerprint/persist/compare/replay (§4.1) |
| 8 | `state_json` not verified | record/patch read the verified payload; immutability trigger on snapshots (§3.1, §5.2) |

From re-review 19826044:

| # | Finding | Resolution |
|---|---|---|
| 1 | merge-input ancestry resolved conflicts by global revision | `acceptedLineage` (survivor line + reconcile's own writes) vs `historicalAncestry`; merge-input values stay divergent; `unresolvedDivergent` count and `strict` mode on reconcile (§6.3) |
| 2 | H4 versions not same-scope or integrity-safe | unique `(tenant, scope, id)` parents, composite FKs at both ends, append-only triggers, read-path verification against verified payload + verified ledger (§6.2) |
| 3 | snapshot immutability trigger incomplete | exactly one legal transition (`changes_hash` NULL→NOT NULL, all other columns identical), DELETE forbidden, per-column tests, table_info parity test (§3.1) |
| 4 | v2 release-freeze dependency | explicit gate: H-series on `resultVersion: 3` recommended, v2 stays as shipped; needs owner ruling (§2.10) |
| p | `parentRetired` before retirement support | required, constant `false` under H1/H2; shape unchanged when H3 begins setting it (§3.5) |
| p | reconcile parity scope | also verifies `parent_state_id == survivor` and every `retired_by_state_id == this snapshot` (§4.3) |
| p | version total order | `(snapshot revision, change ordinal)`; same id may repeat within a checkpoint (§6.2) |

From re-review 89c01374:

| # | Finding | Resolution |
|---|---|---|
| 1 | anchor + max-revision-among-descendants still promotes a stale parent (A→B, A→C) | `eng4_scope_current` is an **advancing pointer to the head**; a write advances it only if its parent is the pointed head; no revision comparison anywhere in selection; A→B/A→C is a contract test; concurrent-child semantics stated (§3.2, §3.2a, §3.3) |
| 2 | divergence resolution was revision-relative | causal resolution: divergent lineages' terminal values must be resolved by an explicit `eng4_divergence_resolutions` row written by a reconcile on the accepted lineage; lower-revision counterexample (S good@12, R bad@11) is a test; strict by default (§6.3) |
| 3 | v3 ruling contradicted by v2 references; partial release would re-freeze | every H-series clause now says v3; v2 input schemas reject H-series fields; H1–H4 are internal increments, v3 published only after H5 (§0, §2.2, §2.10, §4, §5, §7) |
| 4 | missing version rows undetectable | bidirectional exact-set parity (cardinality, keys, values) against verified payloads + ledger **before** selection; corruption fixture with trigger dropped (§6.2) |
| q | §9.2 strict default | strict by default; `strict: false` audited escape hatch (§4.1, §6.3) |
| q | §9.3 trigger construction | static audited SQL + `table_info` coverage test + per-column mutation tests; no generated SQL (§3.1) |
| q | §9.4 legacy scope | no accepted values synthesized from max revision; empty accepted sections + non-authoritative `legacyValues` (§6.5) |

From re-review 12281537:

| # | Finding | Resolution |
|---|---|---|
| 1 | unversioned in-place rows became authoritative once a pointer existed | an id with no verified accepted-lineage version is never authoritative; `legacyValues` + `omittedReason: 'unversioned'`; unversioned-after-reconcile attack is a test (§6.4) |
| 2 | resolution rows trusted without payload binding; `accept` not bound to a change | ordinary resume verifies every resolution row against the resolved-by snapshot's verified payload and its presence on the current accepted lineage; `accept` requires a same-request change at a recorded ordinal whose canonical value equals the divergent terminal (§4.3, §6.3) |
| 3 | reconciliation scheduled before version data existed | reorder H1 → H2 (versions) → H3 (reconcile) → H4 (read model) → H5 (record/patch, publish) (§7) |
| 4 | `resultVersion: 2` in §4.1 JSON; §3.5 title | corrected to v3 |
| q | §9.1 unconditional advance | confirmed (§3.2a) |
| q | §9.2 fork points | computed on demand; never persisted on retirement rows (§6, H4) |
| q | §9.3 coverage reasons | `'undesignated'` and `'unversioned'` with defined counts (§6.4, §6.5) |
| q | §9.4 `rejectLineages` | accepted with exact-head limitation, deterministic sorted expansion in the CAS transaction, payload binding, fingerprint on the raw shorthand, replay parity, contradiction rejection (§6.3) |

Q1–Q9 answers are incorporated where cited.

From codex-hythe takeover audit v5.1:

| # | Finding | Resolution |
|---|---|---|
| 1 | version parity could not distinguish an intentional historical gap from a deleted version | exact append-only `eng4_version_coverage` row for every digest-bound ledger tuple; bidirectional ledger/coverage/version verification (§6.2) |
| 2 | a historical loop update that omitted `owner` may not be reconstructible from the payload after later in-place writes | never guess: mark that tuple `unversioned` with the constrained reason; never fall back to an older accepted value; opaque divergent terminals can only be rejected (§6.2–6.4) |

## 9. Takeover rulings (v5.1)

1. **H2 remains data-only.** It exposes no diagnostics-only public path: that would create a third primitive and a temporary contract. H2 acceptance uses direct migration/database contract tests for verified backfill, dual writes and the shared parity verifier. H4 invokes the same verifier through `resume` before v3 can be published.
2. **`accept` equality stays exact.** “Accept with amendment” is modelled as `reject` of the divergent terminal value plus a fresh accepted-lineage change. Loosening equality would make `accept` ambiguous and weaken the audit record.
3. **`legacyValues` is last in v3 section order.** It is non-authoritative and therefore the first section omitted under a tight budget. Its coverage and cursor still obey the closed-accounting contract; authoritative sections are never displaced to include it.
4. **No persisted fork-point cache.** Fork points are derived by a deduplicating indexed recursive CTE because a later reconcile may choose a different survivor. Any future cache requires profiling evidence and keys on the pointer, relevant head/resolution set, and schema version.

## 10. Explicitly out of scope

Structured stable ids for guardrails/nextActions; per-scope privacy tier; inbox archival activation; multi-recipient send; anything touching Pavilion.
