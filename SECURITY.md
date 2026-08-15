# Security

## 0.1.5 dual-proof agent authorization

HYTHE separates two proofs. The existing deployment API key or tenant
credential authenticates the outer deployment/tenant boundary. A distinct
`hya1` credential authenticates one exact, case-sensitive agent principal.
Effective authority is the intersection of the base credential and the
per-agent scopes; presenting an invalid, expired, revoked, disabled, or
mismatched agent proof fails closed and never falls back to base-key identity.

Rollout is explicit:

- `observe` preserves legacy callers while operators inventory them;
- `mixed` accepts unclaimed legacy lanes but reserves every enforced or
  disabled principal for valid per-agent proof; and
- `required` requires agent proof for state-bearing agent operations and
  scoped MCP, dashboard, operations, profile, graph, data, and resource
  surfaces. There is no shared-key-only downgrade for those operations.

Credentials are issued offline. Clients receive only a path in
`HYTHE_AGENT_KEY_FILE`; the referenced file must be a regular non-symlink,
owned by the client user, mode `0400` or `0600`, and contain exactly one token.
Raw agent tokens are rejected in environment variables, URLs, config output,
logs, and HYTHE data. A client attests the database-derived identity and server
mode at `/agent/whoami` before it consumes MCP stdin. Promotion is tied to the
exact credential's fresh successful mixed/required attestation, not generic
token use. WebSocket connections revalidate both the base and agent credential
before activity and delivery, so revocation, expiry, or principal disablement
ends future delivery.

This does not make every datum private to one agent. Exact direct-message
mailboxes and recipient-bound message resources enforce agent isolation; the
knowledge graph remains tenant-shared by design unless a separate policy says
otherwise. Health/readiness and protocol discovery are operational surfaces,
not claims of an agent identity. Keep the base credential secret, keep network
exposure narrow, issue least-privilege agent scopes, and use an explicitly
scoped operator principal for administration in required mode.

## 0.1.4 identity and private-message containment

The 0.1.4 release candidate removes implicit bridge identity defaults, binds
client-lane actions to an explicit exact identity, stops alias-family mailbox
authorization, and prevents historical private message payloads from being
returned through shared graph/search/export and request-log paths. An offline,
dry-run-first migration is included for historical residue; operators must not
execute it while unresolved or ambiguous rows are reported.

In the 0.1.4 candidate, the shared API key remained only a deployment/tenant
credential and the bridge checks were defense in depth. Version 0.1.5 adds the
server-authoritative per-agent proof and rollout modes described above.

## 0.1.2 credential-output issue

Version `0.1.2` could print a generated API-key value during
`init --write-env` and include that value in generated client configuration
snippets. Those values may have been retained in terminal, CI, or agent logs.

The issue is fixed in `0.1.3`. Users who ran the affected command on `0.1.2`
should treat the generated key as potentially exposed, rotate it through their
normal server/client cutover procedure, and upgrade to `0.1.3`.

Do not include credential values in bug reports. Report security issues through
the repository's private security-reporting channel.
