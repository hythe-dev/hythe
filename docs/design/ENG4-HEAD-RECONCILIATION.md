# ENG-4 design note: current-head selection, fork reconciliation, and versioned checkpoint operations

| | |
|---|---|
| Status | **DRAFT v3** — revised after codex-hythe reviews aad3973c and 19826044 (both CHANGES REQUESTED); for re-review before any code. One item (§2.10, result version for the H-series) needs an owner ruling. |
| Author | claude-hythe, 2026-09-03 |
| Provenance | Field report cc554c26 (claude-desktop-ws01) items 1–3 and 6; codex-hythe adversarial review b8456917 findings 1–3 and Q1–Q3; data audit 1e5d0dc6 HIGH 1; PR #8 reviews 5e486718 / 882d39c7; PR #9 reviews b2641137 / 99735a88 Q4; design review aad3973c findings 1–8 and Q1–Q9; design re-review 19826044 findings 1–4, precision items, and Q1–Q4 |
| Gates | Nothing in this note is authorized to ship. Each section ends with the PR it would become; every PR needs its own review. No Pavilion action is implied. |

## 0. Summary

Today the checkpoint/resume pair is branch-preserving on write but has no notion of *which* branch is current, no way to retire a branch, and no branch awareness for facts and loops. Three consequences were observed on one scope in one day:

1. `resume` selects the **max-revision live head** as current. Any writer extending an older parent produces a higher revision and silently becomes "current". The audit lane's review-progress snapshots displaced the working lane's state four times on 2026-09-03 (revisions 47/48, 54/55, 60, 65 over lane revisions 46, 53, 59, 63).
2. Live heads **only accumulate**. The scope `hythe-rehydration-loop` has 13 live heads; `resume.asOf.conflicts` lists all of them on every call and the list can never shrink.
3. **Facts and loops are scope-global rows** updated in place, last-writer-wins. A write from an abandoned branch destroys the accepted value immediately; nothing records which branch wrote what.

These gaps are why the field report's two most-requested features — `record` (fact/loop changes without resending state) and `statePatch` (merge-patch on state) — were ruled **not shippable yet** in b8456917 finding 1: under max-revision selection either op, run against a stale-but-valid parent, would *promote stale working state to current* as a side effect of logging one fact.

This note proposes, in dependency order:

- **A. Designated lineage and one effective-current-head resolver** — an explicit, scope-level, same-scope-constrained anchor; `resume` follows the anchor's lineage to exactly one live leaf; a broken designation is reported as invalid, never silently replaced by max-revision.
- **B. Atomic, integrity-bound reconciliation** — a checkpoint operation that names the exact expected live-head set and the expected designation (both CAS), chooses one survivor, retires the rest, and binds the normalized reconciliation record into the verified snapshot payload. Snapshots are never deleted.
- **C. Versioned checkpoint operations** — an explicit `operation` discriminant (`write` | `record` | `patch` | `reconcile`) on the existing `resultVersion=2` path. `record` and `patch` require the effective current head as parent and **conflict** instead of branching; they materialize the parent's state from its hash-verified payload. Legacy `write` and its v1 fingerprint stay byte-identical.
- **D. Versioned fact/loop materialization** — append-only, integrity-bound version rows keyed by snapshot and change ordinal; the v2+ view selects, per fact/loop, the newest version on the **accepted-value lineage** (survivor ancestry plus what reconcile snapshots wrote themselves — merge inputs are causal history, never a source of accepted values) and surfaces everything else as divergent until a reconcile explicitly accepts it. The in-place tables remain for frozen v1 only.

Order: C depends on A; D depends on B; nothing depends on D. Everything new that `resume` returns is a budgeted section; `asOf` gains only fixed-size fields.

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
2. **Frozen v1.** v1 request/result/bundle shapes and v1 `requestFingerprint` bytes unchanged. New semantics ride on `resultVersion: 2` and an explicit `operation`; omission of `operation` means legacy `write`.
3. **Branch-preserving CAS stays for `write`.** Only new operations get stricter parent rules.
4. **Never delete snapshots.** Retirement is a recorded act.
5. **Tenant identity from request context only**; every new table composite-keyed on `tenant_id`.
6. **One transaction per checkpoint.** Idempotency check, CAS, snapshot, designation, retirements, merge inputs, materialization, ledger, digests — all inside the existing transaction or nothing.
7. **Closed accounting.** Anything new that `resume` returns beyond fixed-size scalars is a budgeted section with coverage, cursor, and explicit completeness.
8. **Same-scope by structure** (aad3973c finding 1). Every new cross-reference between snapshots, and between a scope and a snapshot, is enforced structurally — composite keys on `(tenant_id, scope_key, state_id)` — not by convention.
9. **Fail closed, never fail open** (aad3973c finding 2). An invariant violation is reported as invalid; it never degrades to a guess.
10. **Result-version gate** (19826044 finding 4 — **needs owner ruling**). PRs #8/#9 define exact `resultVersion: 2` shapes, and the queue independently permits a #7+#8+#9 Pavilion deploy. H1 adds required `asOf` fields, a `heads` section and its coverage; H4 changes `currentFacts`/`openLoops` items and adds `divergentValues`. A client validating the #9 exact v2 schema would reject those bundles. **Recommendation:** the H-series ships on `resultVersion: 3` (v2 stays exactly as #8/#9 shipped it and remains deployable now; v3 = v2 + H-series fields, exact objects, same conditional-spread fingerprint rule). The alternative — freezing v2 undeployed until H4 lands — blocks the already-merged #8/#9 value for weeks. Until Tomas rules, no H-series PR starts. Everywhere below, "v2+" means "the version the ruling selects".

## 3. A — Designated lineage and the effective current head

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

### 3.2 Designation row

```sql
CREATE TABLE IF NOT EXISTS eng4_scope_current (
  tenant_id     TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  state_id      TEXT NOT NULL,           -- lineage ANCHOR, not necessarily a live leaf
  designated_at TEXT NOT NULL,
  designated_by TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('first-write','reconcile')),
  PRIMARY KEY (tenant_id, scope_key),
  FOREIGN KEY (tenant_id, scope_key)           REFERENCES eng4_scopes(tenant_id, scope_key),
  FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
```

The composite FK makes `(scope P, state from scope Q)` unrepresentable (finding 1).

### 3.3 One resolver: `effectiveCurrentHead(scope)`

Used by `resume` (to pick `working`) and by `record`/`patch` (as the only admissible parent). It is the single definition of "current" (finding 5).

```
anchor := eng4_scope_current[scope] or null
live   := liveHeads(scope)                       -- §4.4 definition (no child AND not retired)
if anchor is null:
    if live is empty: return { head: null, selection: 'empty-scope' }
    return { head: maxRevision(live), selection: 'max-revision' }          -- legacy scopes only
lineage := { anchor } ∪ descendants(anchor)      -- via parent_state_id, same scope
inLineage := live ∩ lineage
if inLineage is empty:
    return { head: null, selection: 'invalid-designation' }               -- fail closed (finding 2)
if |inLineage| == 1:
    return { head: the one, selection: 'designated' }
return { head: maxRevision(inLineage), selection: 'designated-lineage-forked' }
```

- **`invalid-designation`** is an invariant failure: reconcile replaces the designation in the same transaction it retires heads (§4), so a designated lineage with no live leaf cannot arise from correct operation. `resume` then returns `working: null`, `stale: true`, and `asOf.designated` showing the broken row; `record`/`patch` conflict. Repair is a reconcile with the administrative CAS in §4.2 — never an automatic fallback.
- **`designated-lineage-forked`**: the selected leaf is the max-revision live leaf inside the lineage; the fork stays visible in the `heads` section (§3.5) until reconciled. `record`/`patch` are admitted only against that exact leaf (finding 5).
- Legacy `max-revision` exists only for scopes that predate H1 and have never reconciled.

### 3.4 First write

The first snapshot in a scope designates itself (`reason: 'first-write'`) inside its own transaction, so new scopes never run in legacy mode. There is **no** standalone `designate` operation (Q1: a no-fork repair is `reconcile` with `expectedHeads = {sole head}`; a corrupt designation is repaired by a reconcile that names it in `expectedDesignation`).

### 3.5 What `resume` v2 adds

`asOf` gains only fixed-size fields:

```
asOf.selection:        'empty-scope' | 'max-revision' | 'designated' | 'designated-lineage-forked' | 'invalid-designation'
asOf.designated:       { stateId, revision, designatedAt, designatedBy, reason } | null
asOf.liveHeadCount:    integer
asOf.divergentHeadCount: integer      -- live heads other than the effective current head
asOf.retiredHeadCount: integer
```

The head list itself becomes a **budgeted v2+ section** `heads` (finding 6), ordered right after `capsule`: items are `{ stateId, revision, author, recordedAt, isCurrent, parentRetired }` for every live head, with coverage/cursor/completeness like every other section. Under H1 there are no retirements yet, so `parentRetired` is a required field that is always `false`; H2 starts setting it without changing the item shape (19826044 precision item). v1 `asOf.conflicts` is unchanged.

→ **PR H1**: unique index, immutability trigger, `eng4_scope_current`, the resolver, first-write designation, resume v2 `asOf` fields and `heads` section. Contract tests: every `selection` value including `invalid-designation` (constructed by direct SQL); cross-scope designation rejected by FK; snapshot UPDATE rejected by trigger; v1 bundle byte-identical; `heads` budget omission with cursor.

## 4. B — Atomic, integrity-bound reconciliation

### 4.1 Request (checkpoint, `resultVersion: 2`)

```jsonc
{
  "agentId": "...", "scope": {...}, "idempotencyKey": "...", "resultVersion": 2,
  "operation": "reconcile",
  "expectedRevision": <revision of the survivor>,
  "expectedHeads": ["<stateId>", ...],     // EXACT live-head set; minItems 1, uniqueItems; normalized (sorted) before anything else
  "expectedDesignation": "<stateId>" | null, // CAS on eng4_scope_current.state_id (null = no row / legacy scope)
  "survivor": "<stateId>",                 // ∈ expectedHeads
  "reason": "required free text",
  "state": {...},                          // full v1 working state — the reconciled truth
  // factChanges / loopChanges / events / evidenceRefs as in write (used to re-assert §6 values)
}
```

`expectedHeads` is kept as the explicit set (Q2); it is sorted before fingerprinting, persistence, comparison and replay so permutations never cause idempotency mismatches (finding 7). A digest may be added as an aid, never as a replacement.

### 4.2 Semantics (one transaction, in this order)

1. **Idempotency first** — unchanged from today and load-bearing here (finding 4): a retry of an already-successful reconcile must replay *before* the head-set CAS, because the successful reconcile changed the live set.
2. `liveHeads(scope)` as a set must equal `expectedHeads`; else `outcome: 'conflict'` with the real heads. `eng4_scope_current.state_id` (or null) must equal `expectedDesignation`; else `conflict` carrying the real designation. Both CAS in the same transaction (Q7, Q8).
3. `survivor ∈ expectedHeads`; `expectedRevision` = survivor's revision; else typed error.
4. Insert the reconcile snapshot with `parent_state_id = survivor` (single parent; frozen chain shape kept). The **envelope** carries the normalized reconciliation record so `contentHash` binds it and the snapshot resource is self-contained:

```jsonc
"reconciliation": { "expectedHeads": [sorted], "survivor": "...", "retired": [sorted], "expectedDesignation": ..., "reason": "..." }
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

6. Replace the designation row with the reconcile snapshot (`reason: 'reconcile'`).
7. Materialize facts/loops (§6), ledger, `changes_hash` exactly as `write` does.

### 4.3 Replay integrity (finding 4)

On idempotent replay of a reconcile, the server re-reads `eng4_snapshot_merge_inputs` and `eng4_head_retirements` for the snapshot and verifies **exact parity** with the `reconciliation` record in the hash-verified payload: same input set, same retired set, `snapshot.parent_state_id == payload.survivor`, and every retirement's `retired_by_state_id == this snapshot`. Any missing, extra, or altered row → `CheckpointIntegrityError`, never a reconstructed answer. This is the same fail-closed shape PR #8 uses for the change ledger.

### 4.4 `liveHeads()` after H2

A live head is a snapshot with **no child in its scope and no row in `eng4_head_retirements`**. Retired snapshots remain fetchable resources; `changesSince` still walks them.

### 4.5 Resurrection

Extending a retired parent with `operation: write` stays legal under the frozen v1 CAS. Under `resultVersion: 2` it additionally requires `acknowledgeRetired: true` (Q3), so a stale client cache cannot do it by accident. Either way the child is a new live head **outside** the designated lineage: it is never current, it appears in the `heads` section with `parentRetired: true`, and it must be reconciled like any other head. Nothing is lost and nothing silently becomes current.

### 4.6 Result (v2)

`written` + `changes` (PR #8) + `reconciled: { survivor, retired: [sorted], designated }`. Replay returns the same block after the §4.3 parity check.

### 4.7 Rejected alternatives

- *Tombstone without expected-set CAS*: any writer could hide another lane's branch. Rejected (b8456917 finding 3).
- *Child-of-abandoned-head*: head count never drops. Rejected.
- *Multi-parent as the only mechanism*: would change the frozen `liveHeads` definition. Single `parent_state_id` + merge inputs keeps the chain and adds ancestry as data.

→ **PR H2** (depends on H1): three tables/columns, `operation: 'reconcile'` with both CAS, envelope-bound reconciliation record, replay parity, `liveHeads` exclusion, `acknowledgeRetired`, `heads` items with `parentRetired`. Contract tests: head-set mismatch and designation mismatch each conflict; permuted `expectedHeads` replays idempotently; parity failure throws; cross-scope inputs/retirements rejected by FK; retired resources still resolve; resurrection requires acknowledgment under v2.

## 5. C — Versioned checkpoint operations: `record` and `patch`

Gated on H1; H2 recommended first so `conflict` has a way out.

### 5.1 Discriminant

`operation?: 'write' | 'record' | 'patch' | 'reconcile'`, valid only with `resultVersion: 2`; absent → `write`. Bound into `requestFingerprint` **only when present and ≠ 'write'** (conditional spread, legacy bytes unchanged).

| operation | `state` | admissible parent | otherwise |
|---|---|---|---|
| `write` (default) | required, full | any existing same-scope parent | **branch** (frozen) |
| `record` | forbidden | the exact leaf returned by `effectiveCurrentHead` | `conflict` (carries the effective head) |
| `patch` | forbidden; `statePatch` required | the exact leaf returned by `effectiveCurrentHead` | `conflict` |
| `reconcile` | required, full | survivor per §4 | `conflict` on either CAS |

"Exact leaf" (finding 5): `expectedRevision` must equal the revision of the head the resolver returns *now* — not the designation anchor, not any descendant. In `designated-lineage-forked` mode that is the selected leaf and the fork remains visible; in `invalid-designation`, `max-revision`, or `empty-scope` mode both ops conflict (a legacy scope must reconcile once to leave `max-revision`).

### 5.2 Parent state comes from the verified payload (finding 8, Q4)

`record` and `patch` materialize the parent's state from the parent's **hash/size-verified canonical payload** (`verifyPayloadIntegrity` + parse `envelope.state`), never from `state_json`. With the immutability trigger (§3.1) and verified bytes, "parent id + resolved parent in the fingerprint" is sufficient: the parent cannot change under the fingerprint.

### 5.3 `record`

New snapshot with the parent's verified state verbatim. Envelope = `{ state: parentState, factChanges, loopChanges, events, evidenceRefs }` so `contentHash` binds the full materialized envelope. `requestFingerprint` binds `operation: 'record'` + resolved parent + the non-state changes.

### 5.4 `patch`

`statePatch` is an RFC 7396 merge patch against the verified parent state. Arrays replace wholesale — this does **not** solve retire-one-guardrail; that stays a separate design item. The materialized state must validate against `WORKING_STATE` or the call fails closed. `contentHash` binds the materialized envelope; `requestFingerprint` binds `operation: 'patch'` + resolved parent + the raw patch + non-state changes.

→ **PR H3** (depends on H1, H2 first): discriminant, `record`, `patch`, fingerprint binding, verified-payload materialization, schema branches. Contract tests: non-leaf parent conflicts for both ops in every selection mode; record preserves state byte-for-byte from the verified payload; patch validation; fingerprint isolation (`write` unchanged; `record` ≠ `patch` ≠ `write` for the same key); replay parity.

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
```

A version in scope P can no longer reference a fact owned by scope Q; "append-only" is enforced by triggers, not prose.

**Integrity binding.** A version row is authoritative only if it agrees with two already-verified sources: the writing snapshot's hash-verified payload (`factChanges[ordinal]` / `loopChanges[ordinal]` values) and the digest-verified change ledger (`eng4_snapshot_changes` row `(state_id, kind, ordinal) → change_id`, which is where a generated id comes from). The v2+ read path verifies both for every version it returns and fails closed on a missing, extra, or mismatched row — the same rule as PR #8's ledger and §4.3's reconciliation parity.

Every materialization (`write`, `record`, `patch`, `reconcile`) appends version rows **and** performs today's in-place update. The in-place tables are the frozen v1 view (last-writer-wins, unchanged); versions are the v2+ view. The same `factId` may appear more than once in one checkpoint; the total order over versions is `(snapshot revision, change ordinal)`.

### 6.3 v2+ selection: the accepted-value lineage, never global revision

Two ancestries, kept apart (19826044 finding 1):

- **`historicalAncestry(head)`** — everything reachable backwards through `parent_state_id` **and** `eng4_snapshot_merge_inputs`. This is causal history: it is what resources and `changesSince` walk. It is **not** a source of accepted values.
- **`acceptedLineage(head)`** — the effective current head, its `parent_state_id` chain (the survivor line), and nothing else. A reconcile snapshot is on this line, so whatever the reconcile **itself** wrote (its own `factChanges`/`loopChanges`) is accepted; the branches it merged are not.

For each `fact_id` / `loop_id`, `resume` v2+ returns the newest version (order: snapshot revision, then change ordinal) whose `state_id ∈ acceptedLineage`. Every other version whose `state_id ∉ acceptedLineage` — including versions written on merge inputs — is returned in the budgeted section `divergentValues` (`{ kind, id, stateId, revision, ordinal, value, isV1CurrentValue }`), never merged silently.

Codex's attack on v2: survivor S has F=good at revision 10, merged head R has F=bad at revision 12, the reconcile picks S without a `factChange` for F. Under v3, R is causal history only; F resolves to *good*; *bad* is listed as divergent with `isV1CurrentValue: true` (the in-place v1 row still holds it) until a reconcile re-asserts good or accepts bad explicitly. Global revision never picks between branches.

**Reconcile visibility of unresolved values.** A reconcile computes, for every fact/loop, whether any version off the new accepted lineage is newer than the accepted one, and returns `reconciled.unresolvedDivergent: { facts: n, loops: n }` so the lane can follow up. A `strict: true` request flag makes the reconcile **fail** (typed error, nothing written) unless every such value is explicitly resolved by a `factChange`/`loopChange` in the same request — the alternative codex offered; default is non-strict with the count surfaced.

**Loops** follow the same rule (Q3): a close written outside the accepted lineage leaves the loop *open* in the v2+ view and lists the close as divergent until a reconcile explicitly accepts it. Eager adoption would let an abandoned branch hide live work.

Provenance on every v2+ item: `{ stateId, revision, ordinal, outsideAcceptedLineage: boolean }`.

### 6.4 Rows that predate H4

A fact/loop with no version rows is returned from the in-place table with `provenance: null` (unknown), never `false` (aad3973c finding 3). Core H4 ships deterministic `null` for every pre-H4 row — no flag, no second truth mode (Q4). PR #8's ledger allows a **proven backfill** for changes written since #8 (`eng4_snapshot_changes` gives `(state_id, kind, ordinal, change_id)`; the verified payload gives the values), reconstructed with full provenance for that window and nothing older, as a **separate reviewed migration PR after H4**.

→ **PR H4** (depends on H2): unique same-scope parents, two version tables with immutability triggers, dual materialization, `acceptedLineage` vs `historicalAncestry` (one indexed recursive CTE each, computed on demand — cache only after profiling, keyed by effective-head stateId, per Q2), version integrity verification against payload + ledger, v2+ selection, `divergentValues` section, `unresolvedDivergent` count and `strict` mode on reconcile, `null` provenance for pre-H4 rows. Contract tests: the §6.1 attack; the §6.3 merge-input attack (S good@10, R bad@12 → good accepted, bad divergent); loop close off-lineage stays open; version row tampering/deletion rejected by trigger; cross-scope version rejected by FK; payload/ledger mismatch fails closed; pre-H4 rows report `null`; budget omission of `divergentValues` with cursor.

## 7. Rollout and acceptance

| Step | Gate | Acceptance canary |
|---|---|---|
| H1 | owner ruling on §2.10; codex acceptance of this v3 (aad3973c 1/2/5/6 and 19826044 3/4 addressed) | `resume` v2+ on `hythe-rehydration-loop` reports `selection: 'max-revision'`, `liveHeadCount: 13`, a complete `heads` section with `parentRetired: false` throughout; a fresh scope's first write is designated; direct-SQL cross-scope designation, per-column snapshot UPDATE, second digest write, and DELETE are all rejected |
| H2 | codex review; H1 merged (aad3973c 4/7 addressed) | one `reconcile` on `hythe-rehydration-loop` naming all 13 heads and the null designation; afterwards `divergentHeadCount: 0`, `retiredHeadCount: 12`, every retired snapshot resource resolves, replay parity holds |
| H3 | codex review; H1 and H2 merged | `record` against a non-leaf parent → `conflict`; a leaf `record` returns loop ids without a `resume` round-trip (field report item 2 closed end to end) |
| H4 | codex review; H2 merged (19826044 1/2 addressed) | the §6.1 and §6.3 attack tests; pre-H4 rows report `null` provenance |

Order is H1 → H2 → H3 → H4 (codex 19826044). All four are Pavilion-deploy-gated for acceptance; none deploy anything themselves.

## 8. Resolved in v2 (from review aad3973c)

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
| p | `parentRetired` before H2 | required, constant `false` under H1; shape unchanged by H2 (§3.5) |
| p | reconcile parity scope | also verifies `parent_state_id == survivor` and every `retired_by_state_id == this snapshot` (§4.3) |
| p | version total order | `(snapshot revision, change ordinal)`; same id may repeat within a checkpoint (§6.2) |

Q1–Q9 answers are incorporated where cited.

## 9. Open questions for re-review

1. **Owner ruling (§2.10).** `resultVersion: 3` for the H-series (recommended) or freeze v2 undeployed until H4? This gates H1.
2. **`strict` reconcile default (§6.3).** Default non-strict with the `unresolvedDivergent` count surfaced, or default strict so a reconcile cannot commit with unresolved values? Non-strict matches today's manual-incorporation practice; strict is safer for the values.
3. **Trigger column-list parity test (§3.1).** Asserting the trigger's column list against `PRAGMA table_info` couples a test to trigger SQL text. Acceptable, or prefer a generated trigger from the column list at schema-apply time?
4. **`divergentValues` for a legacy `max-revision` scope (before its first reconcile).** No accepted lineage exists yet: return everything as accepted-by-legacy with `provenance: null`, or compute the lineage of the max-revision head as if designated? Proposed: the former, explicitly labelled, until the first reconcile.

## 10. Explicitly out of scope

Structured stable ids for guardrails/nextActions; per-scope privacy tier; inbox archival activation; multi-recipient send; anything touching Pavilion.
