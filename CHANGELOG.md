# Changelog

## Unreleased

- ENG-4 H5 (design §5, final internal increment of `resultVersion: 3`): checkpoint
  gains `operation: 'record'` (fact/loop changes without resending state) and
  `operation: 'patch'` (an RFC 7396 merge patch on the working state; arrays
  replace wholesale; the result must be a complete valid state or the call fails
  closed). Both forbid `state` in the request, admit ONLY the pointed head as
  parent (`conflict` carrying heads and pointer otherwise — never a branch),
  take the parent state from its hash-verified payload, and advance the pointer.
  Fingerprints bind the operation, the resolved parent and (for patch) the raw
  patch. `resume`/`checkpoint` now share a per-call verification memo: every
  consumer of persisted envelope bytes reads through one verified reader, so
  each payload is selected, hashed and parsed exactly once per call (nothing
  cached across calls). A v3 `write` binds `acknowledgeRetired: true` into its
  fingerprint (a retry that drops the acknowledgment is an idempotency-mismatch,
  not a replay); v1/v2 fingerprints are byte-identical. record/patch on an
  empty scope fail closed with `CheckpointEmptyScopeError` (design §5.1
  amended). The exact v3 request/result/bundle schema is now final;
  publishing/deploying v3 remains a separate owner decision.
- ENG-4 H4 (design §6.3–§6.5, internal increment of `resultVersion: 3`): the v3
  read model. `resume` `resultVersion: 3` now selects `currentFacts`/`openLoops`
  ONLY from verified materialized versions on the accepted lineage (newest per
  id by revision/ordinal within the lineage; every item carries `provenance`),
  suppresses ids without a proven accepted version (accounted as
  `omittedReason: 'unversioned'`, or `'undesignated'` for a scope without an
  accepted lineage) into the non-authoritative `legacyValues` section, and lists
  every materialized divergent terminal value in `divergentValues` with its
  lineage head, provenance, `isV1CurrentValue` and `resolved` flag. A loop close
  written off the lineage leaves the loop open in v3. Before selection, v3
  resume verifies the version foundation and every reconcile's rows in both
  directions (retirement attribution and payload-recorded retirements/merge
  inputs scope-wide) and fails closed. v1/v2 bundles are unchanged. Also: the
  divergence-resolution key now includes the resolving snapshot, and retirement
  rows bind actor/time/reason to their reconcile.
- ENG-4 H3 (design §4, §6.3, internal increment of `resultVersion: 3`): checkpoint
  gains `operation: 'reconcile'` — names the exact live-head set and the pointer
  (both compare-and-set; a mismatch is `conflict` carrying heads and pointer),
  chooses a survivor as parent, retires every other head (recorded in
  `eng4_head_retirements` and `eng4_snapshot_merge_inputs`, never deleted), sets
  the pointer to itself, and resolves every divergent fact/loop terminal value
  causally: strict by default (unresolved materialized terminals refuse the
  call), `accept` bound to a same-request change with an equal value, `reject`
  or `rejectLineages` otherwise; opaque (unversioned) terminals can only be
  rejected. The normalized reconciliation record is bound into the snapshot's
  payload; idempotent replay and `resume` `resultVersion: 3` verify the
  merge-input/retirement/resolution rows against it and fail closed on any
  difference. Live heads exclude retired snapshots; a write extending a retired
  head is live but never current (`heads[].parentRetired: true`) and under v3
  requires `acknowledgeRetired: true`. v1/v2 request and result shapes are
  unchanged; H-series fields fail validation there.
- ENG-4 H2 (design §6.2, internal increment, data-only): append-only
  `eng4_fact_versions` / `eng4_loop_versions` keyed by (writing snapshot, change
  ordinal) with same-scope composite FKs, plus the `eng4_version_coverage`
  manifest giving every digest-bound ledger tuple exactly one explicit
  disposition (`materialized` | `unversioned`, with `source` write|backfill).
  Every checkpoint now dual-writes exact versions in its transaction; the
  schema apply performs a verified, all-or-nothing, idempotent backfill of every
  ledger-bound snapshot from immutable data only (a historical loop update that
  omitted `owner` whose inherited value cannot be proven becomes `unversioned`
  with reason `pre-h2-inherited-owner`, never a guess), and refuses a store
  whose null-digest snapshots carry ledger/coverage/version rows. A
  bidirectional parity verifier (`verifyVersionParity`) fails closed on any
  missing, extra or mismatched row. No public read model changes (H4 reads
  these rows); v1/v2/v3 bundles are unchanged.
- ENG-4 H1 (design `docs/design/ENG4-HEAD-RECONCILIATION.md` §3, internal
  increment): checkpoint now maintains an explicit per-scope current-head
  POINTER (`eng4_scope_current`) — set by the first write in a scope and
  advanced only by a write whose parent is the pointed head; a write from any
  other parent still branches (frozen CAS) but is no longer promoted to
  "current" by having the higher revision. `resume` selects `working` through
  this one resolver for every bundle version (legacy scopes without a pointer
  keep the explicitly flagged max-revision selection until reconciled; a
  pointer at a non-live snapshot fails closed with `working: null`). Snapshot
  rows are now immutable and undeletable by trigger, except PR #8's single
  digest write. `resume` `resultVersion: 3` (schemaVersion 3, NOT final until
  the H-series completes and NOT published) adds `asOf.selection/pointer/
  liveHeadCount/divergentHeadCount/retiredHeadCount` and a budgeted `heads`
  section. v1/v2 shapes, fingerprints and the checkpoint request are unchanged.
- Honor latency SLO time windows with timestamped samples, statistically meaningful
  percentile sample floors, current-evaluation alert metadata, and automatic stale
  alert recovery instead of retaining up to 1,000 lifetime samples.

## 0.1.7 - 2026-08-14

- Add the hash-bound `quarantine_backing_observation` adjudication disposition
  for an unresolved private-shaped vector with exactly one proven observation
  backing row and one uniquely owned vec0 row. The operator must copy the exact
  target evidence from inventory; ambiguous, stale, cross-tenant, conflicting,
  or multiply owned rows remain refused.
- Validate raw target keys before normalization so unknown nested manifest
  fields cannot be silently discarded before fail-closed planning.

## 0.1.6 - 2026-08-14

- Add `discover_related_context`, a tenant-scoped, `memory:read`-authorized,
  read-only tool that exact-resolves a project/task name or registered alias
  before retrieval, combines bounded vector candidates with one/two-hop graph
  paths, reports score/currentness/evidence/provenance plus explicit degradation
  and coverage under a hard response budget, and performs no writes.
- Fix latency-SLO recovery by resolving the same severity-keyed p95 warning and
  p99 critical records created by the monitor, so a recovered p99 window clears
  the critical alert and `/ready` can return from degraded HTTP 207 to healthy
  HTTP 200.

## 0.1.5 - 2026-08-14

- Add dual-proof authentication: the existing deployment or tenant credential
  establishes the outer trust boundary, while an independently stored `hya1`
  credential binds the exact case-sensitive agent principal and its scopes.
- Add `observe`, `mixed`, and `required` rollout modes. Invalid presented proof
  never falls back; enforced/disabled principals cannot be reclaimed through a
  shared key; required mode rejects omitted agent proof on state-bearing agent
  and scoped operator surfaces.
- Require clients with per-agent proof to read it from a protected regular
  non-symlink file, attest `/agent/whoami` before consuming stdin, and bind the
  exact identity and both credentials to HTTP and WebSocket requests.
- Add an offline credential operator for exact principal issuance, fresh
  credential-specific canary promotion, rotation, revocation, and secret-free
  audit output.
- Revalidate both base and agent credentials throughout WebSocket lifetimes,
  and require an exact tenant on every notification event.
- Add graceful HTTP/WebSocket/metrics shutdown, strict readiness, package-derived
  runtime versions, and a Pavilion production manifest pinned to the actual
  UID, ports, data path, offline model cache, and rollback contract.
- Add hash-bound owner adjudication for ambiguous historical private-message
  residue and an offline sanitation tool that refuses retained custody, proves
  logical/vector equality and SQLite integrity, requires empty sidecars, and
  publishes a mode-0600 VACUUM output without clobbering another file.
- Harden migration artifacts and reports against source-sidecar aliases,
  pathname/inode drift, stale confirmation tokens, backup loss, and publication
  races. The tools remain dry-run/plan-first and are never run at startup.
- Keep the npm consumer audit-clean without silently changing populated vector
  indexes: npm installs use deterministic 384-dimensional hash embeddings when
  the optional peer is absent; Docker uses a separately locked q8 runtime and
  fails startup if its transformer preflight fails.

## 0.1.4 (release candidate)

- Require an explicit, validated `HYTHE_AGENT_ID` for HYTHE client bridges and
  generated client configurations; missing or conflicting identity inputs fail
  closed instead of selecting a named or host-wide default.
- Bind acting `agentId` and message sender fields to the bridge's immutable
  client-lane identity, with local mismatch rejection before an HTTP request is
  sent.
- Serve ENG4 resource discovery and reads on the HTTP `/mcp` path used by the
  packaged stdio bridge; message handles bind scope, exact recipient, and row.
- Make client lifecycle guidance fail closed when an exact identity is not
  model-visible. Claude hooks require the same launch-time identity as the
  bridge, and generic Codex instructions never infer a post-compaction role.
- Treat agent handles as exact, case-sensitive, tenant-scoped mailbox
  principals. Display names, metadata aliases, historical identity changes,
  and transport-looking suffixes no longer merge inboxes or ENG4 ownership.
- Keep direct-message bodies in `ai_messages` only. Generic graph/search/export
  reads filter historical `message_detail` entities and their materialized
  observations, while generic graph writes reject the reserved representation.
- Add a dry-run-first, fail-closed offline migration for restoring historical
  oversized message bodies and removing uniquely accounted shared/vector
  residue. It is never run automatically during server startup.
- Redact MCP request bodies, message contents, and semantic search terms from
  runtime logs and unified event payloads.
- Keep the published package dependency tree audit-clean by making the
  transformer engine an optional peer. Non-Docker installs use deterministic
  token-hash embeddings when it is absent; the Docker image installs Xenova in
  an independently locked, override-audited runtime and q8-preflights it before
  serving so a populated transformer index never silently changes providers.
- Disable `set_agent_identity` while exact-principal migration is in progress.

The existing API key still authenticates the deployment/tenant boundary, not a
cryptographic per-agent principal. Direct raw HTTP/WebSocket callers holding
that credential remain inside the operator trust boundary; per-agent server
credentials are planned separately.

## 0.1.3

- Prevent `init --write-env` from printing generated API-key values or embedding
  them in generated client configuration snippets.
- Generated configurations now reference the protected key file instead of
  containing the key value.
- Users who ran `init --write-env` with `0.1.2` should treat the generated key
  as potentially exposed and generate a replacement according to their
  deployment's key-rotation procedure.
