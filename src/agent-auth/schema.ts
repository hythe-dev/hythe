import type Database from 'better-sqlite3';

// Single-source additive DDL used by runtime and migration tests.
// @ts-ignore -- checked .mjs export, copied to dist by TypeScript.
import { DDL } from '../migrations/008-agent-principals.mjs';

/**
 * Additive, identity-only schema. Registrations remain liveness/presentation
 * records and are intentionally not a credential or authorization source.
 */
export const AGENT_PRINCIPAL_DDL = (DDL as readonly string[]).filter(
  (statement) => !/^\s*PRAGMA\b/i.test(statement),
);

export function applyAgentPrincipalSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  const apply = db.transaction(() => {
    for (const statement of AGENT_PRINCIPAL_DDL) db.exec(statement);
  });
  apply();
}
