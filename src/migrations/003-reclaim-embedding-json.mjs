/**
 * Migration 003 — reclaim embedding_json + drop duplicate indexes.
 *
 * When the sqlite-vec (vec0) extension is active, the binary vector in the
 * vec0 table is the search path; neural_vec_index.embedding_json is a redundant
 * JSON copy used ONLY by the fallback path (vec0 absent). On the live DB this
 * JSON copy was ~71MB. This migration:
 *   1) verifies vec0 is loadable and the vector table is queryable,
 *   2) NULLs embedding_json ONLY for rows that have a vector_rowid (proof the
 *      binary vector exists — so fallback can be reconstructed from vec0 if ever
 *      needed, and we never strip the only copy),
 *   3) drops 5 duplicate tenant indexes left over from migration churn,
 *   4) VACUUMs to actually reclaim the freed pages.
 *
 * SAFETY: refuses to run (and changes nothing) if vec0 can't be loaded — that
 * would mean embedding_json is the ONLY embedding copy. Idempotent. Read the
 * DB path from argv; intended to run against a COPY first, then live.
 *
 *   node src/migrations/003-reclaim-embedding-json.mjs <db-path> [--apply]
 * Without --apply it does a DRY RUN (reports what it would reclaim, writes nothing).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!DB_PATH) {
  console.error('usage: node 003-reclaim-embedding-json.mjs <db-path> [--apply]');
  process.exit(1);
}

// Duplicate indexes (each pair indexes the same column; keep one, drop the dup).
const DUPLICATE_INDEXES = [
  'idx_shared_memory_tenant',     // dup of idx_shared_tenant
  'idx_consensus_history_tenant', // dup of idx_consensus_tenant
  'idx_shared_knowledge_tenant',  // dup of idx_knowledge_tenant
  'idx_project_artifacts_tenant', // dup of idx_artifacts_tenant
  'idx_individual_memory_tenant', // dup of idx_individual_tenant
];

const db = new Database(DB_PATH);
const MB = (b) => (Math.round((b / 1048576) * 10) / 10) + ' MB';
const pageBytes = () =>
  db.prepare('SELECT page_count*page_size b FROM pragma_page_count(), pragma_page_size()').get().b;

// 1) Verify vec0 is genuinely active. If not, abort — do NOT strip the only copy.
let vecOk = false;
try {
  const vec = require('sqlite-vec');
  (vec.load || vec.default?.load)(db);
  // probe the vec0 virtual table
  db.prepare('SELECT COUNT(*) c FROM shared_memory_vec').get();
  vecOk = true;
} catch (e) {
  console.error(`❌ ABORT: sqlite-vec (vec0) not loadable here: ${e.message}`);
  console.error('   embedding_json may be the only embedding copy; refusing to strip it.');
  db.close();
  process.exit(2);
}

const before = pageBytes();
const total = db.prepare('SELECT COUNT(*) c FROM neural_vec_index').get().c;
const withVec = db.prepare('SELECT COUNT(*) c FROM neural_vec_index WHERE vector_rowid IS NOT NULL AND embedding_json IS NOT NULL').get().c;
const orphans = db.prepare('SELECT COUNT(*) c FROM neural_vec_index WHERE vector_rowid IS NULL AND embedding_json IS NOT NULL').get().c;
const jsonBytes = db.prepare('SELECT COALESCE(SUM(LENGTH(embedding_json)),0) b FROM neural_vec_index WHERE vector_rowid IS NOT NULL').get().b;

console.log(`vec0 active: yes | DB size: ${MB(before)}`);
console.log(`neural_vec_index rows: ${total} | strippable (have vector_rowid): ${withVec} | KEEPING orphans (no vec row): ${orphans}`);
console.log(`embedding_json reclaimable: ~${MB(jsonBytes)}`);
const dupPresent = DUPLICATE_INDEXES.filter((n) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(n));
console.log(`duplicate indexes present: ${dupPresent.length ? dupPresent.join(', ') : '(none)'}`);

if (!APPLY) {
  console.log('\nDRY RUN — no changes written. Re-run with --apply to execute.');
  db.close();
  process.exit(0);
}

console.log('\nAPPLYING…');
const strip = db.transaction(() => {
  // NULL embedding_json only where a binary vec row exists.
  const r = db.prepare('UPDATE neural_vec_index SET embedding_json = NULL WHERE vector_rowid IS NOT NULL AND embedding_json IS NOT NULL').run();
  console.log(`  embedding_json NULLed: ${r.changes} rows`);
  for (const name of dupPresent) {
    db.prepare(`DROP INDEX IF EXISTS ${name}`).run();
    console.log(`  dropped duplicate index: ${name}`);
  }
});
strip();

console.log('  VACUUM…');
db.exec('VACUUM');
const after = pageBytes();
console.log(`\nDONE. DB size: ${MB(before)} -> ${MB(after)}  (reclaimed ${MB(before - after)})`);
db.close();
