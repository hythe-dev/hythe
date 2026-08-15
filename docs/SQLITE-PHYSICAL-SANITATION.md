# SQLite physical sanitation after private-residue cleanup

Logical deletion is not physical erasure. Deleted content may remain in free
SQLite pages, WAL files, old database copies, migration backups, and container
layers. Run this procedure only after adjudication and migration 007 have both
completed on a rehearsal copy and a second 007 dry-run reports every count and
issue as zero.

The server and every other writer must be stopped. Checkpoint and truncate the
WAL first. The sanitation tool refuses a non-empty WAL, rollback journal, or
SHM and never modifies the source database. This offline/server-stop condition
is an operator gate; the tool cannot prove that another process will not open
the file after inspection.

Sanitation also refuses any non-empty explicit residue custody table matching
`private_message_residue_quarantine`, `private_message_residue_custody*`, or
`private_message_residue_archive*`. Quarantine is plaintext interim custody,
not deletion. Export or destroy its rows under the approved retention process,
record that decision separately, and empty the table before planning physical
sanitation.

Plan against the stopped post-migration database and a new output path:

```bash
node dist/migrations/vacuum-sanitized-database.mjs /path/to/engram.db \
  --output /path/to/engram.sanitized.db \
  --report /secure/path/vacuum-plan.json
```

Review the body-free report. It must say `ready`, show migration-007 residue
counts all zero, and report successful quick, integrity, and foreign-key
checks. Execute with that exact token and a new report path:

```bash
node dist/migrations/vacuum-sanitized-database.mjs /path/to/engram.db \
  --output /path/to/engram.sanitized.db \
  --execute --confirm VACUUM-SANITIZED-XXXXXXXXXXXXXXXXXXXX \
  --report /secure/path/vacuum-execute.json
```

Output and report must be different, new, non-aliasing paths. Neither may use
the source database's reserved `-journal`, `-wal`, or `-shm` pathname, including
through a symlinked parent.

The tool exclusively reserves a unique sibling path, retains its file
descriptor as an ownership proof, runs `VACUUM INTO`, sets mode 0600, fsyncs
it, and inspects both the unchanged source and staged output. Cleanup unlinks a
staged name only while it still names that owned inode; a preexisting or
replacement file is preserved. Verification compares
the complete logical schema and every table as an order-independent row
multiset, checks the exact vector-index and complete vector
`rowid → embedding hash` mappings, requires quick, full integrity, and
foreign-key checks to pass, requires zero free pages and sidecars in the
output, reruns migration-007 analysis, and requires every explicit custody
table to be empty. Only then does an atomic same-directory hard-link operation
publish the requested output path with no-clobber semantics; a path that
appears during promotion is never overwritten. The tool reopens and rechecks
the published output's inode, file hash, and logical digest. Status is
`verified` only after that final recheck. A failed verification or publication
removes the tool's unique staged path and never removes an independently
created destination. The output and reports are mode 0600.

The report is likewise opened exclusively and kept on its original file
descriptor for the run. If its pathname is replaced, the tool never overwrites
the replacement. Replacement before promotion aborts without output;
replacement after promotion causes the tool to remove only its hash- and
inode-bound output and report verification failure to the caller.

Do not overwrite the source in place, and do not rename the requested output
again before checking the report: after `status: "verified"`, `--output` already
names the exact reopened and verified artifact. Record its file hash and
logical/vector digests from the report.

For a canonical-path swap, keep every process stopped and use a deployment
mechanism on the same filesystem that provides these exact steps:

1. Recheck the current source against `sourceAfter` in the execute report and
   recheck the verified output's SHA-256. Abort on any mismatch or sidecar.
2. Publish the old source at a new restricted rollback name with atomic
   no-clobber semantics and fsync the parent directory; only then remove the old
   canonical name.
3. Publish the verified output at the now-vacant canonical name with atomic
   no-clobber semantics, fsync the file and parent directory, and only then
   remove the former output name. Never use a copy or an overwriting rename.
4. Run this tool in plan mode against the new canonical path and a different,
   unused output path. Confirm quick/integrity/foreign-key checks, zero residue,
   empty custody, clean sidecars, and exact logical/vector digests before any
   writer starts.
5. If publication or recheck fails, remove the new canonical name only after
   proving it is the sanitized inode, restore the restricted rollback inode with
   the same no-clobber procedure, fsync, and recheck it before reopening.

Start HYTHE with writes still gated for mailbox, graph, semantic-search,
resource, export, and cross-agent isolation canaries. The sanitation utility
does not automate the canonical-path swap or process stop/start.

All pre-migration backups and reports that contain quarantined row material
remain sensitive. Retain them encrypted and access-controlled, then destroy
them—or destroy their encryption keys—under an explicit retention decision.
