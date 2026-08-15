# Pavilion production deployment

`docker/pavilion-production.compose.yml` records the production runtime contract
without storing credentials in Git. It pins the service to UID/GID `1000:1000`,
MCP port `6174`, WebSocket port `3004`, the existing Pavilion data directory,
an offline read-only model cache, and `unless-stopped` restart behavior.
It also pins `HYTHE_AGENT_AUTH_MODE=observe`: this is compatibility telemetry,
not identity enforcement. A reviewed credential rollout must move the manifest
to `mixed`, canary and promote each exact principal, then move it to
`required`; skipping directly to `required` can lock out unprovisioned lanes.

## Preconditions

- Stop every writer before database maintenance or container replacement.
- Checkpoint and verify the SQLite database, then create a mode-0600 backup.
- Build, test, and transfer the image from the reviewed merge commit.
- Load the image on Pavilion and record its image ID and archive checksum.
- Keep `API_KEY` only in the mode-0600 host file referenced by the manifest.
- Keep each per-agent `hya1` token in its own mode-0400/0600 client file; never
  place an agent token in the server environment, Compose file, command line,
  URL, or HYTHE message/state.
- Set `HYTHE_IMAGE` to the reviewed immutable image reference. Prefer a digest;
  a release tag is acceptable only when its locally verified image ID is also
  recorded in the cutover log.

## Validate the rendered deployment

Run this on Pavilion before a cutover:

```sh
HYTHE_IMAGE='hythe@sha256:<reviewed-digest>' \
  docker compose -f docker/pavilion-production.compose.yml config --quiet
```

Inspect the rendered configuration without printing the protected environment
file. Confirm the two bind sources exist, have the expected ownership, and that
the stopped rollback container has been renamed before creating `engram-v1`.

## Acceptance and rollback gate

The container healthcheck calls `/ready` and succeeds only for HTTP 200 with
both `ready: true` and `degraded: false`. A liveness-only `/health` response is
not sufficient to promote the deployment.

After startup, require zero restarts, authenticated MCP discovery, authenticated
WebSocket operation, unauthenticated rejection on both transports, and SQLite
`quick_check` plus `integrity_check`. Keep the previous image, stopped container,
and verified backup through the soak window. If any gate fails, stop the new
container and restore the entire verified database backup before starting the
rollback container; never merge rows manually.

For each identity-enforcement phase, require `/agent/whoami` to attest the
exact case-sensitive agent ID and an authorization mode at least as strict as
the client configuration. A `required` client intentionally refuses an
`observe` or `mixed` server before forwarding its first MCP request.

Graceful shutdown is a release gate: `docker stop --time 20 engram-v1` must
complete without Docker sending `SIGKILL`, and the container must report exit
code 0.
