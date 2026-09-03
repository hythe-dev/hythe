/**
 * ENG-4 schema initialization (sub-step 2(a), design D1 — approved contract
 * layer @ 89fc422; DDL boundary per review b2e6fc7c #6).
 *
 * Applies the eng4 control-plane DDL to a FRESH or existing isolated
 * database at server initialization. The inert migration file remains the
 * SINGLE SOURCE of the DDL — this module imports it, never duplicates it.
 *
 * Boundary semantics (executable-tested):
 * - PRAGMA foreign_keys=ON is set per connection, OUTSIDE any transaction,
 *   BEFORE the DDL apply — FK behavior must be live while triggers/FKs are
 *   exercised.
 * - The DDL statements apply ATOMICALLY in one transaction: a mid-apply
 *   failure rolls back completely (no partial eng4 schema).
 * - The apply is IDEMPOTENT across restarts: CREATE ... IF NOT EXISTS
 *   everywhere, plus duplicate-column-guarded additive ai_messages ALTERs.
 * - Only the database handle the server itself opened is ever touched —
 *   there is no path to any other file.
 */
import type DatabaseType from 'better-sqlite3';
// The inert migration exports the DDL for review/tests/runtime; direct
// execution of the migration file still refuses (its guard is untouched).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- untyped .mjs module; DDL is a readonly string array
import { DDL } from '../../migrations/005-eng4-control-plane.mjs';
import { backfillVersionFoundation, type BackfillSummary } from './versions.js';

const DUPLICATE_COLUMN = /duplicate column name/i;

export interface ApplyEng4SchemaResult {
  statementsApplied: number;
  alterSkippedAsExisting: number;
  /**
   * ENG-4 H2 (design 3429000 §6.2): the verified version backfill that runs
   * in the SAME transaction as the DDL on every apply — reconstructing
   * coverage + versions for ledger-bound snapshots above the scope's cutover
   * mark that have none, and checking STRUCTURE everywhere: null-digest
   * snapshots are bare, covered snapshots have one coverage row per ledger
   * row, and no snapshot at or below the cutover is uncovered. Any such
   * failure rolls the whole apply back (the server does not start). Full
   * VALUE parity of already-covered snapshots is verifyVersionParity's job
   * (contract tests now; resume in H4), not a startup check.
   * Absent only when `statementsOverride` is used (rollback tests).
   */
  versionBackfill?: BackfillSummary;
}

/**
 * Apply the eng4 schema. `statementsOverride` exists ONLY for the
 * atomicity/rollback tests — production callers pass nothing.
 */
export function applyEng4Schema(
  db: DatabaseType.Database,
  statementsOverride?: readonly string[]
): ApplyEng4SchemaResult {
  // Per-connection FK enforcement, outside any transaction (SQLite ignores
  // the pragma inside one).
  db.pragma('foreign_keys = ON');

  const statements = (statementsOverride ?? (DDL as readonly string[])).filter(
    (s) => !/^\s*PRAGMA\b/i.test(s)
  );

  let applied = 0;
  let skipped = 0;
  let versionBackfill: BackfillSummary | undefined;
  const runAll = db.transaction(() => {
    for (const statement of statements) {
      try {
        db.exec(statement);
        applied++;
      } catch (err) {
        // Additive ALTERs are idempotent via the duplicate-column guard;
        // everything else must abort (and roll back) loudly.
        if (/^\s*ALTER TABLE/i.test(statement) && DUPLICATE_COLUMN.test(String(err))) {
          skipped++;
          continue;
        }
        throw err;
      }
    }
    // H2 verified backfill — same transaction, all-or-nothing with the DDL.
    if (!statementsOverride) versionBackfill = backfillVersionFoundation(db);
  });
  runAll();

  return {
    statementsApplied: applied,
    alterSkippedAsExisting: skipped,
    ...(versionBackfill ? { versionBackfill } : {}),
  };
}
