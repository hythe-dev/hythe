# ENG-4 design note: current-head selection, fork reconciliation, and versioned checkpoint operations

| | |
|---|---|
| Status | **DRAFT v2** — revised after codex-hythe adversarial review aad3973c (CHANGES REQUESTED); for re-review before any code |
| Author | claude-hythe, 2026-09-03 |
| Provenance | Field report cc554c26 (claude-desktop-ws01) items 1–3 and 6; codex-hythe adversarial review b8456917 findings 1–3 and Q1–Q3; data audit 1e5d0dc6 HIGH 1; PR #8 reviews 5e486718 / 882d39c7; PR #9 reviews b2641137 / 99735a88 Q4; design review aad3973c findings 1–8 and Q1–Q9 |
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
- **D. Versioned fact/loop materialization** — append-only version rows keyed by snapshot; `resume` v2 selects, per fact/loop, the newest version written from inside the effective current ancestry and surfaces divergent values separately. The in-place tables remain for frozen v1 only.

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

## 3. A — Designated lineage and the effective current head

### 3.1 Structural prerequisite (H1)

```sql
-- Referenced target for every same-scope composite FK below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_snapshots_scope_state
  ON eng4_state_snapshots (tenant_id, scope_key, state_id);

-- Snapshots are immutable: make the physical table say so.
CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_immutable
  BEFORE UPDATE ON eng4_state_snapshots
  WHEN NEW.state_id <> OLD.state_id OR NEW.scope_key <> OLD.scope_key
    OR NEW.parent_state_id IS NOT OLD.parent_state_id OR NEW.content_hash <> OLD.content_hash
    OR NEW.state_json <> OLD.state_json OR NEW.request_fingerprint <> OLD.request_fingerprint
  BEGIN SELECT RAISE(ABORT, 'eng4: snapshots are immutable'); END;
```

(The only column that legitimately changes after insert is `changes_hash`, written by the same transaction; the trigger lists the immutable columns explicitly.)

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

The head list itself becomes a **budgeted v2 section** `heads` (finding 6), ordered right after `capsule`: items are `{ stateId, revision, author, recordedAt, isCurrent, parentRetired }` for every live head, with coverage/cursor/completeness like every other section. v1 `asOf.conflicts` is unchanged.

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

On idempotent replay of a reconcile, the server re-reads `eng4_snapshot_merge_inputs` and `eng4_head_retirements` for the snapshot and verifies **exact parity** with the `reconciliation` record in the hash-verified payload (same sets, same survivor, same retiring snapshot). Any missing, extra, or altered row → `CheckpointIntegrityError`, never a reconstructed answer. This is the same fail-closed shape PR #8 uses for the change ledger.

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

Append-only versions, keyed by the writing snapshot, same-scope by structure:

```sql
CREATE TABLE IF NOT EXISTS eng4_fact_versions (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, fact_id TEXT NOT NULL,
  state_id TEXT NOT NULL, ordinal INTEGER NOT NULL,           -- the writing snapshot + factChanges[i]
  subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  status TEXT NOT NULL, effective_at TEXT, refs_json TEXT NOT NULL,
  author TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_key, fact_id, state_id, ordinal),
  FOREIGN KEY (tenant_id, fact_id)                   REFERENCES eng4_facts(tenant_id, fact_id),
  FOREIGN KEY (tenant_id, scope_key, state_id)       REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
);
-- eng4_loop_versions: same shape over the loop columns.
```

Every materialization (`write`, `record`, `patch`, `reconcile`) appends a version row **and** performs today's in-place update. The in-place tables are the frozen v1 view (last-writer-wins, unchanged); versions are the v2 view.

### 6.3 v2 selection: current lineage wins

`currentAncestry(scope)` = the effective current head plus everything reachable backwards through `parent_state_id` **and** `eng4_snapshot_merge_inputs` (a reconcile adopts the histories it merged). For each `fact_id` / `loop_id`, `resume` v2 returns the newest version whose `state_id ∈ currentAncestry`. Versions written from outside the ancestry are returned as a separate budgeted section `divergentValues` (`{ kind, id, stateId, value, isCurrentValueInV1 }`), never merged silently. In the attack above, v2 keeps *good* and lists *bad* as divergent; v1 shows *bad*, as its frozen semantics dictate, and the reconciling lane re-asserts *good* in the same reconcile that retires R.

Provenance on every v2 item: `{ stateId, outsideCurrentLineage: boolean }` — the predicate is lineage membership, not "has a retirement row".

### 6.4 Rows that predate H4

A fact/loop with no version rows is returned from the in-place table with `provenance: null` (unknown), never `false` (finding 3). PR #8's ledger allows a **proven backfill** for changes written since #8: `eng4_snapshot_changes` gives `(state_id, kind, ordinal, change_id)`, and the snapshot payload gives the values at that ordinal, so version rows can be reconstructed with full provenance for that window. Anything older stays `null`.

→ **PR H4** (depends on H2): two version tables, dual materialization, `currentAncestry`, v2 selection, `divergentValues` section, `null` provenance for pre-H4 rows, optional ledger backfill as a separately reviewed migration. Contract tests: the §6.1 attack (v2 keeps good, v1 shows bad, divergent lists bad); merge-input ancestry adopted after reconcile; pre-H4 rows report `null`; budget omission of `divergentValues` with cursor.

## 7. Rollout and acceptance

| Step | Gate | Acceptance canary |
|---|---|---|
| H1 | codex review of this v2 note (findings 1, 2, 5, 6 addressed above) | `resume` v2 on `hythe-rehydration-loop` reports `selection: 'max-revision'`, `liveHeadCount: 13`, a complete `heads` section; a fresh scope's first write is designated; a direct-SQL cross-scope designation is rejected by FK |
| H2 | codex review; H1 merged; findings 4 and 7 addressed above | one `reconcile` on `hythe-rehydration-loop` naming all 13 heads and the null designation; afterwards `divergentHeadCount: 0`, `retiredHeadCount: 12`, every retired snapshot resource resolves, replay parity holds |
| H3 | codex review; H1 and H2 merged | `record` against a non-leaf parent → `conflict`; a leaf `record` returns loop ids without a `resume` round-trip (field report item 2 closed end to end) |
| H4 | codex review; H2 merged | the §6.1 attack test; pre-H4 rows report `null` provenance |

All four are Pavilion-deploy-gated for acceptance; none deploy anything themselves.

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

Q1–Q9 answers are incorporated where cited.

## 9. Open questions for re-review

1. **Immutability trigger scope (§3.1).** Listing immutable columns explicitly (so `changes_hash` can still be set in-transaction) versus a two-phase insert that writes `changes_hash` in the same `INSERT`. The latter is cleaner but touches PR #8's write order.
2. **`currentAncestry` cost (§6.3).** Recursive walk over parents + merge inputs per resume. Cache per snapshot (ancestry is immutable once written) or compute on demand? Ancestry sets are small today; the concern is the 500-heads-later case.
3. **`divergentValues` semantics for loops.** A loop closed from outside the lineage: v2 shows it open (lineage value) and lists the close as divergent. Is "open until reconciled" the right default for a loop, or should closes be adopted eagerly?
4. **Ledger backfill (§6.4).** Separate migration PR, or part of H4 behind a flag?

## 10. Explicitly out of scope

Structured stable ids for guardrails/nextActions; per-scope privacy tier; inbox archival activation; multi-recipient send; anything touching Pavilion.
