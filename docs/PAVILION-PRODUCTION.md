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

## SQLite journal mode (WAL)

The server runs its database in WAL mode with `synchronous = FULL` (issue
#39). It switches the file to WAL at every start; while it runs, every other
connection (CLI tools included) uses WAL too. On a graceful stop it
checkpoints the WAL and switches the file back to the rollback journal, so a
stopped database is one self-contained file, as offline tools (migrations,
sanitation) and file copies expect. That switch needs every other connection
to the database closed; see below. Server snapshots are always single-file
rollback-journal databases.

- While the server runs, the database is three files: `engram.db`,
  `engram.db-wal` and `engram.db-shm`. Never copy `engram.db` alone from a
  running server. Back up with the server's own snapshots, or with the SQLite
  backup API (`sqlite3 engram.db ".backup <target>"`). A `.backup` copy keeps
  the WAL mode of the source, so before offline tools use the copy, run
  `PRAGMA journal_mode=DELETE;` on it once.
- The file can be left in WAL, with the sidecars, in three cases: a crash, a
  forced stop (`SIGKILL`), or a graceful stop while another connection (a
  CLI session, a backup, another tool) still had the database open; the
  server then logs a warning at close. Before offline work, close every other
  connection, open the file once with no server running, run
  `PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;`, and confirm
  the `-wal` and `-shm` files are gone (the sanitation tool refuses to run
  while either is non-empty).
- Restoring a server snapshot needs the database to itself: no other
  connection may be open, idle or mid-read. The server checkpoints the WAL,
  leaves WAL mode (which SQLite allows only when no other connection has the
  file open) and takes an exclusive lock; if any step fails it refuses at
  once, keeps its data and its journal mode, and removes the pre-restore
  snapshot it had just made. After the swap the server reopens the file in
  WAL; if that fails, the restore reports an error (the restored data is
  served, in rollback-journal mode, until a restart). With the
  `HYTHE_SQLITE_JOURNAL_MODE=delete` opt-out, a connection that is open but
  idle holds no lock and cannot be detected: close other tools before a
  restore.
- WAL is not safe on network filesystems (NFS, SMB). The data directory must
  be a local filesystem (Pavilion binds a local host directory). For a
  network mount, set `HYTHE_SQLITE_JOURNAL_MODE=delete`; `wal` (the default)
  and `delete` are the only accepted values. If the opt-out cannot be applied
  at start (another connection holds the file in WAL), the server refuses to
  start rather than run in WAL.

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
