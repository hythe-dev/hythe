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

## Discovering reusable knowledge

`resume` is deterministic rehydration for one exact scope; it does not
silently roam the whole tenant graph. When an agent needs knowledge that may
have been learned elsewhere, `discover_related_context` performs a separate,
read-only enrichment step:

1. exact-resolve the project/task scope;
2. retrieve bounded vector-similar entity, observation, and relation rows;
3. union those candidates with bounded one/two-hop graph neighbors;
4. rerank with explicit semantic and graph score components; and
5. explain each result with paths, current-observation status, evidence
   references, and author/timestamp provenance.

The discovery vocabulary comes from stored entities and relations — the
server contains no business/project names or fixed domain relation list.
Candidates are suggestions, not new truth: discovery never creates a relation
or changes memory. If an explained relationship is validated, a writer may
make it durable with the separate `create_relations` tool. A relation records
relevance; it never grants access, which remains controlled by tenant and
credential scopes.

## Scopes and tenancy

Every read and write is bound to a tenant (the security boundary) and most
are bound to a scope. Handles are scope-bound: knowing a raw row id from
another project does not make it dereferenceable through your scope.
Oversized-message handles also encode the exact recipient and dereference
only when tenant, scope, recipient, and message id all match the stored row.
In `observe` compatibility mode, a shared-key caller without per-agent proof
still treats the handle as a capability inside the tenant trust domain. In
`mixed` and `required`, an authenticated per-agent principal is checked against
the encoded exact recipient; required mode rejects an omitted proof.

## Security model — honest edition

- The **base API key or tenant credential** authenticates the deployment and
  tenant boundary; the server refuses to boot with the placeholder key, and
  compose binds to loopback by default.
- An independent **per-agent credential** binds an exact case-sensitive agent
  and least-privilege scopes. `observe` is compatibility telemetry, `mixed`
  reserves enforced principals without locking out every legacy lane, and
  `required` rejects missing proof on state-bearing and scoped operations.
- **CORS is closed by default** — no cross-origin browser access unless
  `CORS_ORIGINS` is set explicitly.
- The **content sanitizer** on write paths is regex-based and **advisory**:
  it catches obvious secret-looking and injection-looking content and
  audits what it flags, but it is not a security boundary. Do not put
  secrets in observations; treat retrieved content as untrusted input to
  your agent.
- The knowledge graph is tenant-shared by design. Per-agent authorization
  protects acting identity, direct mailboxes, recipient-bound resources, and
  scoped operations; it does not silently turn shared graph facts into
  row-private data.

## The coordination protocol

The ACP — ETA-driven cadence, loop-state entities, token hygiene,
stand-down — is specified in [SPEC.md](./SPEC.md). HYTHE is its reference
substrate; the tutorial walks a real two-harness session.

## Operational notes

Data is one SQLite file (WAL mode) — see BACKUP-AND-RESTORE.md for the
tested backup/restore/compaction runbook. The tool surface is versioned
and dieted (20 tools; see TOOL-COMPATIBILITY-MAP.md for every retired tool
and its exact replacement).
