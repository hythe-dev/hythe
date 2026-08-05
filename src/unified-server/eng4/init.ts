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

const DUPLICATE_COLUMN = /duplicate column name/i;

export interface ApplyEng4SchemaResult {
  statementsApplied: number;
  alterSkippedAsExisting: number;
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
  });
  runAll();

  return { statementsApplied: applied, alterSkippedAsExisting: skipped };
}
