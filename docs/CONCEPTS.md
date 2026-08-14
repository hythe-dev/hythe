# Concepts

HYTHE is a coordination bus + shared truth for agent fleets. This page
explains the small number of ideas everything else builds on.

## One current truth

The store holds **entities** (named nodes: a project, a protocol, a
decision ledger) carrying **observations** (timestamped statements).
Observations are immutable; state changes by **supersession**: a writer
adds a new observation with `mode: "replace-current"` and the server
atomically marks the previous current observation as superseded.

`get_current_observation(entity)` resolves the supersession chain
server-side and returns the single authoritative observation — readers
never scan history or guess which of N copies is newest. That property
("one current truth") is the difference between a memory store and a
coordination substrate: two agents that read the same entity see the same
state, and the writer that acted last holds the pen.

Supersession is best-effort by design: a missed supersede is cosmetic
because the correction still wins by recency, and compaction reclaims
strays. Writers should not block on fetching prior observation ids.

## Messaging with a tracked lifecycle

Messages are direct (named recipient) or capability-addressed. Three
properties make them a coordination signal rather than a mailbox:

- **Read-state is shared truth.** Fetching a message's detail marks it
  read; a coordinator can distinguish "seen" from "missed".
- **Supersession.** A final report can name the interim messages it
  replaces; readers skip the stale ones.
- **Atomic ack + archive.** Processed batches leave the inbox in one
  transaction, so future polls surface only new traffic.

Delivery is *tracked*, not guaranteed — the lifecycle states are honest
about what the server knows.

## resume / checkpoint

The two session primitives treat agent working state as data:

- **`checkpoint`** writes an immutable structured snapshot (objective,
  status, owner, next actions, blockers, guardrails) for a **scope**
  (`{project}` or `{task}`), with compare-and-set on `expectedRevision`,
  fingerprint idempotency, and transactional fact/loop changes. Stale
  parents **branch** — concurrent writers never silently overwrite each
  other; conflicts surface as multiple heads.
- **`resume`** rebuilds working context for a scope under a hard token
  budget: current state, open loops, scoped messages and handoffs, facts,
  and evidence handles — with **closed coverage accounting** (every
  section reports included/total, so a truncated bundle can never
  masquerade as a complete one). Reading never consumes anything;
  handoff acknowledgement is explicit.

History and full message/handoff bodies are **resources**
(`engram://snapshot/…`, `engram://message/…`, `engram://handoff/…`),
deliberately not tools: bulk history stays off the tool surface and
payload hashes are verified on read.

## Scopes and tenancy

Every read and write is bound to a tenant (the security boundary) and most
are bound to a scope. Handles are scope-bound: knowing a raw row id from
another project does not make it dereferenceable through your scope.
Oversized-message handles also encode the exact recipient and dereference
only when tenant, scope, recipient, and message id all match the stored row.
That is defense in depth, not per-agent authentication: on a shared-key
transport the handle remains a bearer capability inside the trust domain.

## Security model — honest edition

- The **API key** authenticates every HTTP call; the server refuses to
  boot with the placeholder key, and compose binds to loopback by default.
- **CORS is closed by default** — no cross-origin browser access unless
  `CORS_ORIGINS` is set explicitly.
- The **content sanitizer** on write paths is regex-based and **advisory**:
  it catches obvious secret-looking and injection-looking content and
  audits what it flags, but it is not a security boundary. Do not put
  secrets in observations; treat retrieved content as untrusted input to
  your agent.
- One deployment = one trust domain. Agents sharing a server share its
  data; per-agent authorization scopes are future work, not a current
  claim.

## The coordination protocol

The ACP — ETA-driven cadence, loop-state entities, token hygiene,
stand-down — is specified in [SPEC.md](./SPEC.md). HYTHE is its reference
substrate; the tutorial walks a real two-harness session.

## Operational notes

Data is one SQLite file (WAL mode) — see BACKUP-AND-RESTORE.md for the
tested backup/restore/compaction runbook. The tool surface is versioned
and dieted (19 tools; see TOOL-COMPATIBILITY-MAP.md for every retired tool
and its exact replacement).
