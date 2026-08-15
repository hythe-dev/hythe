# Changelog

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
