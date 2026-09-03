# ENG-4 design note: current-head selection, fork reconciliation, and versioned checkpoint operations

| | |
|---|---|
| Status | **DRAFT** — for codex-hythe adversarial review before any code |
| Author | claude-hythe, 2026-09-03 |
| Provenance | Field report cc554c26 (claude-desktop-ws01) items 1–3 and 6; codex-hythe adversarial review b8456917 findings 1–3 and answers Q1–Q3; data audit 1e5d0dc6 HIGH 1; PR #8 reviews 5e486718 / 882d39c7; PR #9 reviews b2641137 / 99735a88 Q4 |
| Gates | Nothing in this note is authorized to ship. Each section ends with the PR it would become; every PR needs its own review. No Pavilion action is implied. |

## 0. Summary

Today the checkpoint/resume pair is branch-preserving on write but has no notion of *which* branch is current, no way to retire a branch, and no branch awareness for facts and loops. Three consequences were observed on one scope in one day:

1. `resume` selects the **max-revision live head** as current. Any writer extending an older parent produces a higher revision and silently becomes "current". The audit lane's review-progress snapshots displaced the working lane's state four times on 2026-09-03 (revisions 47/48, 54/55, 60, 65 over lane revisions 46, 53, 59, 63).
2. Live heads **only accumulate**. The scope `hythe-rehydration-loop` has 13 live heads; `resume.asOf.conflicts` lists all of them on every call and the list can never shrink.
3. **Facts and loops are scope-global rows** updated in place, last-writer-wins. They do not preserve branch divergence and cannot express "written from a branch that was later abandoned".

These three gaps are why the field report's two most-requested features — `record` (fact/loop changes without resending state) and `statePatch` (merge-patch on state) — were ruled **not shippable yet** in b8456917 finding 1: under max-revision selection either op, run against a stale-but-valid parent, would *promote stale working state to current* as a side effect of logging one fact.

This note proposes, in dependency order:

- **A. Designated current head** — an explicit, scope-level pointer to the head that is current, with lineage-following when that head is extended, and max-revision only as the flagged legacy fallback.
- **B. Atomic reconciliation** — a checkpoint operation that names the exact expected live-head set, chooses one survivor, retires the rest, and records the act. Snapshots are never deleted; retired heads can be inspected and, if extended, produce a new live head that must itself be reconciled.
- **C. Versioned checkpoint operations** — an explicit `operation` discriminant (`write` | `record` | `patch` | `reconcile`) on the existing `resultVersion=2` request path. `record` and `patch` require the designated current head as parent and **conflict** instead of branching. Legacy `write` and its v1 fingerprint stay byte-identical.
- **D. Branch provenance for facts and loops** — keep them scope-global (one truth per scope) but stamp each row with the snapshot that last wrote it, and let `resume` flag rows whose last writer sits on a retired head.

Order matters: C depends on A; D depends on B; nothing depends on D.

## 1. Facts on the ground (verified 2026-09-03)

**Code** (`src/unified-server/eng4/`, main at 1021928):

- `checkpoint.ts` `liveHeads()`: heads are snapshots that no other snapshot in the scope names as `parent_state_id`. There is no retirement, tombstone, or designation anywhere.
- `resume.ts`: `current = heads[heads.length - 1]` — heads are ordered by revision ascending, so current is max-revision. `asOf.conflicts = heads.length > 1 ? heads : []` includes the current head itself.
- CAS (frozen, review e0d81d4d #1): `expectedRevision` names any *existing* same-scope parent, live or not. Extending a stale parent **writes a branch child** with a new unique revision; `conflict` is reserved for a missing parent or `null` on a non-empty scope. This must not change for `operation: write`.
- `applyFactChanges`: an existing `factId` is `UPDATE`d in place; its refs are deleted and re-inserted. `applyLoopChanges`: an existing `loopId` is `UPDATE`d with `revision = revision + 1`. Neither row records which snapshot wrote it (PR #8's ledger records the reverse direction: snapshot → change ids).
- PR #8 established the extension pattern: `resultVersion: 2` on the request, bound into `requestFingerprint` only when 2 (legacy fingerprints unchanged), result shape branches as exact objects. PR #9 established that every v2 payload lives inside the closed budget/coverage model.

**Store** (`hythe-rehydration-loop`, revision 69): 13 live heads — codex-hythe revisions 7, 12, 14, 16, 18, 40, 44, 48, 55, 58, 60, 65, 67 and the claude-hythe line ending at 69. All are legitimate under the frozen CAS. None can be retired. `resume` returns all 13 in `conflicts` on every call (~600 tokens per resume of pure history).

**Manual "merge" today** means: read the other head's snapshot resource, copy what matters into your own next snapshot, and leave the other head live forever. The note records this as the baseline being replaced, not as a bug in the writer.

## 2. Constraints this design must respect

1. **Exactly two primitives.** No third tool. Everything below is a request/response extension of `checkpoint` and `resume` (register.ts "exactly two, never a third").
2. **Frozen v1.** The v1 checkpoint request/result, the v1 resume bundle, and the v1 `requestFingerprint` bytes are unchanged. New semantics ride on `resultVersion: 2` and, for checkpoint, an explicit `operation` discriminant; omission of `operation` means the legacy `write` (b8456917 Q2: "omission of state must never silently mean record").
3. **Branch-preserving CAS stays for `write`.** A stale parent still branches. Only the new operations get stricter parent rules.
4. **Never delete snapshots.** Retirement is a recorded act, not a deletion. History resources keep resolving.
5. **Tenant identity from request context only.** Every new table is composite-keyed on `tenant_id` like the existing ones.
6. **One transaction per checkpoint.** Designation, retirement, materialization, ledger, and digest all happen inside the existing transaction or not at all.
7. **Closed accounting.** Anything new that `resume` returns is budgeted with coverage, cursor, and explicit completeness (b2641137 blocker 1).

## 3. A — Designated current head

### 3.1 Model

New table:

```sql
CREATE TABLE IF NOT EXISTS eng4_scope_current (
  tenant_id     TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  state_id      TEXT NOT NULL,           -- the designated head at designation time
  designated_at TEXT NOT NULL,
  designated_by TEXT NOT NULL,           -- canonical agent principal
  reason        TEXT NOT NULL,           -- 'reconcile' | 'first-write' | 'explicit'
  PRIMARY KEY (tenant_id, scope_key),
  FOREIGN KEY (tenant_id, scope_key) REFERENCES eng4_scopes(tenant_id, scope_key),
  FOREIGN KEY (tenant_id, state_id)  REFERENCES eng4_state_snapshots(tenant_id, state_id)
);
```

One row per scope. It names a snapshot, not a revision number, so it survives branching.

### 3.2 Selection rule (`resume`)

```
designated := eng4_scope_current[scope] or null
if designated is null:
    current := max-revision live head            -- legacy; asOf.selection = 'max-revision'
else:
    D := descendants(designated) ∪ {designated}  -- transitive children via parent_state_id
    live := liveHeads(scope) ∩ D
    if live is empty:   -- designated head was retired and never extended, or something is wrong
        current := max-revision live head; asOf.selection = 'max-revision-fallback'
    elif |live| == 1:   current := that head;      asOf.selection = 'designated'
    else:               current := max-revision in live; asOf.selection = 'designated-lineage-forked'
```

Lineage-following means a lane that keeps writing on its own designated line never has to re-designate. A fork *within* the designated lineage is still visible (`designated-lineage-forked`) and is the case reconciliation exists for.

### 3.3 What `resume` v2 adds (budgeted, `asOf` is not a section but is small and fixed-size)

```
asOf.selection:      'max-revision' | 'designated' | 'designated-lineage-forked' | 'max-revision-fallback'
asOf.designated:     { stateId, revision, designatedAt, designatedBy, reason } | null
asOf.divergentHeads: [...]   -- live heads that are NOT current (replaces the self-including `conflicts` in v2)
asOf.retiredHeads:   integer -- count only; the list is a history resource, not bundle content
```

v1 keeps `conflicts` exactly as today.

### 3.4 Who may designate

- The first write in a scope designates itself (`reason: 'first-write'`), so new scopes are never in legacy mode.
- `reconcile` (section B) designates the survivor.
- An explicit `operation: 'designate'` is **not** proposed. Designation without reconciliation would let a writer flip "current" away from another lane's live head without retiring it, which is the silent-displacement problem in a new costume. If a lane wants to be current, it reconciles.

### 3.5 Migration

Existing scopes have no row and stay in `max-revision` mode until their first `reconcile`. `hythe-rehydration-loop` is the acceptance canary: one reconcile naming all 13 heads, survivor = the working lane's head.

→ **PR H1**: table, selection rule, resume v2 `asOf` fields, first-write designation. Contract tests: every selection branch; v1 bundle byte-identical; migration on a scope with pre-existing heads.

## 4. B — Atomic reconciliation

### 4.1 Request (checkpoint, `resultVersion: 2`)

```jsonc
{
  "agentId": "...", "scope": {...}, "idempotencyKey": "...", "resultVersion": 2,
  "operation": "reconcile",
  "expectedRevision": <revision of the survivor>,      // CAS on the survivor, as today
  "expectedHeads": ["<stateId>", ...],                 // the EXACT current live-head set (all of them)
  "survivor": "<stateId>",                             // must be in expectedHeads
  "reason": "free text, required",
  "state": {...}                                       // the reconciled working state (full, v1 shape)
  // factChanges / loopChanges / events / evidenceRefs allowed as in write
}
```

### 4.2 Semantics (one transaction)

1. Resolve scope; compute `liveHeads`. If the set of live state ids ≠ `expectedHeads` (as sets) → `outcome: 'conflict'` with the real heads. This is the anti-race: you can only reconcile the fork you actually saw.
2. `survivor ∈ expectedHeads`, else typed error. `expectedRevision` must be the survivor's revision, else typed error (the two parent references must agree).
3. Insert the new snapshot with `parent_state_id = survivor` (single parent — the immutable chain shape does not change) **and** record every other expected head as a merge input:

```sql
CREATE TABLE IF NOT EXISTS eng4_snapshot_merge_inputs (
  tenant_id TEXT NOT NULL, state_id TEXT NOT NULL, input_state_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, state_id, input_state_id),
  FOREIGN KEY (tenant_id, state_id)       REFERENCES eng4_state_snapshots(tenant_id, state_id),
  FOREIGN KEY (tenant_id, input_state_id) REFERENCES eng4_state_snapshots(tenant_id, state_id)
);
```

4. Retire every expected head except the survivor:

```sql
CREATE TABLE IF NOT EXISTS eng4_head_retirements (
  tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, state_id TEXT NOT NULL,
  retired_by_state_id TEXT NOT NULL,   -- the reconcile snapshot
  retired_at TEXT NOT NULL, retired_by TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY (tenant_id, state_id),
  FOREIGN KEY (tenant_id, state_id)            REFERENCES eng4_state_snapshots(tenant_id, state_id),
  FOREIGN KEY (tenant_id, retired_by_state_id) REFERENCES eng4_state_snapshots(tenant_id, state_id)
);
```

5. Designate the new snapshot as current (`reason: 'reconcile'`).
6. Materialize facts/loops, ledger, digest exactly as `write` does.

`liveHeads()` becomes: no child **and** no retirement row. Retired snapshots remain fetchable resources; `changesSince` still walks them.

### 4.3 Resurrection rule (asked in b8456917 finding 3)

Extending a retired head with `operation: write` is still legal (frozen CAS). The child is a new live head with a retired parent. It is **not** current (the designated lineage does not include it) and `resume` reports it in `divergentHeads` with `parentRetired: true`. It gets reconciled like any other head. Nothing is silently lost and nothing silently becomes current.

### 4.4 Result (v2)

`written` + `changes` (from #8) + `reconciled: { survivor, retired: [...], designated: stateId }`. Idempotent replay returns the same block from the retirement/merge-input rows (they are keyed by the reconcile snapshot, so no new ledger is needed).

### 4.5 Why not the alternatives

- *Tombstone without expected-set CAS* (the original PR-B idea): lets any writer hide another lane's branch; race-prone. Rejected in b8456917 finding 3.
- *Child-of-abandoned-head*: replaces one live head with another; head count never drops. Rejected.
- *Multi-parent as the only mechanism*: cleaner ancestry but `liveHeads()` would have to treat every merge input as "claimed by a child", which is a semantic change to the frozen `liveHeads` definition. Keeping single `parent_state_id` + a separate inputs table preserves the frozen chain and adds ancestry as data.

→ **PR H2** (depends on H1): three tables, `operation: 'reconcile'`, `liveHeads` exclusion, resume `divergentHeads`/`parentRetired`, replayable `reconciled` block. Contract tests: expected-set mismatch conflicts; survivor validation; retirement excluded from heads; resurrection produces a flagged live head; snapshot resources still resolve for retired heads; idempotent replay parity.

## 5. C — Versioned checkpoint operations: `record` and `patch`

Gated on H1 (designated head) — this is finding 1 of b8456917.

### 5.1 Discriminant

`operation?: 'write' | 'record' | 'patch' | 'reconcile'` on the request, valid only with `resultVersion: 2`; absent → `write` (legacy). Bound into `requestFingerprint` **only when present and ≠ 'write'**, so legacy fingerprints stay byte-identical (same conditional-spread technique as `resultVersion`).

| operation | `state` | parent rule | stale parent → |
|---|---|---|---|
| `write` (default) | required, full | any existing same-scope parent | **branch** (frozen) |
| `record` | forbidden | must be the **designated current head** | `conflict` |
| `patch` | forbidden; `statePatch` required | must be the designated current head | `conflict` |
| `reconcile` | required, full | survivor per §4 | `conflict` on head-set mismatch |

`record` and `patch` never branch. If the parent is not the designated current head the caller gets `conflict` with the real head, re-resumes, and retries. That is the whole point: neither op can promote stale state.

### 5.2 `record`

The new snapshot reuses the parent's `state_json` verbatim. The envelope is materialized as `{ state: parent.state, factChanges, loopChanges, events, evidenceRefs }` so the snapshot resource stays self-contained and `contentHash` binds the full materialized envelope. `requestFingerprint` binds `operation: 'record'` + resolved parent + the non-state changes (the caller never sent state, so the fingerprint must not pretend it did).

### 5.3 `patch`

`statePatch` is an RFC 7396 JSON merge patch against the parent's state. Arrays replace wholesale (RFC 7396) — this does **not** solve retire-one-guardrail; that stays a design-note item (structured guardrail ids). The materialized state must validate against `WORKING_STATE`; a patch that removes a required key fails closed as a typed error. `contentHash` binds the materialized envelope; `requestFingerprint` binds `operation: 'patch'` + resolved parent + the raw patch + non-state changes.

### 5.4 Why this is safe only after H1

With max-revision selection, a `record` on revision 46 while revision 48 exists writes revision 49 with 46's state and *that* becomes current. With designation, revision 46 is not the designated head → `conflict`. The caller must reconcile or re-resume first.

→ **PR H3** (depends on H1; H2 recommended first so `conflict` has a way out): discriminant, `record`, `patch`, fingerprint binding, materialization, schema branches. Contract tests: stale-parent conflict for both ops; record preserves state byte-for-byte; patch materialization + WORKING_STATE validation; fingerprint isolation (write fingerprints unchanged; record ≠ patch ≠ write for the same key); replay parity.

## 6. D — Branch provenance for facts and loops

Full branching of facts/loops (per-snapshot copies) is rejected: it multiplies rows per revision, breaks the "one truth per scope" that `currentFacts` promises, and nothing in the field report asked for it. Instead:

- Add `last_state_id` to `eng4_facts` and `eng4_open_loops` (guarded additive ALTER), written by every materialization.
- `resume` v2 `currentFacts` / `openLoops` items gain `provenance: { lastStateId, fromRetiredHead: boolean }`. A fact last written from a retired head is still current (last-writer-wins is unchanged) but is **flagged** so the reconciling lane can re-assert or supersede it.
- `reconcile` may carry `factChanges` / `loopChanges` like any write, which is how a lane re-asserts a flagged row in the same transaction that retires the head.

→ **PR H4** (depends on H2): two columns, provenance on v2 items, tests that a retired-head write is flagged and a re-assertion clears the flag.

## 7. Rollout and acceptance

| Step | Gate | Acceptance canary |
|---|---|---|
| H1 | codex review | `resume` v2 on `hythe-rehydration-loop` reports `selection: 'max-revision'` and 13 divergent heads; a fresh scope's first write is designated |
| H2 | codex review | one `reconcile` on `hythe-rehydration-loop` naming all 13 heads; afterwards `divergentHeads: []`, `retiredHeads: 12`, and every retired snapshot resource still resolves |
| H3 | codex review; H1 merged | `record` against a non-designated parent → `conflict`; a designated-parent `record` returns loop ids without a `resume` round-trip (field report item 2 closed end to end) |
| H4 | codex review; H2 merged | a fact written from a retired head shows `fromRetiredHead: true` until re-asserted |

All four are Pavilion-deploy-gated for acceptance; none deploy anything themselves.

## 8. Open questions for review

1. **Designation without reconcile (§3.4).** I rejected an explicit `designate` op. Is there a legitimate single-lane case (no fork, wrong head designated by a bad first write) that needs it, and if so what CAS protects it?
2. **`expectedHeads` as a full set (§4.2).** Alternative: a hash of the sorted head set. Full set is more explicit and self-documenting in the snapshot; hash is smaller. Preference?
3. **Retired-head resurrection (§4.3).** Should extending a retired parent with `write` require an explicit acknowledgment field (e.g. `acknowledgeRetired: true`) so it cannot happen by accident from a stale client cache?
4. **`record` fingerprint (§5.2).** It binds the parent id but not the parent's state bytes. A replay after the parent's state was… no, snapshots are immutable, so the parent's state cannot change. Confirm there is no hole here.
5. **Scope-global facts (§6).** Is the provenance flag enough, or does any consumer need per-branch fact views? I found none in the field report or the code.
6. **Budget.** `asOf.divergentHeads` is unbounded in principle (13 today). Should it be a budgeted section like `capsule`, or capped with `truncated: true` and a resource pointer?

## 9. Explicitly out of scope

Structured stable ids for guardrails/nextActions; per-scope privacy tier; inbox archival activation; multi-recipient send; anything touching Pavilion. Each has its own line in the checkpoint queue.
