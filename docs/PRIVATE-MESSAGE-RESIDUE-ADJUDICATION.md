# Private message residue adjudication

`private-message-residue-adjudication.mjs` is an offline companion to
migration 007. It turns every migration refusal into body-free, row-level
evidence and requires a data owner to assign one explicit disposition to every
finding. It does not change migration 007 and never makes an ownership guess.

The database server and every other writer must be stopped for execution.
Inventory and plan modes open the source database read-only.

## Three modes

Build the source tree before using the `dist` command:

```bash
npm run build
```

Inventory is the default. Always run it first against a protected copy:

```bash
node dist/migrations/private-message-residue-adjudication.mjs \
  /path/to/memory-copy.db \
  --report /secure/new-path/adjudication-inventory.json
```

The inventory contains no message or observation bodies. For every migration
007 issue it records:

- the exact tenant, table, and row ID;
- a SHA-256 hash of the complete row and a separate content hash;
- hashed parent declarations and exact candidate-parent row evidence;
- the vector-index row, vec0 row hash, every vec0 owner, and backing-row
  topology;
- every exact `graph_lookup_keys`, `entity_lookup_identity_links`, and
  `entity_context_facets` row that would be removed;
- a finding-specific evidence hash;
- a manifest template with a blank disposition.

Copy `manifestTemplate` to a separate mode-0600 JSON file. Set one disposition
for every decision. Do not remove or add findings and do not alter any evidence
field. Targeted mailbox dispositions must add an exact target object:

```json
{
  "schemaVersion": 2,
  "inventoryFingerprint": "<64 hex characters>",
  "approval": {
    "reviewer": "data-owner@example.invalid",
    "rationale": "Reviewed every hash-bound disposition.",
    "approvedAt": "2026-08-14T00:00:00.000Z",
    "reference": "approval://change/1234",
    "signatureHash": "<64 lowercase hex characters>"
  },
  "decisions": [
    {
      "findingId": "PMRA-<24 hex characters>",
      "locator": {
        "table": "shared_memory",
        "tenantId": "default",
        "id": "<row id>"
      },
      "rowHash": "<64 hex characters>",
      "contentHash": "<64 hex characters>",
      "evidenceHash": "<64 hex characters>",
      "disposition": "restore_mailbox",
      "target": {
        "table": "ai_messages",
        "tenantId": "default",
        "id": "<message id>",
        "rowHash": "<64 hex characters>",
        "contentHash": "<64 hex characters>"
      }
    }
  ]
}
```

Candidate target descriptors appear in `parentTopology`. The operator must not
invent a target or compute evidence from a different database snapshot.

All five approval fields are required and are hash-bound into the plan and
confirmation token. `signatureHash` is only a SHA-256 commitment/reference to
an approval artifact verified outside this tool. This version does not verify a
digital signature, signer identity, certificate, or trust root, so the field is
audit metadata—not cryptographic authorization. Preserve the referenced
approval artifact with the manifest and have the data owner verify it through
the organization's separate approval system.

Validate the completed manifest without writing the database:

```bash
node dist/migrations/private-message-residue-adjudication.mjs \
  /path/to/memory-copy.db \
  --mode plan \
  --manifest /secure/path/adjudication-manifest.json \
  --report /secure/new-path/adjudication-plan.json
```

A usable plan has `status: "ready"`, `plan.ready: true`, zero plan errors, and
an `ADJUDICATE-PRIVATE-RESIDUE-*` confirmation token. The token binds the full
inventory, normalized manifest, and approval metadata. The inventory binds the
database's canonical real path, device, inode, byte size, nanosecond mtime, and
a full logical digest that includes schema plus implicit rowid-to-payload
bindings. Missing, extra, duplicate, changed, or stale decisions are refused.
An execute attempt with the wrong token does not echo a usable token.

Execute only after the copy rehearsal succeeds and the live database is
stopped. Regenerate inventory and plan against the stopped live database; do
not reuse a token from the copy:

```bash
node dist/migrations/private-message-residue-adjudication.mjs \
  /path/to/memory.db \
  --mode execute \
  --manifest /secure/path/live-adjudication-manifest.json \
  --confirm ADJUDICATE-PRIVATE-RESIDUE-XXXXXXXXXXXXXXXXXXXX \
  --backup /secure/new-path/memory-before-adjudication.db \
  --report /secure/new-path/adjudication-execute.json
```

Both output paths must be new, mutually non-aliasing, and distinct from the
source database. Neither may use the source's reserved `-journal`, `-wal`, or
`-shm` pathname, including through a symlinked parent. The report is opened
exclusively and its file descriptor remains owned for the run; replacing its
pathname aborts before commit and never overwrites the replacement. The tool
creates a unique mode-0600 sibling backup, using the same SQLite connection,
before it acquires the write lock. It verifies `quick_check`, full
`integrity_check`, foreign keys, the full logical/content fingerprints, file
size, and SHA-256, then fsyncs the staged backup. It next acquires
`BEGIN IMMEDIATE` and recomputes path identity, SQLite `data_version`, inventory,
manifest parity, target evidence, vector ownership, and exact ancillary rows.
Only an exact match permits atomic same-directory, no-clobber publication of
the verified backup. Its canonical path, device, inode, byte count, and SHA-256
are bound into the report and audit row and rechecked immediately before
commit, immediately after commit, and immediately before final applied
reporting and return. Every action and its audit insertion then runs in that
one transaction. Any action failure rolls the database transaction back; a
successfully published verified backup is retained. If that backup is missing
or replaced only after commit, the result is
`committed-backup-verification-failed`, never `applied`, and an independent
replacement is preserved. Success additionally requires migration 007
analysis to become `ready: true` and post-write quick, integrity, and
foreign-key checks to pass. Migration 007 itself is not executed.

## Dispositions

| Disposition | First-version behavior | Mechanical proof required |
|---|---|---|
| `quarantine` | Copies the exact `shared_memory` row into the dedicated quarantine table, removes its shared lookup/vector derivatives, then removes the source row. | Exact row/content/evidence hashes; no inbound message pointer. |
| `restore_mailbox` | Restores the one body from an orphan `message_detail` row to a selected `ai_messages` row, then removes the shared detail and derivatives. | Same tenant; canonical name exactly `msg-detail-<message-id>`; exact sender and embedded creator parity; exact target row evidence; target already contains either that exact body or an exact pointer to that detail row. It never overwrites an unrelated body. |
| `private_duplicate` | Removes a legacy shared `ai_message` duplicate and its derivatives. | Exact tenant, sender, recipient, and body equality with the selected mailbox row; exact source and target evidence. |
| `stale_vector_remove` | Removes an unrepresented vector-index row and its uniquely accounted vec0 row. | No live backing row, or every backing shared row is removed by the same plan; every vec0 owner is scheduled for removal. |
| `public_relink` | Refused in this version. | A graph-lookup rebuild implementation and vector re-embedding are required before this can be automated safely. |
| `archive_then_remove_private` | Refused in this version. | A cryptographic archive adapter must prove that the exact plaintext row commitment is present in encrypted, access-controlled custody. |
| `public_vector_rebuild` | Refused in this version. | A pinned offline embedding model/runtime and exact post-rebuild vector verification are required. |

The recognized-but-unimplemented dispositions fail with
`manual_adapter_required`. They are never silently treated as quarantine or
deletion.

## Quarantine is not physical erasure

The quarantine table is intentionally outside every served graph, search,
resource, and mailbox path, but it remains inside the SQLite database and
contains the preserved original row. Its `row_json` column can contain private
material. Protect the database and backup as sensitive data.

Quarantine is an interim owner disposition, not an encrypted external archive
and not physical sanitation. After the owner has exported or destroyed
quarantined material under an approved retention process, every row must be
removed from `private_message_residue_quarantine` before sanitation. The
sanitation tool refuses non-empty quarantine or other explicit residue custody
tables. A separate stopped-database `VACUUM INTO` procedure is then needed to
remove deleted bytes from free pages. Never include quarantine-table contents
in operational reports.

## Required follow-on

After a successful adjudication run:

1. Preserve the adjudication backup, manifest, plan, execution report, and
   audit row together.
2. Run migration 007 in dry-run mode against the same stopped database. It must
   report `ready: true` and zero issues.
3. Rehearse migration 007 execution and restoration on a fresh copy.
4. During the production maintenance window, execute migration 007 with its
   own fresh token, backup, and report.
5. Run SQLite integrity, mailbox isolation, graph/search confidentiality, and
   vector-reference canaries before reopening writers.
6. Restore whole-database backups on rollback. Never splice selected rows from
   an old database into the new one.

## Development verification

```bash
node --test src/migrations/private-message-residue-adjudication.node-test.mjs
npm run test:migrations
```

The hermetic tests cover body-free inventory, evidence hashes, approval and
complete-manifest validation, canonical database/token binding, implicit-rowid
logical evidence, exact ancillary and vector ownership, missing/extra/duplicate/
stale refusal, explicit adapter refusal, wrong-token redaction, no-clobber
backup publication, symlink-parent sidecar refusal, pre-/post-commit and final
backup ownership verification, transactional rollback, quarantine/vector
cleanup, migration-007 readiness, and exact mailbox pointer restoration.
