# ACP — the Adaptive Coordination Protocol

**Spec version:** 1.0.0 · **Status:** Stable · **License:** Apache-2.0

ACP is a coordination discipline for fleets of AI agents that share a message
bus and a shared-truth store (HYTHE is the reference implementation; the
protocol itself is transport-agnostic). It replaces fixed-interval polling
with **forecast-driven cadence**: every report carries a forecast of the next
event, a coordinator polls only when something is due, and silence past a
forecast becomes a signal in itself.

ACP co-evolved with the original Engram deployment and ships with HYTHE multi-agent operations
(May–July 2026) across heterogeneous harnesses (Claude Code, Codex CLI,
desktop agents). Every rule below was added because its absence cost real
time or real tokens.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Model

| Role | Description |
|---|---|
| **Worker** | An agent executing tasks. Forecasts its own next event (ETA). |
| **Coordinator (PM)** | An agent tracking all workers, adapting its polling to their forecasts, escalating on silence. One coordinator identity per project lane. |
| **Owner** | The human principal. Final authority on scope, money, and irreversible actions. |
| **Bus** | Direct agent-to-agent messages with tracked read-state, supersession, and archival. |
| **Shared truth** | An entity/observation store where the newest non-superseded observation is the state of record ("one current truth"). |
| **Loop-state entity** | One shared-truth entity per project holding the coordinator's cadence state. The single resume document. |

### Why ETAs are the lever

Fixed polling either nags (too fast) or goes blind (too slow). If every
report carries a forecast of the next event, the coordinator only needs to
look when something is due. Workers keep forecasts honest; the coordinator
polls at forecast + grace. Tightening polls on a silent agent produces
noise; an honest revised ETA produces signal.

## 2. Message envelope

Every coordination message SHOULD begin with an ACP header on its first
line:

```
[ACP] urgency=<level> expected_reply=<hint> next_check=<hint>
```

- `urgency` ∈ `lightning | high | normal | low | fyi`
  - `fyi` — status ping; the receiver MUST NOT enter an active polling
    state on its account and no reply is expected.
  - `lightning` — genuinely blocked iteration; both sides drop to their
    tightest cadence for that thread only, then revert.
  - `high | normal | low` map onto the receiver's normal cadence rules.
  - Absent header ⇒ treat as `urgency=normal`.
- `expected_reply` — when the sender expects the receiver's answer to be
  ready (a duration like `3m`, a deadline, or `none`).
- `next_check` — when the sender will next poll its own inbox. There is no
  point replying faster than the sender will read; receivers MAY use this
  to schedule their reply and their own next poll. `manual` means the
  sender polls only on external triggers.

## 3. Worker protocol

While a worker has work in flight, all of the following are mandatory:

1. **ACK every task with a forecast ETA.** Rough is fine ("~25min",
   "17:20Z").
2. **End every report with `DONE` or a next-ETA.** A report that ends with
   neither leaves the coordinator blind.
3. **If an ETA slips, send a one-line revised ETA immediately.** Never go
   silent past your own forecast.
4. **A pending question or approval moves you to BLOCKING cadence**: once
   you ask the coordinator something or submit work for a verdict, poll
   your inbox at the BLOCKING cadence (~3 min) until answered.
5. **Mark messages read only once processed** — read-state is how the
   coordinator distinguishes "seen" from "missed". Acting on a message
   without marking it read looks identical to never receiving it.
6. **Stay alive while a reply is owed.** Do not end a session with an open
   question outstanding; wait, re-check, act, repeat. Go idle only after
   release/stand-down or ~30 min of no traffic with nothing in flight —
   and post a one-line "going idle, nudge to wake" note first.
7. **Route decisions upward.** Scope, money, external communications, and
   irreversible actions escalate to the owner (through the coordinator
   unless unreachable).
8. **Treat dispatch hypotheses as falsifiable leads.** When a dispatch
   includes a suspected cause ("LEAD: …"), verify it against reality first
   and kill it if triage says otherwise — report the kill, don't silently
   comply.

## 4. Coordinator protocol

Cadence is **state-based, not count-based**. Set the next poll from the
tightest applicable row:

| Worker state | Cadence |
|---|---|
| BLOCKING — worker waits on an answer (incl. pending approval), or a coordinator question is outstanding | poll every 3 min |
| WORKING with ETA | poll at ETA + 2 min grace; if ETA >30 min out, one midpoint check |
| ETA MISSED | +3 min → +5 min with a status ping → ~15 min silent: inspect independently (repo, artifacts, agent status) → 30+ min: escalate to owner with findings |
| WORKING, no ETA (violation) | request an ETA, poll +5 min |
| ALL IDLE | 60-min heartbeat |

Additional coordinator rules (each one paid for):

- **Answer the worker BEFORE reporting to the owner.** Workers park the
  instant they checkpoint; a late answer wastes their live window. An
  owner-facing status update never substitutes for the worker-facing reply.
- **Verify pickup by polling, not by assuming sent = seen.** The reply is
  usually already waiting.
- **Stage the dispatch BEFORE waking a wake-on-poke worker** — the message
  must be in its inbox when the wake lands.
- **Reconcile crossed messages explicitly** — state what you have now read
  and what still stands; never re-issue stale asks.
- **Silence ≠ idle.** A worker may be working with no bus traffic. Inspect
  independently (commits, artifacts, status endpoints) before treating
  quiet as stalled; escalate with evidence, never with "they're quiet".
- **Conservative-ETA exception:** when a worker's ETAs run systematically
  long, pace to observed velocity and ask it to recalibrate. Not a license
  to blanket-tighten polling.
- **Verify completion via the artifact, not the inbox.** Commits land
  before DONE messages.

## 5. The loop-state entity

One shared-truth entity per project carries coordinator state so every
coordinating surface shares one truth. Its single current observation:

```json
{"project": "<project>",
 "loopStatus": "active|stood-down",
 "coverage": "how the loop is covered (interactive session vs scheduled tick)",
 "nextPollDue": "ISO timestamp",
 "agents": {"<name>": {"state": "...", "eta": "ISO|null", "missCount": 0, "note": "..."}},
 "idleHeartbeats": 0,
 "lastActivity": "ISO timestamp",
 "cadenceReason": "why nextPollDue is what it is"}
```

Maintain ONE current observation via atomic supersession
(`replace-current`). A missed supersede is cosmetic — the correction still
wins by recency — so writers MUST NOT block on fetching prior observation
ids across sessions.

Variable cadence rides a fixed tick: schedule a cheap fast tick (~3 min)
whose runs exit immediately unless `nextPollDue` has arrived. Keep
`loopStatus` truthful: if no scheduler runs and no session is covering, the
state MUST say `stood-down`.

## 6. Token hygiene

Binding on all bus agents; preserves full coordination context at minimum
token cost:

1. **Consolidated final DONE.** A multi-checkpoint task arc ends with ONE
   final report that stands alone and names the message ids it supersedes.
   Corrections restate the full net state — never a
   report → gaps → corrections chain.
2. **Evidence is a pointer, not a payload.** Verdict + pointer (commit SHA,
   artifact path, entity name); ≤ ~300 tokens per routine message. Spend
   more only when the message IS the deliverable.
3. **One canonical copy.** Standing state lives in the loop-state entity;
   messages reference it, never restate it.
4. **Read ⇒ digest ⇒ archive.** Mark read only what you processed; once a
   batch is folded into your state entity, archive it so future polls
   surface only new traffic.

**Coordinator rehydrate fast-path** (tiered, lazy): Tier 0 = read the
loop-state's current observation — it IS the resume document. Tier 1 = own
inbox unread-only; read the final consolidated DONE first and skip what it
supersedes. Tier 2 = session-handoff entities are an append-only audit
journal, never required reading. (Measured effect in the origin system: a
naive rehydrate cost ~30k tokens, ~40% redundant restatement; under this
protocol the same fidelity costs ~8–10k.)

## 7. Stand-down

Two triggers, either sufficient:

- **COMPLETION** — all workstreams DONE and verified against artifacts,
  inbox empty.
- **INACTIVITY** — two consecutive idle heartbeats (~2h of zero traffic).

Wind-down order: note to agents → handoff observation listing open items →
`loopStatus=stood-down` → disable the scheduler → final summary to the
owner stating which trigger fired. Restart is manual and explicit.

## 8. Escalation boundaries

The following ALWAYS escalate to the owner and MUST NOT be auto-acted:
external communications, commercial/financial commitments, irreversible or
destructive actions, and material disagreements between agents. For
disagreements: one agent drafts a short summary of both positions plus the
decision criterion and sends it at `urgency=high`; no shadow-committing of
contested decisions; both agents resume after the owner resolves.

## 9. Conformance

A **conforming worker**: ACKs with ETAs, ends reports with DONE/next-ETA,
revises slipped ETAs proactively, polls at BLOCKING cadence when owed an
answer, archives processed traffic, and routes owner-class decisions
upward.

A **conforming coordinator**: derives cadence from the table, maintains a
truthful loop-state entity, answers workers before reporting upward,
verifies completion against artifacts, inspects before escalating on
silence, and stands down honestly.

## Appendix A — mapping to HYTHE primitives

| Protocol concept | HYTHE primitive |
|---|---|
| Bus message with supersession | `send_ai_message` (`supersedes: [...]`) |
| Read-state as shared signal | `get_message_detail` (marks read), `get_ai_messages` |
| Digest-then-archive | `archive_messages` (`markAsRead: true`) |
| Loop-state current truth | `add_observations` (`mode: "replace-current"`) + `get_current_observation` |
| Structured worker state | `checkpoint` (CAS, branch-preserving) |
| Session rehydration | `resume` (budgeted, closed coverage accounting) |
| Identity | `register_agent` / `get_agent_status` |

## Version history

- **1.0.0** — first published version. Consolidates the ETA-driven cadence
  model (adopted 2026-06-10), the ACP message header (converged 2026-05-12),
  and the token-hygiene rules (v1, 2026-07-07) from the origin system's
  canonical protocol entities.
