# Backup and restore

HYTHE's logical source of truth is one SQLite database. With the documented
configuration its main path is `./data/engram.db` locally
(`NEURAL_DB_PATH=./data/engram.db`) and `/app/data/engram.db` inside the
compose container (on the `engram_data` volume; compose sets
`NEURAL_DB_PATH=/app/data/engram.db`). While SQLite is running, `engram.db-wal`,
`engram.db-shm`, or a rollback journal can be part of the current state. Never
copy only the main file from a live WAL database.

## Backup (online, consistent)

```bash
sqlite3 data/engram.db ".backup 'backups/engram-$(date -u +%Y%m%dT%H%M%SZ).db'"
sqlite3 backups/engram-<stamp>.db "PRAGMA integrity_check;"   # expect: ok
```

Under docker compose, run the same command inside the container or against a
bind-mounted data directory. Always verify `integrity_check` before trusting
a backup, and take a fresh backup before any migration or compaction. For
offline maintenance, stop every writer first, allow SQLite handles to close,
and require absent or zero-length `-wal`, `-shm`, and `-journal` sidecars before
using a byte-for-byte source snapshot.

Also verify the backup as its own database:

```bash
sqlite3 backups/engram-<stamp>.db "PRAGMA quick_check; PRAGMA integrity_check; PRAGMA foreign_key_check;"
```

Expect `ok` from the first two and no rows from `foreign_key_check`. Keep the
backup owner-only (mode `0600`) and record its SHA-256 digest outside the live
database.

## Restore

Stop the server and every other SQLite user. Verify the selected backup again,
copy it to a new mode-`0600` sibling on the same filesystem, fsync that file,
and atomically rename it into the configured database path without overwriting
an unexpected file. Remove stale `-wal`, `-shm`, and `-journal` files only while
all users are stopped and only after the replacement main file is durably in
place; otherwise old pages can be replayed into the restored database. Preserve
the original database and its sidecars as a restricted rollback set until the
restore is accepted.

Start HYTHE, require HTTP 200 from `/ready` with `ready:true` and
`degraded:false`, then run authenticated MCP discovery, a read-only exact
mailbox/state canary, `quick_check`, `integrity_check`, and
`foreign_key_check` before resuming writes. For historical private-message
cleanup, use the dedicated [adjudication](docs/PRIVATE-MESSAGE-RESIDUE-ADJUDICATION.md)
and [physical sanitation](docs/SQLITE-PHYSICAL-SANITATION.md) tools; a normal
restore does not prove deleted pages are physically absent.
