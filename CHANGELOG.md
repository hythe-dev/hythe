# Changelog

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
