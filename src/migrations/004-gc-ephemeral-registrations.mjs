/**
 * Migration 004 — garbage-collect ephemeral agent registrations.
 *
 * The stdio bridge mints a per-process id `agent-<host>-<pid>-<base36ts>` and
 * auto-registers it whenever FROM/MCP_FROM is unset, so every CLI launch /
 * reconnect leaves a throwaway row forever. On the live DB this was ~1,949 of
 * 2,003 registrations (97%), making get_agent_status huge and "who's here"
 * meaningless.
 *
 * Deletes ONLY ids matching the ephemeral pattern, and ONLY those not seen in
 * the last RETAIN_DAYS (default 7) — so currently-active bridges still show up.
 * Every stable/named agent (claude-engram, cowork, codex-desktop, gemini,
 * cursor, …) is preserved untouched. Dry-run by default.
 *
 *   node src/migrations/004-gc-ephemeral-registrations.mjs <db-path> [--apply] [--retain-days N]
 *
 * Pair with the bridge change (stable per-host id) so the churn doesn't refill.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2];
const APPLY = process.argv.includes('--apply');
const rdIdx = process.argv.indexOf('--retain-days');
const RETAIN_DAYS = rdIdx !== -1 ? Math.max(0, parseInt(process.argv[rdIdx + 1], 10) || 0) : 7;
if (!DB_PATH) {
  console.error('usage: node 004-gc-ephemeral-registrations.mjs <db-path> [--apply] [--retain-days N]');
  process.exit(1);
}

const db = new Database(DB_PATH);

// Ephemeral id shape: agent-<host>-<pid digits>-<base36 timestamp>.
// GLOB is case-sensitive and anchored; require a numeric pid segment so we never
// match a deliberately-named agent like "agent-smith".
const EPHEMERAL = "agent_id GLOB 'agent-*-[0-9]*-*'";
// Retain rows updated within the window (active bridges) using SQLite datetime.
const RETAIN = `updated_at >= datetime('now', '-${RETAIN_DAYS} days')`;

const total = db.prepare('SELECT COUNT(*) c FROM agent_registrations').get().c;
const ephemeralTotal = db.prepare(`SELECT COUNT(*) c FROM agent_registrations WHERE ${EPHEMERAL}`).get().c;
const targets = db.prepare(`SELECT COUNT(*) c FROM agent_registrations WHERE ${EPHEMERAL} AND NOT (${RETAIN})`).get().c;
const ephemeralKept = ephemeralTotal - targets;
const stableKept = total - ephemeralTotal;

console.log(`DB: ${DB_PATH}`);
console.log(`total registrations: ${total}`);
console.log(`  stable/named (always kept): ${stableKept}`);
console.log(`  ephemeral total: ${ephemeralTotal}`);
console.log(`    kept (active within ${RETAIN_DAYS}d): ${ephemeralKept}`);
console.log(`    DELETE (ephemeral + stale): ${targets}`);
console.log(`=> after: ${total - targets} registrations`);

// Show a sample of what would be deleted (safety eyeball).
const sample = db.prepare(`SELECT agent_id, updated_at FROM agent_registrations WHERE ${EPHEMERAL} AND NOT (${RETAIN}) ORDER BY updated_at DESC LIMIT 5`).all();
if (sample.length) {
  console.log('  sample to delete:');
  for (const r of sample) console.log(`    - ${r.agent_id}  (${String(r.updated_at).slice(0,10)})`);
}

if (!APPLY) {
  console.log('\nDRY RUN — no changes written. Re-run with --apply to execute.');
  db.close();
  process.exit(0);
}

console.log('\nAPPLYING…');
const r = db.prepare(`DELETE FROM agent_registrations WHERE ${EPHEMERAL} AND NOT (${RETAIN})`).run();
console.log(`  deleted ${r.changes} ephemeral registrations`);
const after = db.prepare('SELECT COUNT(*) c FROM agent_registrations').get().c;
console.log(`DONE. registrations: ${total} -> ${after}`);
db.close();
