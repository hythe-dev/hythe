/**
 * Schema indexing + legacy data migrations.
 *
 * Extracted from MemoryManager (./index.ts). These are db-only routines (they
 * touch only the better-sqlite3 handle, no instance state), each with a single
 * call site in initializeDatabase(), so they move out as plain functions.
 *
 * NOTE: the core CREATE TABLE DDL remains in MemoryManager for now. The lazy
 * ensure*Column guards live here as db-only helpers; MemoryManager keeps thin
 * delegators that preserve per-instance "checked" memoization.
 */
import type Database from 'better-sqlite3';

/**
 * Lazy column guards for ai_messages — idempotent ALTERs that add a column only
 * if missing. Return true when the check completed (table exists), false when
 * the table is not present yet, so callers can memoize only on success and
 * retry on a fresh DB until the table is created.
 */
export function ensureReadAtColumn(db: Database.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
    if (!cols.some((c: any) => c.name === 'read_at')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN read_at TEXT').run();
      console.log('📬 Added read_at column to ai_messages');
    }
    return true;
  } catch {
    return false; // table might not exist yet
  }
}

export function ensureSummaryColumn(db: Database.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
    if (!cols.some((c: any) => c.name === 'summary')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN summary TEXT').run();
      console.log('📋 Added summary column to ai_messages');
    }
    return true;
  } catch {
    return false; // table might not exist yet
  }
}

export function ensureArchivedAtColumn(db: Database.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
    if (!cols.some((c: any) => c.name === 'archived_at')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN archived_at TEXT').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_messages_archived ON ai_messages(archived_at)').run();
      console.log('📦 Added archived_at column + index to ai_messages');
    }
    return true;
  } catch {
    return false; // table might not exist yet
  }
}

export function ensureMessageSupersessionColumns(db: Database.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
    if (!cols.some((c: any) => c.name === 'superseded_by')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN superseded_by TEXT').run();
    }
    if (!cols.some((c: any) => c.name === 'superseded_at')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN superseded_at TEXT').run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_ai_messages_active_inbox ON ai_messages(tenant_id, to_agent, superseded_at, archived_at, read_at, created_at DESC)'
    ).run();
    return true;
  } catch {
    return false; // table or a prerequisite migration might not exist yet
  }
}

export function ensureMessageDeliveryColumn(db: Database.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
    if (!cols.some((c: any) => c.name === 'delivered_at')) {
      db.prepare('ALTER TABLE ai_messages ADD COLUMN delivered_at TEXT').run();
    }
    return true;
  } catch {
    return false; // table might not exist yet
  }
}

/** Create secondary indexes. Run after migrations so referenced columns exist. */
export function createIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_individual_agent_id ON individual_memory(agent_id);
    CREATE INDEX IF NOT EXISTS idx_individual_type ON individual_memory(memory_type);
    CREATE INDEX IF NOT EXISTS idx_individual_importance ON individual_memory(importance);
    CREATE INDEX IF NOT EXISTS idx_individual_tenant ON individual_memory(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shared_type ON shared_memory(memory_type);
    CREATE INDEX IF NOT EXISTS idx_shared_created_by ON shared_memory(created_by);
    CREATE INDEX IF NOT EXISTS idx_shared_tenant ON shared_memory(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
    CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON shared_knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON shared_knowledge(source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON shared_knowledge(confidence);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON shared_knowledge(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_consensus_tenant ON consensus_history(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_tenant ON project_artifacts(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_graph_lookup_key
      ON graph_lookup_keys(tenant_id, lookup_key);
    CREATE INDEX IF NOT EXISTS idx_graph_lookup_key_type
      ON graph_lookup_keys(tenant_id, lookup_key, memory_type);
    CREATE INDEX IF NOT EXISTS idx_graph_lookup_memory_id
      ON graph_lookup_keys(tenant_id, memory_id);
  `);
}

/** Backward-compat: add tenant_id to legacy tables that predate multi-tenancy. */
export function migrateAddTenantColumn(db: Database.Database): void {
  // Check and add tenant_id to existing tables (for backward compatibility)
  const tables = ['individual_memory', 'shared_memory', 'tasks', 'shared_knowledge', 'consensus_history', 'project_artifacts'];

  for (const table of tables) {
    try {
      // Check if tenant_id column exists
      const pragma = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      const hasTenantId = pragma.some((col: any) => col.name === 'tenant_id');

      if (!hasTenantId) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT DEFAULT 'default'`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
        console.log(`🔧 Migration: Added tenant_id column to ${table}`);
      }
    } catch (error) {
      // Table might not exist yet, which is fine
      console.debug(`Migration: Could not check ${table}:`, error);
    }
  }
}

/**
 * One-time migration: copy agent_registration and agent_identity rows
 * from shared_memory into the canonical tables, then delete the originals.
 */
export function migrateAgentRegistrations(db: Database.Database): void {
  try {
    // Migrate registrations
    const regRows = db.prepare(
      `SELECT id, tenant_id, content, created_by, created_at, updated_at
       FROM shared_memory WHERE memory_type = 'agent_registration'`
    ).all() as any[];

    if (regRows.length > 0) {
      const upsertReg = db.prepare(`
        INSERT INTO agent_registrations (agent_id, tenant_id, name, capabilities_json, endpoint, metadata_json, status, registered_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(agent_id, tenant_id) DO UPDATE SET
          name = excluded.name,
          capabilities_json = excluded.capabilities_json,
          endpoint = excluded.endpoint,
          metadata_json = excluded.metadata_json,
          registered_by = excluded.registered_by,
          updated_at = excluded.updated_at
      `);
      const deleteOld = db.prepare('DELETE FROM shared_memory WHERE id = ?');

      const migrate = db.transaction(() => {
        for (const row of regRows) {
          try {
            const data = JSON.parse(row.content);
            upsertReg.run(
              data.agentId || 'unknown',
              row.tenant_id || 'default',
              data.name || data.agentId || 'unknown',
              JSON.stringify(data.capabilities || []),
              data.endpoint || null,
              JSON.stringify(data.metadata || {}),
              row.created_by || data.metadata?.registeredBy || null,
              row.created_at,
              row.updated_at
            );
            deleteOld.run(row.id);
          } catch (parseErr) {
            console.warn(`⚠️ Skipping malformed agent_registration ${row.id}:`, parseErr);
          }
        }
      });
      migrate();
      console.log(`📋 Migrated ${regRows.length} agent_registration rows to canonical table`);
    }

    // Migrate identity changes
    const idRows = db.prepare(
      `SELECT id, content, created_at
       FROM shared_memory WHERE memory_type = 'agent_identity'`
    ).all() as any[];

    if (idRows.length > 0) {
      const insertId = db.prepare(`
        INSERT OR IGNORE INTO agent_identity_changes (id, previous_agent_id, updated_agent_id, updated_name, capabilities_json, metadata_json, updated_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteOld = db.prepare('DELETE FROM shared_memory WHERE id = ?');

      const migrate = db.transaction(() => {
        for (const row of idRows) {
          try {
            const data = JSON.parse(row.content);
            insertId.run(
              row.id,
              data.previousAgentId || '',
              data.updatedAgentId || '',
              data.updatedName || data.updatedAgentId || '',
              JSON.stringify(data.capabilities || []),
              JSON.stringify(data.metadata || {}),
              data.updatedBy || null,
              row.created_at
            );
            deleteOld.run(row.id);
          } catch (parseErr) {
            console.warn(`⚠️ Skipping malformed agent_identity ${row.id}:`, parseErr);
          }
        }
      });
      migrate();
      console.log(`🪪 Migrated ${idRows.length} agent_identity rows to canonical table`);
    }
  } catch (err) {
    // Non-fatal: shared_memory table may not exist yet on first run
    console.warn('⚠️ Agent registration migration skipped:', err);
  }
}
