# Offline agent-credential operator

`hythe-agent-auth` creates and manages server-authoritative, per-agent
credentials in a HYTHE SQLite database. It is an offline administration tool,
not a server endpoint. It never treats registration, display labels, aliases,
or a shared tenant key as proof of an agent identity.

## Safety contract

Stop HYTHE and every other process that can open the database before using any
operator command. Every command sets SQLite's busy timeout to zero, requests
exclusive locking, and holds `BEGIN EXCLUSIVE` until its transaction commits.
If another connection holds a conflicting lock, the command refuses with
`DATABASE_NOT_OFFLINE`. The lock preflight is a final guard, not a substitute
for stopping the service: an idle WAL-mode connection may not hold a
conflicting transaction at the instant of the check.

The operator:

- uses exact, case-sensitive tenant and agent IDs;
- never deletes or renames a principal;
- creates a principal only when `issue` includes `--create-principal`;
- keeps an old credential active during rotation until a separate `revoke`;
- writes each new secret only to a caller-selected, previously nonexistent
  regular file at mode `0600`;
- writes the raw token plus one trailing newline, suitable for
  `HYTHE_AGENT_KEY_FILE`;
- never prints or stores the plaintext token outside that file, and never puts
  a token or token hash in its JSON audit output.

All successful commands emit one compact JSON audit record on stdout. Refusals
emit a secret-free JSON record on stderr and exit with status 2.

## Build or installed invocation

From a source checkout, build first and use either the npm script or compiled
entrypoint:

```bash
npm run build
npm run agent-auth:operator -- --help
node dist/agent-auth/operator.js --help
```

An installed package exposes the shorter `hythe-agent-auth` binary used below.

## First issuance

Creating a new staged principal is deliberate and atomic with its first
credential. Choose only the scopes the client lane requires:

```bash
hythe-agent-auth issue \
  --db /srv/hythe/data/engram.db \
  --tenant-id default \
  --agent-id codex-houston \
  --actor operator-1 \
  --scope agent:self \
  --scope memory:read \
  --scope memory:write \
  --scope message:read \
  --scope message:send \
  --scope state:read \
  --scope state:write \
  --secret-file /srv/hythe/credentials/codex-houston.key \
  --create-principal
```

Omit `--create-principal` when issuing another credential for an existing exact
principal. The operator refuses both an implicit new principal and an explicit
create for a principal that already exists. Optional `--not-before` and
`--expires-at` values must be ISO timestamps.

## Inspect and promote

Inspect output contains principal and credential metadata but no hashes or
secrets. `status` does not create migration 008 tables when they are absent.

```bash
hythe-agent-auth status \
  --db /srv/hythe/data/engram.db \
  --tenant-id default \
  --agent-id codex-houston

hythe-agent-auth promote \
  --db /srv/hythe/data/engram.db \
  --tenant-id default \
  --agent-id codex-houston \
  --actor operator-1 \
  --credential-id 0123456789abcdef01234567
```

Promotion changes only `staged` to `enforced`. Repeating promotion is an
unchanged success that preserves the original promotion audit fields. A
disabled principal cannot be promoted through this surface. First, the exact
principal and exact `--credential-id` selected for promotion must match. That
credential must be active, currently within its validity window, and have a
successful server-recorded `/agent/whoami` attestation in `mixed` or `required`
mode within the preceding 24 hours. An old overlapping rotation credential
cannot authorize promotion of an untested replacement. Generic token validation,
`last_used_at`, denied calls, and failed handlers never satisfy this gate. Run
the authenticated `/agent/whoami` canary with that credential before stopping
HYTHE for the promotion. A staged but unattested, observe-only, future,
expired, or fully revoked credential set fails closed as
`PRINCIPAL_NOT_CANARY_PROVEN`.

In server `required` mode there is no shared-key-only bypass for agent-facing
MCP, dashboard, operations, profile, graph, or data-management surfaces.
Operator automation must use a deliberately issued operator principal with the
minimum explicit scopes it needs (for example `memory:admin`, `ops:read`,
`ops:write`, `audit:read`, or `data:admin`) in addition to its base credential.

## Rotate and revoke

Rotation creates a new credential and records it as the old credential's
replacement. It deliberately leaves both active so each individual client lane
can be restarted and verified before the old key is revoked.

```bash
hythe-agent-auth rotate \
  --db /srv/hythe/data/engram.db \
  --tenant-id default \
  --agent-id codex-houston \
  --actor operator-1 \
  --credential-id 0123456789abcdef01234567 \
  --secret-file /srv/hythe/credentials/codex-houston.next.key

hythe-agent-auth revoke \
  --db /srv/hythe/data/engram.db \
  --tenant-id default \
  --agent-id codex-houston \
  --actor operator-1 \
  --credential-id 0123456789abcdef01234567
```

When rotation omits `--scope`, the replacement inherits the old credential's
scopes. Supplying one or more `--scope` values replaces that set. A credential
that already names a replacement cannot be rotated again, and revocation is
limited to an active credential belonging to the exact tenant/agent pair.
Revoking the last active credential intentionally locks out that lane. Before
doing so, use `status` to confirm a canary-proven replacement is active, keep its
restricted file available to the lane, and retain a database rollback artifact.

## Operational sequence

For each logical agent lane:

1. Stop HYTHE and all database users.
2. Back up and verify the database using the production migration runbook.
3. Issue the staged principal and credential to a new restricted file.
4. Configure only that agent lane with `HYTHE_AGENT_KEY_FILE` and its matching
   exact agent ID.
5. Start HYTHE in the planned rollout mode and run the identity canary.
6. Stop it again before `promote`, `rotate`, or `revoke` changes.
7. During rotation, restart and verify the lane on the new file before revoking
   the old credential.

Do not pass a secret on the command line, through an environment variable, in a
URL, or in an audit/logging pipeline. The only supported delivery artifact from
this operator is the create-only restricted file.
