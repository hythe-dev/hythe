# Private message residue migration

Migration 007 restores oversized direct-message bodies from historical shared
`message_detail` entities into `ai_messages`, then removes only the legacy
shared/search copies it can account for without ambiguity.

This is an offline migration. Stop every process that can write the database
before running it, and keep the generated backup and JSON report until the
mailbox canaries have passed.

## Safety model

The script defaults to a read-only dry run. It refuses execution when any of
these conditions is present:

- a message pointer is malformed, missing its payload, or resolves to multiple
  payload entities;
- a `message_detail` entity is orphaned or belongs to another tenant, or an
  entity uses a reserved `msg-detail-*` canonical name/alias despite a damaged
  or rewritten discriminator;
- an entity or observation row has invalid JSON or a non-object payload, so it
  cannot be safely classified as public;
- a pointer, observation, or relation reference collides with a public
  entity's canonical name or alias in the same tenant, including punctuation
  and company-suffix variants recognized by normal runtime lookup;
- a materialized observation referring to a `message_detail` parent by ID,
  canonical name, or alias is orphaned, ambiguous, or disagrees with that
  parent reference;
- an observation has an unresolved explicit parent ID, or its unresolved
  non-prefixed parent name has historical materialization provenance or an
  oversized payload, or those private-shape clues remain after every parent
  reference was lost. These private-shaped orphans are intentionally false-
  positive-safe: a data owner must classify them before execution;
- a relation references a private parent ambiguously, or references an orphaned
  name in the reserved `msg-detail-*` namespace;
- a legacy shared message or message vector does not map to exactly one
  tenant-matched `ai_messages` row through its explicit migration provenance,
  or its sender, recipient, and content no longer match that row;
- a vector row is missing, shared by another record, cannot be loaded, contains
  a malformed graph payload, or is private-shaped without a uniquely resolved
  public parent or uniquely accounted shared/message parent;
- the database changes between preflight and the locked transaction.

Execution requires the exact confirmation token produced by dry-run, a new
backup path, and a new report path. The backup is created with SQLite's backup
API and must pass `quick_check` and the same logical preflight fingerprint.
Restoration, child-observation and index cleanup, deletion, verification, and
the database audit row then happen in one transaction. Any failure before
commit rolls everything back; the external report records the refusal or
rollback without message bodies.

## Operator procedure

Use the built artifact shipped in the npm package. In a source checkout, run
`npm run build` first. Set `SQLITE_VEC_TABLE` and
`SQLITE_VEC_INDEX_TABLE` to the exact values used by the stopped server when
they differ from `shared_memory_vec` and `neural_vec_index`; unsafe SQLite
identifiers are rejected rather than silently replaced.

First run the script against a copy of the production database:

```bash
node dist/migrations/007-private-message-residue.mjs /path/to/memory-copy.db \
  --report /secure/path/message-residue-dry-run.json
```

Review `issues` and `counts` in the JSON. Do not execute while `status` is
`refused`. Orphans and ambiguities require an explicit data-owner decision;
the migration never guesses, quarantines by deletion, or silently skips them.

After the copy succeeds and the real server is stopped, repeat dry-run against
the real database. Use its newly generated confirmation token:

```bash
node dist/migrations/007-private-message-residue.mjs /path/to/memory.db \
  --execute \
  --confirm RESTORE-PRIVATE-MESSAGES-XXXXXXXXXXXXXXXX \
  --backup /secure/path/memory-before-message-residue.db \
  --report /secure/path/message-residue-execute.json
```

Success is `status: "applied"`, `quickCheck: "ok"`, and an `applied` count
matching the reviewed dry run. The script also writes a row to
`private_message_residue_migration_audit` containing only the run identifier,
preflight fingerprint, artifact paths, and counts.

The confirmation fingerprint binds the configured vector table names, the
resolved message/vector provenance, sender fallbacks, and every selected row.
SQLite object discovery follows SQLite's case-insensitive identifier rules. A
`pending` report is written before mutation and the final report replaces it
atomically. If the database commits but the final replacement fails, stdout
reports `applied-report-write-failed`, the pending file remains intact, and the
database audit row is the reconciliation record.

Before restarting normal traffic, verify representative mailboxes using
`get_message_detail`, verify an unrelated agent and tenant cannot read them,
and verify private phrases do not appear in entity or semantic search. If a
rollback is needed after commit, stop the server and restore the generated
backup as a whole; do not merge selected shared rows back into the migrated
database.

## Development test

```bash
npm run test:migrations
```

The fixtures cover dry-run immutability, clean restoration, runtime-equivalent
canonical/ID/alias collision refusal, corrupt reserved entities, malformed
entity/observation refusal, child-observation and relation cleanup, malformed
graph-vector and private-shaped orphan/vector-only residue refusal,
public-parent preservation, tenant isolation, configured vector-table cleanup (including
identifier casing) and unsafe-name rejection, fingerprint provenance,
transaction rollback, backup verification, and idempotent re-execution.
