# P1: stale resume pointer — visibility (done) and low-friction reconcile (proposal)

Status: part A implemented on branch `fix/resume-pointer-lag`; part B is a
proposal only, for review and an owner decision.
Source: field report 9ceed35e P1 (2026-09-20), task 1147d702 item 2.
Written 2026-11-12.

## The report

On scope `scope-a` the pointer sat at revision 378 while live heads
reached ~500. `resume` handed a newcomer state ~120 revisions old with no
warning. The same pattern shows on `scope-b` (another agent,
2026-10-17/18: "resume still selects stale 215 with divergent 492 listed").
The report asks for (1) the divergence to be surfaced prominently, with
revision lag and head count, and (2) "a low-friction auto-reconcile path when
all heads share one lineage".

## Why the lag grows

From `checkpoint.ts` and `heads.ts` §3.2a:

- a write's parent is the snapshot whose revision equals `expectedRevision`;
- revisions are numbered scope-wide (`MAX(revision) + 1`);
- the pointer advances only when the new snapshot's parent IS the pointed head.

So one stale write forks a branch, and an agent that then keeps
checkpointing on its own branch's latest revision grows that branch with
ever-higher revisions while "current" stays where it was. Nothing is lost,
but every newcomer resumes the old head. This is H1 working as designed:
it never picks "current" by revision. The gap was that nobody was told.

## A. Visibility (implemented)

`src/unified-server/eng4/divergence.ts`. When `asOf.conflicts` has two or
more live heads, the `resume` and `begin_session` handlers append a
plain-text notice as `content[1]`:

- WARNING when another live head is newer than current: current revision,
  other-head count, newest revision/author/time, and the lag in revisions;
- WARNING when no head is designated current;
- NOTE when forked but current is the newest;
- every live head listed, current marked;
- the fix-forward rule: "checkpoint with expectedRevision <current>"; a write
  on any other head's revision extends a branch that does not become current;
- how to inspect (v3 `heads` section) and how to merge (`reconcile`).

Compatibility: `content[0]` stays the exact JSON of `structuredContent`, and
no output schema changes. The frozen v1/v2 shapes and the final v3 shape are
untouched, and an unforked scope's response is byte-identical to before.
Tests: `tests/contract-eng4-divergence-notice.test.ts` (7), including that
following the notice's advice actually advances the pointer.

Not done here: a machine-readable `revisionLag` field. It would need a
v1/v2/v3 output-schema change. v1/v2 are frozen and v3 is final pending the
owner's publication decision, so that belongs with v3 publication.

## B. Low-friction reconcile (proposal)

### "All heads share one lineage" cannot occur as stated

By the advance rule the pointed head never has a child (a child of the
pointed head becomes the pointer), and a live head has no children by
definition. So no live head ever descends from another live head, and two
live heads always share only an ancestor. The real case behind the report is
"exactly one stray branch that a single lane kept extending", and the safe
question is whether merging it can lose or contradict anything.

### Options

1. **Prepared reconcile in resume v3 (recommended).** When the scope is
   forked AND `opaqueDivergentCount = 0` AND `divergentValues` is empty (no
   divergent fact/loop terminals to resolve), `resume` v3 adds a
   `reconcileDraft`: `expectedHeads`, `expectedPointer`, and one candidate
   per live head with its `expectedRevision`. The agent picks the survivor,
   supplies `state` and `reason`, and sends it. The CAS guards and strict
   resolution are unchanged, so a draft that went stale between read and
   write simply conflicts. Cost: one new optional v3 field; needs the owner,
   because v3 is final.
2. **Advise fix-forward only.** Part A already tells the lane to write on the
   current revision. This stops further lag growth without any merge. The
   stray head stays live, and the notice keeps reporting it as a NOTE. No
   schema change. This is the immediate mitigation.
3. **Server-side auto-reconcile** (on resume or on write): rejected. It
   would pick a survivor without a decision, which is the exact failure H1
   removed (ENG-4 design §0: "never silently pick"), and it would let a read
   mutate state.
4. **`survivor: "newest"` shorthand on reconcile:** rejected. It drops the
   expected-set CAS that design §4.7 requires ("any writer could hide another
   lane's branch").

### Recommendation

Ship A now (after review). Use option 2 operationally. Adopt option 1 with
v3 publication if the owner wants it. Options 3 and 4 should not be built.

## Open points for the reviewer

- Some MCP clients may surface only `structuredContent` to the model. If a
  client drops `content[1]`, part A is invisible there; option 1 or a v3
  `revisionLag` field would cover that client class.
- `begin_session` shares the helper but has no dedicated test; it returns the
  same `performResume` bundle.
