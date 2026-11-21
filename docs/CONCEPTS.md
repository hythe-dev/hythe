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

### Who sent it: `authoredBy` and `attributionSource`

Every message item (`get_ai_messages`, `get_message_detail`, and the REST
mailbox) carries two top-level labels saying how the server knew the sender:

| attributionSource | Meaning |
|---|---|
| `credential` | `from` is proven by the sender's per-agent credential. |
| `asserted` | The caller supplied `from` without a per-agent credential; the server took its word for it. |
| `server-default` | No `from` at all; the server's own id was used. |
| `unknown` | Stored before these labels existed. |

`authoredBy` is the stored sender id. Every row of a broadcast or
capability send is labelled. This is labelling only: it does not change who
may send, and it never exposes credential or key identifiers.

On a **shared connection** (several agents behind one bridge or one base
key, none with its own agent key), every sender reads `asserted`, so the
label cannot tell those co-located agents apart: a message saying
`authoredBy: "codex"` may have been sent by any agent on that connection.
Likewise a lane whose bridge pins its agent id (`HYTHE_AGENT_ID`) but
presents no per-agent key reads `asserted`. The fix is a per-agent
credential for each agent (`HYTHE_AGENT_KEY_FILE` on the bridge); its sends
then read `credential`.

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

### Two kinds of decision

A decision can be recorded in two places, and they mean different things:

- **Checkpoint decision**: an `events` item with `kind:"decision"` on a
  `checkpoint`. It is part of that snapshot, so it describes the current
  working state and is replaced when the next checkpoint omits it.
- **Observation decision**: `add_observations` with `kind:"decision"`
  (exact, case-sensitive) on the scope entity: the project, or the task when
  the scope names only a task. It is durable knowledge that stays current
  until another observation on the same entity supersedes it
  (`metadata.supersedes`, which `mode:"replace-current"` also writes: a
  replace-current note of any kind hides the decision it replaces).

`resume` with `resultVersion` 2 or 3 lists both in `decisions`:
checkpoint decisions first (`source:"checkpoint"`), then the unsuperseded
observation decisions on the scope entity, newest first
(`source:"observation"`, with `observationId` and `author`). At most the 10
newest observation decisions are listed; `observationDecisions` reports
`listedCount`, `totalCount` and `omittedCount`. They share the section's
budget and cursor. The frozen v1 bundle lists checkpoint decisions only,
without `source`.

`scope.project` and `scope.task` resolve the same way (as do `checkpoint`
and `discover_related_context`), exact first. Exact owners are read from the
stored entity records: the canonical name and every top-level declared alias,
compared case- and punctuation-insensitively. The search index is not used
for this step, so an alias the index dropped (it keeps at most 64 keys per
entity), an entity with no index entries, or an alias changed without a
reindex still counts, and a stale index entry does not.

- One exact owner: the name resolves to it, even when version or suffix
  siblings exist (`x-v2` and `x-v3`, or `hb-voice` and `hb-voice-v3`).
- Two or more exact owners: ambiguous. `resolvedScope` lists
  `ambiguousCandidates`, nothing is read, and a `checkpoint` is refused.
- No exact owner: a `-vN` or company-suffix variant is tried, through the
  search index. A missing version can therefore resolve to another version:
  with only `x-v3` stored, `x-v2` resolves to `x-v3`. Observation ownership
  (below) is stricter and runs one way only.
- If the entity records cannot be read, the name does not resolve.

What counts as a stored name: the record is read as JSON the way every
other reader reads it (if a key appears twice, the last one wins). `name`
counts only when it is a string; a non-string name (such as a number) owns
nothing. Aliases count only when `aliases` is a real JSON array, and only its
string elements. A name held by a private (`message_detail`) entity does not
resolve, and private names are never listed in `ambiguousCandidates`.

An entity record that is not a valid JSON object owns nothing, and any name
the search index still links to it does not resolve (it is not handed to
another entity) until the record is repaired. That includes the index's
derived forms of its names: a corrupt record that held `cb-x-v2` also blocks
`cb-x`, so an unrelated, healthy name can come back unresolved. A corrupt
record the index never linked blocks nothing, but it still owns nothing, so
a name it should hold may resolve to another entity. `/system/status`
reports how many such records exist as `databases.sqlite.invalidEntityRows`
(a count, never content; `null` if the count fails). Any non-zero value
needs repair, not just watching.

Each resume and checkpoint resolves and reads on one snapshot; checkpoint
resolves and writes in one IMMEDIATE transaction; nothing is cached across
calls. Within one call the exact-owner list is built once (one scan of the
tenant's entity records, roughly 15 to 20 ms with 3,000 entities and 35 to
45 ms with 8,000) and reused only until the call writes something; after
that, lookups read fresh. Owner lists are never kept from one call to the
next. `checkpoint` must not be called inside an open transaction: it refuses
rather than nesting. If another writer holds the database, it retries a few
times and then fails with a retryable error, having written nothing. Direct
SQL on a live server's connection, including TEMP or ATTACH tables that
shadow `shared_memory`, is unsupported.

Only observations whose `entityName` names the scope entity, and only that
entity, count. Names are compared case- and punctuation-insensitively:

- **Exact name.** If the name is the canonical name or a declared alias of
  any entity, it belongs to those entities only. It counts for the scope
  when the scope is the only such entity. A name that two entities share
  exactly counts for neither. Exact owners are read from the stored entity
  records, as for scope resolution above.
- **Variant**, only when no entity has the name exactly. The name counts when
  removing a trailing `-vN` from it, or adding or removing a company suffix
  (`-llc`, `-inc`, `-corp`, `-co`, `-company`), gives the scope's name or
  one of its aliases, gives no other entity's, and the exact entity
  resolver resolves the name to the scope alone. The rule runs one way only:
  `x-v3` never counts for `x-v2`, and `x` never counts for `x-v2`.
  The resolver uses the search index, so a variant of an alias the index
  dropped does not count: the observation is left out rather than guessed.

So for an entity `acme-llc`, observations under `Acme LLC` count, and those
under `acme` count only while no other entity (such as `acme-inc`) also has
`acme` as a variant. Decisions on other entities are not included, even when
their name extends the scope's (`scope-root-child` for `scope-root`) or
differs only by suffix or version (`x-v3` for `x-v2`), and their `supersedes`
cannot hide the scope's own decisions. Record decisions on the scope entity,
or find others with `search_entities`.

Ownership is decided when `resume` reads, against the entities that exist
then; observations do not record an entity id. Creating an entity or alias
can therefore move an observation from one scope to none: once `acme-inc`
exists, observations under `acme` no longer count for `acme-llc`.

The `capsule` block (`resultVersion` 2 or 3) uses the same ownership rule: a
sibling entity's `kind:"capsule"` observation is never the scope's
`capsule.current` or a conflict, and a sibling's `supersedes` cannot retire
the scope's capsule. `capsule.candidatesConsidered` counts only the scope
entity's own observations.

### Reading head conflicts

A scope can have more than one **live head**: a checkpoint written against a
stale `expectedRevision` becomes a branch instead of overwriting. Which head
is current is decided by the scope **pointer**, not by revision number, so a
branch can have a higher revision than the current head.

- In every bundle version, `asOf.stateId`/`asOf.revision` is the head
  shown as working state, when there is one (see below). When more than one
  head is live, `asOf.conflicts`
  lists **all** of them, that one included.
- `resultVersion:3` labels them. With a valid pointer, each item in `heads`
  has `role` `current` (the pointed head) or `divergent` (a branch retained
  from a stale parent, whatever its revision).
- Without a valid pointer, **no head is designated**: every head is
  `undesignated`, and `record`/`patch` conflict on every head until a
  reconcile designates one. (A plain write still branches as before.) The
  two cases differ in what `asOf` shows:
  - `asOf.selection` `max-revision` (a legacy scope that never had a
    pointer): `asOf.stateId`/`asOf.revision` fall back to the highest
    revision, shown as working state only. It is not known to be the
    lineage tip.
  - `asOf.selection` `invalid-designation` (the pointer names a snapshot
    that is not a live head): resume fails closed. `asOf.stateId` and
    `asOf.revision` are `null` and no working state is shown.
- `asOf.selectionReason` says, in fixed-size text, which head is designated,
  what the others are, and whether writes are blocked.
- `asOf.reconcileNeeded` is true **only when writes are blocked** (no valid
  pointer): run `checkpoint` with `operation:"reconcile"`
  (`resultVersion:3`).
- `asOf.cleanupAvailable` is true when a valid pointer coexists with other
  live heads. Nothing is blocked: keep writing against the current revision.
  A divergent head is never adopted automatically; reconciling it away is
  optional cleanup.

History and full message/handoff bodies are **resources**
(`engram://snapshot/…`, `engram://message/…`, `engram://handoff/…`),
deliberately not tools: bulk history stays off the tool surface and
payload hashes are verified on read.

### Heads, the pointer, and reconciliation (`resultVersion: 3`)

Branching alone answers "was anything lost?" (no) but not "which head is
current?". v3 makes that explicit:

- Every scope has a **current-head pointer**. The first write sets it; only a
  write whose parent *is* the pointed head advances it. A write from any other
  parent still branches, but it never becomes current by having a higher
  revision. `working` follows the pointer for every bundle version.
- **Reconcile** is the one operation that folds heads back together: it names
  the exact live-head set and the pointer (both compare-and-set), keeps one
  survivor, retires the rest (recorded, never deleted), and resolves divergent
  fact/loop values causally — strict by default, so nothing is dropped
  silently.
- Facts and loops are **versioned** per writing snapshot and change ordinal,
  hash-verified against the snapshot payload. The v3 `resume` promotes only
  values proven on the accepted lineage (each with provenance) and reports the
  rest as divergent or legacy under the same closed coverage accounting.
- **`record`** (changes without resending state) and **`patch`** (an RFC 7396
  merge patch) are admitted only on the pointed head, so a stale branch can
  never promote its state by logging one fact.

Walkthrough and request/response examples:
[CHECKPOINT-RESUME-V3.md](./CHECKPOINT-RESUME-V3.md).

### Reading tool results: use `structuredContent`

`resume` and `checkpoint` (and `begin_session` / `end_session`) return the
same result twice, as the MCP spec allows: a serialized JSON string in
`content[0].text` for older clients, and the parsed object in
`structuredContent`. They are identical. Read **one** of them, preferably
`structuredContent`; do not print the whole result envelope, or every bundle
appears twice. Clients that cannot see `structuredContent` should parse
`content[0].text`. If `content` has **more than one item**, the extra items
are notices that are not repeated in `structuredContent` as text, for example
the warning `resume` and `begin_session` add when the scope has divergent
heads (the data itself is in `asOf.conflicts` / `heads`). Read those too.

### Keeping agent listings small

`get_agent_status` with no arguments returns full registration rows and is
large on a busy server. To find someone, use `get_agent_status({resolve:
"<name>"})` (where a message to that name goes) or filter the listing with
`name` (a case-insensitive prefix) and `compact: true` (four fields per
row). The default response is unchanged.

Recipient lookups expose mailbox metadata: `resolve`, the single-agent
`recipient` block and `includeAddressable` report, for any address in the
tenant, all-time received/sent message counts and the last activity time
(never contents, senders or subjects). Any caller with the `agent:self` scope
can read them. This is an accepted trade-off for reliable recipient
discovery; tenants are isolated as everywhere else.

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

## Finding an entity by name: anchor vs identity

`search_entities(query, searchType:"exact")` is an exact-name **anchor**, not
an identity lookup. The lookup index also stores derived forms of every
entity name (the first two or three segments, initials, corporate suffixes),
so an exact search for `ascend-website` also returns `ascend-website-redesign`
and other rows that merely share the name's prefix or mention it in prose.

Every result carries `matchKind`. When the search is anchored on exact name
matches (any `searchType:"exact"` search, and a hybrid search whose query
equals a stored name), relevance order is `matchKind` first, then
`searchScore`. The broad hybrid/semantic fallback, used when nothing matches
the name, still labels each row but orders by `searchScore` alone.

| matchKind | Meaning |
|---|---|
| `exact` | The name (an observation's `entityName`; a relation's `from`/`to`) equals the trimmed query byte for byte. |
| `exact-ci` | Equal after case and separator normalization, or a declared alias equals the query (checked even when the name itself is only a prefix match). |
| `prefix` | The normalized name, or a declared alias, starts with the normalized query plus a separator. |
| `related` | Anything else: derived variants, handles in prose, semantic matches. |

For exact **identity**, keep only `matchKind` `exact` (or `exact-ci`), or pass
`canonicalEntityKey` (optionally with `memoryTypes:["entity"]`), which filters
to that one entity and its own observations and relations. `sortBy:"recency"`
replaces this ordering with newest-first.

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
