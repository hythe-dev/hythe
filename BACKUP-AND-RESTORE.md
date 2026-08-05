# Backup and restore

Engram's single source of truth is one SQLite database file. With the
documented configuration this is `./data/engram.db` locally
(`NEURAL_DB_PATH=./data/engram.db`) and `/app/data/engram.db` inside the
compose container (on the `engram_data` volume; compose sets
`NEURAL_DB_PATH=/app/data/engram.db`).

## Backup (online, consistent)

```bash
sqlite3 data/engram.db ".backup 'backups/engram-$(date -u +%Y%m%dT%H%M%SZ).db'"
sqlite3 backups/engram-<stamp>.db "PRAGMA integrity_check;"   # expect: ok
```

Under docker compose, run the same command inside the container or against a
bind-mounted data directory. Always verify `integrity_check` before trusting
a backup, and take a fresh backup before any migration or compaction.

## Restore

Stop the server, replace `data/engram.db` with the backup file, start the
server, and verify `GET /health` plus a read query before resuming writes.
