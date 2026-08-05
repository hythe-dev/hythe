/**
 * Migration 002: Users table + tenant_id/user_id on ai_messages & session_handoffs
 *
 * SPECTRA NE-P1 Task 900:
 *   1. Create users table (id, tenant_id, display_name, timezone, locale, etc.)
 *   2. Add tenant_id + user_id columns to ai_messages (if missing)
 *   3. Add tenant_id + user_id columns to session_handoffs (if missing)
 *   4. Update session_handoffs unique index: (tenant_id, project_id) WHERE active=1
 *   5. Backfill all existing rows with tenant_id='default'
 *   6. Create bootstrap user 'tommy'
 *
 * Idempotent: safe to re-run. All operations use IF NOT EXISTS / column checks.
 * Zero data loss: no rows deleted, only columns added and backfilled.
 */
import Database from 'better-sqlite3';

interface MigrationResult {
  success: boolean;
  usersCreated: boolean;
  tenantMembershipsCreated: boolean;
  columnsAdded: string[];
  indexUpdated: boolean;
  backfilledRows: { ai_messages: number; session_handoffs: number };
  bootstrapUser: boolean;
  bootstrapMembership: boolean;
  error?: string;
}

export function runMigration002(
  dbPath: string,
  options: { dryRun?: boolean } = {}
): MigrationResult {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const result: MigrationResult = {
    success: false,
    usersCreated: false,
    tenantMembershipsCreated: false,
    columnsAdded: [],
    indexUpdated: false,
    backfilledRows: { ai_messages: 0, session_handoffs: 0 },
    bootstrapUser: false,
    bootstrapMembership: false,
  };

  try {
    const transaction = db.transaction(() => {
      // ─── 1. Create users table ───
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          display_name TEXT NOT NULL,
          timezone TEXT DEFAULT 'UTC',
          locale TEXT DEFAULT 'en-US',
          date_format TEXT DEFAULT 'YYYY-MM-DD',
          units TEXT DEFAULT 'metric',
          working_hours TEXT DEFAULT '{"start":"09:00","end":"17:00"}',
          last_seen_tz TEXT,
          prefs_version INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`);
      result.usersCreated = true;
      console.log('✅ users table created (or already exists)');

      // ─── 1b. Create tenant_memberships table (canonical membership model) ───
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_memberships (
          user_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now')),
          UNIQUE (tenant_id, user_id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships(user_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_role ON tenant_memberships(tenant_id, role)`);
      result.tenantMembershipsCreated = true;
      console.log('✅ tenant_memberships table created (or already exists)');

      // ─── 2. Add tenant_id + user_id to ai_messages ───
      const aiCols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
      const aiColNames = aiCols.map((c: any) => c.name);

      if (!aiColNames.includes('tenant_id')) {
        db.exec(`ALTER TABLE ai_messages ADD COLUMN tenant_id TEXT DEFAULT 'default'`);
        result.columnsAdded.push('ai_messages.tenant_id');
        console.log('✅ Added tenant_id to ai_messages');
      }

      if (!aiColNames.includes('user_id')) {
        db.exec(`ALTER TABLE ai_messages ADD COLUMN user_id TEXT`);
        result.columnsAdded.push('ai_messages.user_id');
        console.log('✅ Added user_id to ai_messages');
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_tenant ON ai_messages(tenant_id)`);

      // ─── 3. Add tenant_id + user_id to session_handoffs ───
      const shCols = db.prepare('PRAGMA table_info(session_handoffs)').all() as any[];
      const shColNames = shCols.map((c: any) => c.name);

      if (!shColNames.includes('tenant_id')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN tenant_id TEXT DEFAULT 'default'`);
        result.columnsAdded.push('session_handoffs.tenant_id');
        console.log('✅ Added tenant_id to session_handoffs');
      }

      if (!shColNames.includes('user_id')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN user_id TEXT`);
        result.columnsAdded.push('session_handoffs.user_id');
        console.log('✅ Added user_id to session_handoffs');
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant ON session_handoffs(tenant_id)`);

      // ─── 4. Update session_handoffs unique index to (tenant_id, project_id) ───
      // Drop old global-scoped index, create tenant-scoped one
      // SQLite doesn't have DROP INDEX IF EXISTS in all versions, so use try/catch
      try {
        db.exec(`DROP INDEX idx_session_handoffs_active`);
        console.log('🔧 Dropped old idx_session_handoffs_active (project_id only)');
      } catch {
        // Index may not exist or may already be the new version — that's fine
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_handoffs_active
          ON session_handoffs(tenant_id, project_id) WHERE active = 1
      `);
      result.indexUpdated = true;
      console.log('✅ Created tenant-scoped unique index on session_handoffs(tenant_id, project_id)');

      // ─── 5. Backfill existing rows with tenant_id='default' ───
      // Only update rows where tenant_id is NULL (not already set)
      const aiBackfill = db.prepare(
        `UPDATE ai_messages SET tenant_id = 'default' WHERE tenant_id IS NULL`
      ).run();
      result.backfilledRows.ai_messages = aiBackfill.changes;
      if (aiBackfill.changes > 0) {
        console.log(`✅ Backfilled ${aiBackfill.changes} ai_messages rows with tenant_id='default'`);
      }

      const shBackfill = db.prepare(
        `UPDATE session_handoffs SET tenant_id = 'default' WHERE tenant_id IS NULL`
      ).run();
      result.backfilledRows.session_handoffs = shBackfill.changes;
      if (shBackfill.changes > 0) {
        console.log(`✅ Backfilled ${shBackfill.changes} session_handoffs rows with tenant_id='default'`);
      }

      // ─── 6. Create bootstrap user 'tommy' ───
      const existingUser = db.prepare(`SELECT id FROM users WHERE id = 'tommy'`).get();
      if (!existingUser) {
        db.prepare(`
          INSERT INTO users (id, tenant_id, display_name, timezone, locale, date_format, units, working_hours)
          VALUES ('tommy', 'default', 'Tommy', 'America/Chicago', 'en-US', 'YYYY-MM-DD', 'metric', '{"start":"09:00","end":"17:00"}')
        `).run();
        result.bootstrapUser = true;
        console.log('✅ Bootstrap user "tommy" created');
      } else {
        console.log('ℹ️  Bootstrap user "tommy" already exists');
      }

      // ─── 6b. Create bootstrap membership for tommy ───
      const existingMembership = db.prepare(
        `SELECT user_id FROM tenant_memberships WHERE user_id = 'tommy' AND tenant_id = 'default'`
      ).get();
      if (!existingMembership) {
        db.prepare(`
          INSERT INTO tenant_memberships (user_id, tenant_id, role)
          VALUES ('tommy', 'default', 'owner')
        `).run();
        result.bootstrapMembership = true;
        console.log('✅ Bootstrap membership (tommy, default, owner) created');
      } else {
        console.log('ℹ️  Bootstrap membership for tommy already exists');
      }

      // ─── Parity assertions ───
      // Verify no NULL tenant_id in ai_messages after backfill
      const nullTenantAi = (db.prepare(
        `SELECT COUNT(*) as cnt FROM ai_messages WHERE tenant_id IS NULL`
      ).get() as any).cnt;
      if (nullTenantAi > 0) {
        throw new Error(`Parity check failed: ${nullTenantAi} ai_messages rows still have NULL tenant_id`);
      }

      // Verify no NULL tenant_id in session_handoffs after backfill
      const nullTenantSh = (db.prepare(
        `SELECT COUNT(*) as cnt FROM session_handoffs WHERE tenant_id IS NULL`
      ).get() as any).cnt;
      if (nullTenantSh > 0) {
        throw new Error(`Parity check failed: ${nullTenantSh} session_handoffs rows still have NULL tenant_id`);
      }

      // Verify users table has at least the bootstrap user
      const userCount = (db.prepare(`SELECT COUNT(*) as cnt FROM users`).get() as any).cnt;
      if (userCount < 1) {
        throw new Error('Parity check failed: users table is empty after bootstrap');
      }

      // Verify tenant_memberships has at least the bootstrap membership
      const membershipCount = (db.prepare(`SELECT COUNT(*) as cnt FROM tenant_memberships`).get() as any).cnt;
      if (membershipCount < 1) {
        throw new Error('Parity check failed: tenant_memberships table is empty after bootstrap');
      }

      console.log('✅ All parity assertions passed');
    });

    if (options.dryRun) {
      console.log('🏃 Dry run — not committing.');
      result.success = true;
      return result;
    }

    transaction();
    result.success = true;
    console.log('🎉 Migration 002 complete.');
  } catch (err: any) {
    result.error = err.message;
    console.error(`❌ Migration 002 failed: ${err.message}`);
  } finally {
    db.close();
  }

  return result;
}

// CLI entry point
if (process.argv[1]?.includes('002-users-tenant-columns')) {
  const dbPath = process.argv[2] || './data/unified-platform.db';
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\n🔄 Migration 002: Users table + tenant columns`);
  console.log(`   DB: ${dbPath}`);
  console.log(`   Dry run: ${dryRun}\n`);

  const result = runMigration002(dbPath, { dryRun });
  console.log('\n📊 Result:', JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}
