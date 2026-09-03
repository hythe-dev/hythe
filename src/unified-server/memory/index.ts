// Hierarchical Memory Manager Implementation
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import { randomUUID as uuidv4 } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  MemorySystem,
  IndividualMemory,
  SharedMemory,
  MemoryQuery,
  MemoryScope,
  SearchResult,
  MemoryUpdate,
  AgentPreferences,
  LearningHistory,
  PrivateMemory,
  ProjectContext,
  Task,
  TaskStatus,
  TaskGraph,
  ConsensusHistory,
  SharedKnowledge,
  ProjectArtifacts
} from '../types/memory.js';
import { SqliteVecClient } from '../../memory/sqlite-vec-client.js';
import { applyEng4Schema } from '../eng4/init.js';
import type { RequestContext } from '../../middleware/auth/types.js';
import {
  authorizeGraphMutation as authorizeGraphMutationImpl,
  authorizeGraphRead as authorizeGraphReadImpl,
  classifyObservationSensitivity as classifyObservationSensitivityImpl,
} from './authz.js';
import {
  createIndexes,
  migrateAddTenantColumn,
  migrateAgentRegistrations,
  ensureReadAtColumn as ensureReadAtColumnImpl,
  ensureSummaryColumn as ensureSummaryColumnImpl,
  ensureArchivedAtColumn as ensureArchivedAtColumnImpl,
  ensureMessageSupersessionColumns as ensureMessageSupersessionColumnsImpl,
  ensureMessageDeliveryColumn as ensureMessageDeliveryColumnImpl,
} from './schema.js';
import {
  setSystemConnected,
  setDualWriteEnabled,
  recordDualWriteResult,
  recordMemoryReadLatency,
  recordMemoryWriteLatency,
  metrics
} from '../../observability/index.js';

type GraphMemoryType = 'entity' | 'observation' | 'relation';

interface GraphLookupEntry {
  lookupKey: string;
  keyKind: string;
  weight: number;
}

interface MessageQueryOptions {
  messageType?: string;
  since?: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  markAsRead?: boolean;
  tenantId?: string;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  compact?: boolean;
  from?: string;
}

interface MessagePage {
  messages: any[];
  totalMatching: number;
  limit: number;
  offset: number;
}

export class MemoryManager {
  /** ENG-2 index diet: hard cap on graph_lookup_keys rows per memory. */
  static readonly MAX_LOOKUP_KEYS_PER_MEMORY = 64;
  /** Smallest honest context budget that can carry identity + budget metadata. */
  static readonly MIN_CONTEXT_TOKEN_BUDGET = 128;

  private db: Database.Database;
  private dbPath: string;
  private memorySystem: MemorySystem;

  /** Expose database reference for tenant resolver initialization */
  getDb(): Database.Database { return this.db; }
  public vectorClient?: SqliteVecClient;
  private isAdvancedSystemsEnabled: boolean = false;
  private isDualWriteEnabled: boolean = false;
  private confidentialEntityReferenceCache = new Map<string, Set<string>>();
  readonly contentSizeThreshold: number = parseInt(process.env.CONTENT_SIZE_THRESHOLD || '51200', 10); // 50KB default

  constructor(dbPath: string = './data/unified-platform.db') {
    this.db = new Database(dbPath);
    this.dbPath = dbPath;
    this.memorySystem = this.createEmptyMemorySystem();

    this.initializeDatabase();
    // ENG-4 control plane (2a): per-connection FK pragma + atomic idempotent
    // DDL from the single-source migration; isolated DB only.
    applyEng4Schema(this.db);
    this.loadMemoryFromDatabase();
    this.initializeAdvancedSystems();
    this.initializeDualWrite();
  }

  private createEmptyMemorySystem(): MemorySystem {
    return {
      individual: new Map(),
      shared: {
        project: {} as ProjectContext,
        tasks: { tasks: new Map(), dependencies: new Map(), assignments: new Map() },
        decisions: [],
        knowledge: [],
        artifacts: []
      }
    };
  }

  private resetServedMemoryCaches(): void {
    this.memorySystem = this.createEmptyMemorySystem();
  }

  private initializeDualWrite(): void {
    this.isDualWriteEnabled = process.env.DUAL_WRITE_ENABLED === 'true';
    setDualWriteEnabled(this.isDualWriteEnabled);
    if (this.isDualWriteEnabled) {
      console.log('🔀 Dual-write mode ENABLED: Writing to both shared_memory AND canonical tables');
    }
  }

  // For testing: allow overriding dual-write setting
  public setDualWriteEnabled(enabled: boolean): void {
    this.isDualWriteEnabled = enabled;
    console.log(`🔀 Dual-write mode ${enabled ? 'ENABLED' : 'DISABLED'} (config override)`);
  }

  public isDualWriteMode(): boolean {
    return this.isDualWriteEnabled;
  }

  private async initializeAdvancedSystems(): Promise<void> {
    try {
      console.log('🚀 Initializing advanced memory systems...');

      const advancedEnabled = process.env.ENABLE_ADVANCED_MEMORY !== 'false';
      if (!advancedEnabled) {
        console.log('⏭️ Advanced memory systems disabled by ENABLE_ADVANCED_MEMORY=false');
        setSystemConnected('vector', false);
        this.vectorClient = undefined;
        this.isAdvancedSystemsEnabled = false;
        return;
      }

      // Initialize embedded sqlite-vec client
      try {
        this.vectorClient = new SqliteVecClient(this.db);
        await this.vectorClient.initialize();
        setSystemConnected('vector', true);
        metrics.logEvent('info', 'systems', 'sqlite-vec client initialized');
      } catch (vectorError) {
        console.warn('⚠️ sqlite-vec initialization failed:', vectorError);
        setSystemConnected('vector', false);
        metrics.logEvent('error', 'systems', 'sqlite-vec client initialization failed', { error: String(vectorError) });
        this.vectorClient = undefined;
      }

      this.isAdvancedSystemsEnabled = !!this.vectorClient;

      if (this.isAdvancedSystemsEnabled) {
        console.log('✅ Advanced memory systems initialized (partial or full)');
      } else {
        console.log('⚠️ No advanced systems available - SQLite-only mode');
      }

      // Startup tombstone drain: retry any failed vector deletes from previous sessions.
      void this.retryFailedVectorDeletes(100).then((result) => {
        if (result.attempted > 0) {
          console.log(`🪦 Startup tombstone drain: ${result.succeeded}/${result.attempted} succeeded, ${result.failed} failed`);
        }
      }).catch((err) => {
        console.warn('⚠️ Startup tombstone drain failed (non-fatal):', err);
      });

    } catch (error) {
      console.warn('⚠️ Advanced memory systems initialization failed:', error);
      console.log('🔄 Falling back to SQLite-only mode');
      metrics.logEvent('error', 'systems', 'All advanced systems failed - SQLite fallback', { error: String(error) });
      setSystemConnected('vector', false);
      this.isAdvancedSystemsEnabled = false;
    }
  }

  private initializeDatabase(): void {
    // Individual Memory Tables (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS individual_memory (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tenant_id TEXT DEFAULT 'default',
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        tags TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Shared Memory Tables (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_memory (
        id TEXT PRIMARY KEY,
        tenant_id TEXT DEFAULT 'default',
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        tags TEXT,
        version INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Task Management Tables (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT DEFAULT 'default',
        parent_task_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        requirements TEXT,
        status TEXT DEFAULT 'created',
        priority TEXT DEFAULT 'medium',
        estimated_effort REAL,
        actual_effort REAL,
        created_by TEXT NOT NULL,
        assigned_to TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
      )
    `);

    // Knowledge Base Table (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_knowledge (
        id TEXT PRIMARY KEY,
        tenant_id TEXT DEFAULT 'default',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT,
        source TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        verifications TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Consensus History Table (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consensus_history (
        id TEXT PRIMARY KEY,
        tenant_id TEXT DEFAULT 'default',
        decision TEXT NOT NULL,
        participants TEXT NOT NULL,
        votes TEXT,
        result TEXT,
        reasoning TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      )
    `);

    // Project Artifacts Table (with tenant_id for multi-tenant isolation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT DEFAULT 'default',
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        version TEXT DEFAULT '1.0.0',
        created_by TEXT NOT NULL,
        modified_by TEXT NOT NULL,
        size INTEGER,
        checksum TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        modified_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Agent Registrations — canonical table (replaces shared_memory agent_registration blobs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registrations (
        agent_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        capabilities_json TEXT DEFAULT '[]',
        endpoint TEXT,
        metadata_json TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        registered_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent_id, tenant_id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_registrations_tenant
        ON agent_registrations(tenant_id, status)
    `);

    // Agent Identity Changes — canonical table (replaces shared_memory agent_identity blobs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_identity_changes (
        id TEXT PRIMARY KEY,
        previous_agent_id TEXT NOT NULL,
        updated_agent_id TEXT NOT NULL,
        updated_name TEXT,
        capabilities_json TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        updated_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_identity_prev
        ON agent_identity_changes(previous_agent_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_identity_updated
        ON agent_identity_changes(updated_agent_id)
    `);

    // Migrate legacy shared_memory agent_registration rows
    migrateAgentRegistrations(this.db);

    // Session Handoffs Table — stores flag_for_next_session per project
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_handoffs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        summary TEXT NOT NULL,
        open_items_json TEXT,
        created_at DATETIME NOT NULL DEFAULT (datetime('now')),
        consumed_at DATETIME NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_confirmed DATETIME NULL
      )
    `);

    // Partial unique index: exactly one active handoff per project
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_handoffs_active
        ON session_handoffs(project_id) WHERE active = 1
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_handoffs_project
        ON session_handoffs(project_id, created_at DESC)
    `);

    // Neural Audit Log — tracks all write operations with content hashing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS neural_audit_log (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        entity_name TEXT,
        content_hash TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0,
        flag_reason TEXT,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_agent
        ON neural_audit_log(agent_id, created_at DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_flagged
        ON neural_audit_log(flagged) WHERE flagged = 1
    `);

    // Data Trash — durable server-side trash for retired entities (Phase 2b).
    // Holds the logical backup so every hard-delete is recoverable by trashId.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_trash (
        trash_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        retired_at DATETIME NOT NULL DEFAULT (datetime('now')),
        reason TEXT,
        entity_names TEXT NOT NULL,
        counts TEXT NOT NULL,
        backup TEXT NOT NULL,
        restored_at DATETIME
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_data_trash_tenant
        ON data_trash(tenant_id, retired_at DESC)
    `);

    // Legacy-named tombstone table retained to avoid a production migration.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failed_weaviate_deletes (
        id TEXT PRIMARY KEY,
        weaviate_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        last_error TEXT
      )
    `);

    // Deterministic graph lookup index. This avoids scanning every entity,
    // observation, and relation when agents ask for exact project context.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_lookup_keys (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        lookup_key TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        key_kind TEXT NOT NULL DEFAULT 'derived',
        weight REAL NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, lookup_key, memory_type, memory_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_identities (
        identity_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        display_name TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'unknown',
        lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'active',
        resolution_status TEXT NOT NULL DEFAULT 'unresolved',
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        source_audit_id TEXT,
        superseded_by TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT,
        deactivated_at TEXT,
        deactivated_by TEXT,
        metadata_json TEXT
      )
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_identities_active_canonical
        ON entity_identities(tenant_id, canonical_key, entity_type)
        WHERE status='active'
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_identities_lifecycle
        ON entity_identities(tenant_id, lifecycle_status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_identities_status
        ON entity_identities(status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_identities_audit
        ON entity_identities(tenant_id, source_audit_id)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_context_facets (
        facet_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        identity_id TEXT,
        source_row_id TEXT NOT NULL,
        facet_type TEXT NOT NULL,
        title TEXT,
        content_hash TEXT NOT NULL,
        content_json TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        status TEXT NOT NULL DEFAULT 'active',
        source_audit_id TEXT,
        provenance_json TEXT,
        created_at TEXT NOT NULL,
        deactivated_at TEXT,
        deactivated_by TEXT
      )
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facets_active_source_hash
        ON entity_context_facets(tenant_id, source_row_id, content_hash)
        WHERE status='active'
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facets_identity
        ON entity_context_facets(identity_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facets_source_row
        ON entity_context_facets(source_row_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facets_tenant_type
        ON entity_context_facets(tenant_id, facet_type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facets_content_hash
        ON entity_context_facets(content_hash)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facets_audit
        ON entity_context_facets(tenant_id, source_audit_id)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_lookup_identity_links (
        link_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        lookup_key TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        key_kind TEXT,
        identity_id TEXT NOT NULL,
        resolution_status TEXT NOT NULL DEFAULT 'resolved',
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        status TEXT NOT NULL DEFAULT 'active',
        source_audit_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT,
        deactivated_at TEXT,
        deactivated_by TEXT
      )
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_lookup_links_active_identity
        ON entity_lookup_identity_links(tenant_id, lookup_key, memory_type, memory_id, identity_id)
        WHERE status='active'
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_lookup_links_one_resolved
        ON entity_lookup_identity_links(tenant_id, lookup_key, memory_type, memory_id)
        WHERE status='active' AND resolution_status='resolved'
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_lookup_links_lookup
        ON entity_lookup_identity_links(tenant_id, lookup_key, memory_type, status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_lookup_links_identity
        ON entity_lookup_identity_links(tenant_id, identity_id, status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_lookup_links_source_row
        ON entity_lookup_identity_links(tenant_id, memory_type, memory_id, status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_lookup_links_audit
        ON entity_lookup_identity_links(tenant_id, source_audit_id)
    `);

    // Idempotent ALTER: add mutation audit columns to neural_audit_log
    try {
      const auditCols = this.db.prepare('PRAGMA table_info(neural_audit_log)').all() as any[];
      const auditColNames = auditCols.map((c: any) => c.name);
      if (!auditColNames.includes('tenant_id')) {
        this.db.exec("ALTER TABLE neural_audit_log ADD COLUMN tenant_id TEXT DEFAULT 'default'");
      }
      if (!auditColNames.includes('actor_type')) {
        this.db.exec("ALTER TABLE neural_audit_log ADD COLUMN actor_type TEXT");
      }
      if (!auditColNames.includes('actor_id')) {
        this.db.exec("ALTER TABLE neural_audit_log ADD COLUMN actor_id TEXT");
      }
      if (!auditColNames.includes('target_count')) {
        this.db.exec("ALTER TABLE neural_audit_log ADD COLUMN target_count INTEGER");
      }
      if (!auditColNames.includes('reason')) {
        this.db.exec("ALTER TABLE neural_audit_log ADD COLUMN reason TEXT");
      }
    } catch { /* ok — table may not exist yet at this point */ }

    // Core messaging table. Created here (not only via the standalone
    // migrations/001 script, which is never invoked at startup) so a fresh
    // database has ai_messages BEFORE the Phase B / tenant-column migrations
    // below try to ALTER it. Without this, migrateUsersAndTenantColumns throws
    // "no such table: ai_messages" on a fresh DB and aborts — leaving the
    // bootstrap user and session_handoffs.tenant_id uncreated. Legacy data
    // migration from shared_memory still lives in migrations/001.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        legacy_shared_memory_id TEXT UNIQUE,
        from_agent TEXT NOT NULL,
        from_source TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'info',
        priority TEXT DEFAULT 'normal',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        delivered_at DATETIME,
        read_at DATETIME,
        superseded_by TEXT,
        superseded_at DATETIME,
        metadata TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_to ON ai_messages(to_agent, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_from ON ai_messages(from_agent, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_type ON ai_messages(to_agent, message_type)`);

    // Phase B: Add trusted provenance columns to shared_memory and ai_messages
    try {
      const smCols = this.db.prepare('PRAGMA table_info(shared_memory)').all() as any[];
      const smColNames = smCols.map((c: any) => c.name);
      if (!smColNames.includes('owner_actor_type')) {
        this.db.exec('ALTER TABLE shared_memory ADD COLUMN owner_actor_type TEXT');
      }
      if (!smColNames.includes('owner_actor_id')) {
        this.db.exec('ALTER TABLE shared_memory ADD COLUMN owner_actor_id TEXT');
      }
    } catch { /* ok — table may not exist yet */ }

    try {
      const amCols = this.db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
      const amColNames = amCols.map((c: any) => c.name);
      if (!amColNames.includes('from_actor_type')) {
        this.db.exec('ALTER TABLE ai_messages ADD COLUMN from_actor_type TEXT');
      }
      if (!amColNames.includes('from_actor_id')) {
        this.db.exec('ALTER TABLE ai_messages ADD COLUMN from_actor_id TEXT');
      }
    } catch { /* ok — table may not exist yet (pre-migration) */ }

    // Migration: Add tenant_id column to existing tables if missing BEFORE creating tenant indexes
    migrateAddTenantColumn(this.db);

    // Migration 002: Users table + tenant_id/user_id on ai_messages & session_handoffs
    this.migrateUsersAndTenantColumns();

    // Additive message supersession columns depend on tenant_id, archived_at,
    // and read_at being available on upgraded databases.
    ensureArchivedAtColumnImpl(this.db);
    ensureReadAtColumnImpl(this.db);
    ensureMessageSupersessionColumnsImpl(this.db);
    ensureMessageDeliveryColumnImpl(this.db);

    // Create indexes after migrations to avoid referencing missing columns on older databases
    createIndexes(this.db);
    this.backfillGraphLookupIndexIfEmpty();

    console.log('🧠 Memory database initialized');
  }

  private migrateUsersAndTenantColumns(): void {
    try {
      // ─── Users table ───
      this.db.exec(`
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
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`);

      // ─── tenant_memberships (canonical membership model) ───
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_memberships (
          user_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now')),
          UNIQUE (tenant_id, user_id)
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships(user_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_role ON tenant_memberships(tenant_id, role)`);

      // ─── Add tenant_id + user_id to ai_messages if missing ───
      const aiCols = this.db.prepare('PRAGMA table_info(ai_messages)').all() as any[];
      const aiColNames = aiCols.map((c: any) => c.name);

      if (!aiColNames.includes('tenant_id')) {
        this.db.exec(`ALTER TABLE ai_messages ADD COLUMN tenant_id TEXT DEFAULT 'default'`);
        this.db.exec(`UPDATE ai_messages SET tenant_id = 'default' WHERE tenant_id IS NULL`);
        console.log('🔧 Migration 002: Added tenant_id to ai_messages');
      }
      if (!aiColNames.includes('user_id')) {
        this.db.exec(`ALTER TABLE ai_messages ADD COLUMN user_id TEXT`);
        console.log('🔧 Migration 002: Added user_id to ai_messages');
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_tenant ON ai_messages(tenant_id)`);

      // ─── Add tenant_id + user_id to session_handoffs if missing ───
      const shCols = this.db.prepare('PRAGMA table_info(session_handoffs)').all() as any[];
      const shColNames = shCols.map((c: any) => c.name);

      if (!shColNames.includes('tenant_id')) {
        this.db.exec(`ALTER TABLE session_handoffs ADD COLUMN tenant_id TEXT DEFAULT 'default'`);
        this.db.exec(`UPDATE session_handoffs SET tenant_id = 'default' WHERE tenant_id IS NULL`);
        console.log('🔧 Migration 002: Added tenant_id to session_handoffs');
      }
      if (!shColNames.includes('user_id')) {
        this.db.exec(`ALTER TABLE session_handoffs ADD COLUMN user_id TEXT`);
        console.log('🔧 Migration 002: Added user_id to session_handoffs');
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant ON session_handoffs(tenant_id)`);

      // ─── Update session_handoffs unique index to (tenant_id, project_id) ───
      // Check if the old global index exists and replace it
      const indexes = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_session_handoffs_active'`
      ).get() as any;

      if (indexes && indexes.sql && !indexes.sql.includes('tenant_id')) {
        // Old index is project_id-only — drop and recreate
        this.db.exec(`DROP INDEX idx_session_handoffs_active`);
        this.db.exec(`
          CREATE UNIQUE INDEX idx_session_handoffs_active
            ON session_handoffs(tenant_id, project_id) WHERE active = 1
        `);
        console.log('🔧 Migration 002: Updated session_handoffs unique index to (tenant_id, project_id)');
      } else if (!indexes) {
        // Index doesn't exist at all — create it
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_session_handoffs_active
            ON session_handoffs(tenant_id, project_id) WHERE active = 1
        `);
      }

      // ─── Bootstrap user 'tommy' ───
      const existingUser = this.db.prepare(`SELECT id FROM users WHERE id = 'tommy'`).get();
      if (!existingUser) {
        this.db.prepare(`
          INSERT INTO users (id, tenant_id, display_name, timezone, locale, date_format, units, working_hours)
          VALUES ('tommy', 'default', 'Tommy', 'America/Chicago', 'en-US', 'YYYY-MM-DD', 'metric', '{"start":"09:00","end":"17:00"}')
        `).run();
        console.log('🔧 Migration 002: Bootstrap user "tommy" created');
      }

      // ─── Bootstrap membership (tommy, default, owner) ───
      const existingMembership = this.db.prepare(
        `SELECT user_id FROM tenant_memberships WHERE user_id = 'tommy' AND tenant_id = 'default'`
      ).get();
      if (!existingMembership) {
        this.db.prepare(`
          INSERT INTO tenant_memberships (user_id, tenant_id, role)
          VALUES ('tommy', 'default', 'owner')
        `).run();
        console.log('🔧 Migration 002: Bootstrap membership (tommy, default, owner) created');
      }

    } catch (error) {
      console.warn('⚠️ Migration 002 (users + tenant columns) encountered an issue:', error);
    }

    // Composite index for read path — created after migrations to guarantee columns exist
    try {
      this.ensureReadAtColumn();
      this.ensureArchivedAtColumn();
      this.ensureSummaryColumn();
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_messages_read_path ON ai_messages(tenant_id, to_agent, archived_at, read_at, created_at DESC)`);
      // Backfill NULL summaries for existing rows
      const nullCount = (this.db.prepare(
        `SELECT COUNT(*) as cnt FROM ai_messages WHERE summary IS NULL AND content IS NOT NULL`
      ).get() as any)?.cnt ?? 0;
      if (nullCount > 0) {
        const rows = this.db.prepare(
          `SELECT id, content FROM ai_messages WHERE summary IS NULL AND content IS NOT NULL`
        ).all() as any[];
        const updateStmt = this.db.prepare(`UPDATE ai_messages SET summary = ? WHERE id = ?`);
        for (const row of rows) {
          updateStmt.run(MemoryManager.generateSummary(row.content), row.id);
        }
        console.log(`📋 Backfilled summaries for ${rows.length} existing messages`);
      }
    } catch {
      // ai_messages table may not exist yet
    }
  }

  private loadMemoryFromDatabase(): void {
    // Load individual memory with tenant-scoped composite cache keys
    const individualStmt = this.db.prepare(`
      SELECT agent_id, COALESCE(tenant_id, 'default') as tenant_id, memory_type, content, importance, tags, created_at, updated_at
      FROM individual_memory
      ORDER BY agent_id, importance DESC
    `);

    const individualRows = individualStmt.all() as any[];
    // Group by composite key tenantId:agentId for tenant isolation
    const agentGroups = new Map<string, { agentId: string; rows: any[] }>();

    for (const row of individualRows) {
      const tenantId = row.tenant_id || 'default';
      const agentId = row.agent_id;
      const cacheKey = `${tenantId}:${agentId}`;
      if (!agentGroups.has(cacheKey)) {
        agentGroups.set(cacheKey, { agentId, rows: [] });
      }
      agentGroups.get(cacheKey)!.rows.push(row);
    }

    for (const [cacheKey, { agentId, rows }] of agentGroups) {
      const memory: IndividualMemory = {
        agentId,
        preferences: {} as AgentPreferences,
        learnings: [],
        privateContext: [],
        capabilities: []
      };

      for (const row of rows) {
        const content = JSON.parse((row as any).content);
        switch ((row as any).memory_type) {
          case 'preferences':
            memory.preferences = content;
            break;
          case 'learning':
            memory.learnings.push(content);
            break;
          case 'private_context':
            memory.privateContext.push(content);
            break;
          case 'capabilities':
            memory.capabilities.push(content);
            break;
        }
      }

      this.memorySystem.individual.set(cacheKey, memory);
    }

    // Load shared memory
    this.loadSharedMemoryFromDatabase();

    console.log(`🧠 Loaded memory for ${this.memorySystem.individual.size} agents`);
  }

  private loadSharedMemoryFromDatabase(): void {
    // Load tasks from dedicated tasks table
    const tasksStmt = this.db.prepare('SELECT * FROM tasks');
    const taskRows = tasksStmt.all() as any[];
    
    for (const row of taskRows) {
      const taskRow = row as any;
      const task: Task = {
        id: taskRow.id,
        title: taskRow.title,
        description: taskRow.description,
        requirements: taskRow.requirements ? JSON.parse(taskRow.requirements) : {},
        status: taskRow.status,
        priority: taskRow.priority,
        estimatedEffort: taskRow.estimated_effort,
        actualEffort: taskRow.actual_effort,
        createdBy: taskRow.created_by,
        assignedTo: taskRow.assigned_to,
        createdAt: new Date(taskRow.created_at),
        updatedAt: new Date(taskRow.updated_at),
        completedAt: taskRow.completed_at ? new Date(taskRow.completed_at) : undefined,
        parentTaskId: taskRow.parent_task_id || undefined,
        childTaskIds: []
      };

      this.memorySystem.shared.tasks.tasks.set(task.id, task);
      
      if (task.assignedTo) {
        this.memorySystem.shared.tasks.assignments.set(task.id, task.assignedTo);
      }
    }
    
    // Load tasks from shared_memory table (new API storage pattern)
    const sharedTasksStmt = this.db.prepare('SELECT * FROM shared_memory WHERE memory_type = ?');
    const sharedTaskRows = sharedTasksStmt.all('task') as any[];
    
    for (const row of sharedTaskRows) {
      try {
        const taskData = JSON.parse(row.content);
        const task: Task = {
          id: taskData.id || row.id,
          title: taskData.title || 'Untitled Task',
          description: taskData.description || '',
          requirements: taskData.requirements || {},
          status: taskData.status || TaskStatus.CREATED,
          priority: taskData.priority || 'medium',
          estimatedEffort: taskData.estimatedEffort || 1,
          actualEffort: taskData.actualEffort,
          createdBy: row.created_by,
          assignedTo: taskData.assignedTo,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
          completedAt: taskData.completedAt ? new Date(taskData.completedAt) : undefined,
          parentTaskId: taskData.parentTaskId,
          childTaskIds: taskData.childTaskIds || []
        };

        this.memorySystem.shared.tasks.tasks.set(task.id, task);
        
        if (task.assignedTo) {
          this.memorySystem.shared.tasks.assignments.set(task.id, task.assignedTo);
        }
      } catch (parseError) {
        console.warn(`Failed to parse task from shared_memory: ${row.id}`, parseError);
      }
    }

    // Load shared knowledge from dedicated shared_knowledge table
    const knowledgeStmt = this.db.prepare('SELECT * FROM shared_knowledge');
    const knowledgeRows = knowledgeStmt.all() as any[];
    
    this.memorySystem.shared.knowledge = knowledgeRows.map(row => {
      const knowledgeRow = row as any;
      return {
        id: knowledgeRow.id,
        title: knowledgeRow.title,
        content: knowledgeRow.content,
        type: knowledgeRow.type,
        tags: knowledgeRow.tags ? JSON.parse(knowledgeRow.tags) : [],
        source: knowledgeRow.source,
        confidence: knowledgeRow.confidence,
        verifications: knowledgeRow.verifications ? JSON.parse(knowledgeRow.verifications) : [],
        createdAt: new Date(knowledgeRow.created_at),
        updatedAt: new Date(knowledgeRow.updated_at)
      };
    });
    
    // Load knowledge from shared_memory table (new API storage pattern)
    const sharedKnowledgeStmt = this.db.prepare('SELECT * FROM shared_memory WHERE memory_type = ?');
    const sharedKnowledgeRows = sharedKnowledgeStmt.all('knowledge') as any[];
    
    for (const row of sharedKnowledgeRows) {
      try {
        const knowledgeData = JSON.parse(row.content);
        const knowledge = {
          id: row.id,
          title: knowledgeData.title || 'Untitled Knowledge',
          content: knowledgeData.content || '',
          type: knowledgeData.type || 'fact',
          tags: knowledgeData.tags || [],
          source: row.created_by,
          confidence: knowledgeData.confidence || 0.5,
          verifications: knowledgeData.verifications || [],
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at)
        };

        this.memorySystem.shared.knowledge.push(knowledge);
      } catch (parseError) {
        console.warn(`Failed to parse knowledge from shared_memory: ${row.id}`, parseError);
      }
    }

    // Load consensus history
    const consensusStmt = this.db.prepare('SELECT * FROM consensus_history');
    const consensusRows = consensusStmt.all() as any[];
    
    this.memorySystem.shared.decisions = consensusRows.map(row => {
      const consensusRow = row as any;
      return {
        id: consensusRow.id,
        decision: consensusRow.decision,
        participants: JSON.parse(consensusRow.participants),
        votes: new Map(Object.entries(consensusRow.votes ? JSON.parse(consensusRow.votes) : {})),
        result: consensusRow.result ? JSON.parse(consensusRow.result) : {},
        reasoning: consensusRow.reasoning,
        createdAt: new Date(consensusRow.created_at),
        resolvedAt: consensusRow.resolved_at ? new Date(consensusRow.resolved_at) : undefined
      };
    });

    // Load project artifacts
    const artifactsStmt = this.db.prepare('SELECT * FROM project_artifacts');
    const artifactRows = artifactsStmt.all() as any[];
    
    this.memorySystem.shared.artifacts = artifactRows.map(row => {
      const artifactRow = row as any;
      return {
        id: artifactRow.id,
        name: artifactRow.name,
        type: artifactRow.type,
        path: artifactRow.path,
        version: artifactRow.version,
        createdBy: artifactRow.created_by,
        modifiedBy: artifactRow.modified_by,
        size: artifactRow.size,
        checksum: artifactRow.checksum,
        metadata: artifactRow.metadata ? JSON.parse(artifactRow.metadata) : {},
        createdAt: new Date(artifactRow.created_at),
        modifiedAt: new Date(artifactRow.modified_at)
      };
    });
  }

  async store(agentId: string, memory: any, scope: 'individual' | 'shared', type: string, tenantId: string = 'default', context?: RequestContext): Promise<string> {
    const id = uuidv4();

    // 1. Store in SQLite (primary storage)
    if (scope === 'individual') {
      const stmt = this.db.prepare(`
        INSERT INTO individual_memory (id, agent_id, tenant_id, memory_type, content, importance, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        agentId,
        tenantId,
        type,
        JSON.stringify(memory),
        (memory && memory.importance) || 0.5,
        JSON.stringify((memory && memory.tags) || [])
      );

      // Update in-memory cache (tenant-scoped cache key: tenantId:agentId)
      const cacheKey = `${tenantId}:${agentId}`;
      if (!this.memorySystem.individual.has(cacheKey)) {
        this.memorySystem.individual.set(cacheKey, {
          agentId,
          preferences: {} as AgentPreferences,
          learnings: [],
          privateContext: [],
          capabilities: []
        });
      }

      const agentMemory = this.memorySystem.individual.get(cacheKey)!;
      switch (type) {
        case 'preferences':
          agentMemory.preferences = memory;
          break;
        case 'learning':
          agentMemory.learnings.push(memory);
          break;
        case 'private_context':
          agentMemory.privateContext.push(memory);
          break;
        case 'capabilities':
          agentMemory.capabilities.push(memory);
          break;
      }
      
    } else {
      const ownerActorType = context?.authType || null;
      const ownerActorId = (context?.userId || context?.apiKeyId || null);
      const stmt = this.db.prepare(`
        INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags, owner_actor_type, owner_actor_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        tenantId,
        type,
        JSON.stringify(memory || {}),
        agentId,
        JSON.stringify((memory && memory.tags) || []),
        ownerActorType,
        ownerActorId
      );

      if (this.isGraphMemoryType(type)) {
        this.refreshGraphLookupIndexForMemory(id, tenantId, type, memory || {});
      }

      // DUAL-WRITE SHIM: Also write to canonical tables when enabled
      if (this.isDualWriteEnabled && memory) {
        await this.dualWriteToCanonical(id, agentId, memory, type);
      }

      // Update shared memory cache based on type
      if (memory) {
        switch (type) {
          case 'knowledge':
            this.memorySystem.shared.knowledge.push(memory);
            break;
          case 'task':
            if (memory.id) {
              this.memorySystem.shared.tasks.tasks.set(memory.id, memory);
            }
            break;
          case 'artifact':
            this.memorySystem.shared.artifacts.push(memory);
            break;
        }
      }
    }

    // Direct-message payloads are private mailbox data, never part of the
    // shared semantic corpus. `message_detail` is retained only as a legacy
    // read representation for messages written before the dedicated table
    // stored full bodies.
    if (this.isAdvancedSystemsEnabled && !this.isConfidentialGraphRow(type, memory, tenantId)) {
      await this.storeInAdvancedSystems(id, agentId, memory, scope, type, tenantId);
    }

    console.log(`💾 Stored ${scope} memory (${type}) for agent ${agentId}${this.isAdvancedSystemsEnabled ? ' [Multi-DB]' : ' [SQLite]'}`);
    return id;
  }

  private async storeInAdvancedSystems(id: string, agentId: string, memory: any, scope: string, type: string, tenantId: string = 'default'): Promise<void> {
    try {
      // Store in embedded vector index for semantic search (tenant-scoped).
      if (this.vectorClient) {
        await this.vectorClient.storeMemory({
          id,
          agentId,
          tenantId,
          type: type as any,
          content: typeof memory === 'string' ? memory : JSON.stringify(memory),
          timestamp: Date.now(),
          tags: memory?.tags || [],
          priority: Math.round((memory?.importance || 0.5) * 10),
          relationships: [],
          metadata: memory?.metadata || {}
        });
      }

    } catch (error) {
      console.warn('⚠️ Failed to store in advanced systems:', error);
    }
  }

  /**
   * DUAL-WRITE SHIM: Write to canonical tables (tasks, shared_knowledge)
   * This enables gradual migration from shared_memory to canonical tables.
   * Gate: DUAL_WRITE_ENABLED=true environment variable
   */
  private async dualWriteToCanonical(id: string, agentId: string, memory: any, type: string): Promise<void> {
    try {
      if (type === 'task') {
        // Write to canonical tasks table
        const taskId = memory.id || id;
        const existsStmt = this.db.prepare('SELECT id FROM tasks WHERE id = ?');
        const existing = existsStmt.get(taskId);

        if (existing) {
          // Update existing task
          const updateStmt = this.db.prepare(`
            UPDATE tasks SET
              title = ?,
              description = ?,
              requirements = ?,
              status = ?,
              priority = ?,
              estimated_effort = ?,
              actual_effort = ?,
              assigned_to = ?,
              updated_at = CURRENT_TIMESTAMP,
              completed_at = ?
            WHERE id = ?
          `);
          updateStmt.run(
            memory.title || 'Untitled Task',
            memory.description || '',
            JSON.stringify(memory.requirements || {}),
            memory.status || 'created',
            memory.priority || 'medium',
            memory.estimatedEffort || null,
            memory.actualEffort || null,
            memory.assignedTo || null,
            memory.completedAt || null,
            taskId
          );
          console.log(`🔀 [DUAL-WRITE] Updated task in canonical table: ${taskId}`);
        } else {
          // Insert new task
          const insertStmt = this.db.prepare(`
            INSERT INTO tasks (
              id, parent_task_id, title, description, requirements,
              status, priority, estimated_effort, actual_effort,
              created_by, assigned_to, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          insertStmt.run(
            taskId,
            memory.parentTaskId || null,
            memory.title || 'Untitled Task',
            memory.description || '',
            JSON.stringify(memory.requirements || {}),
            memory.status || 'created',
            memory.priority || 'medium',
            memory.estimatedEffort || null,
            memory.actualEffort || null,
            agentId,
            memory.assignedTo || null,
            memory.completedAt || null
          );
          console.log(`🔀 [DUAL-WRITE] Inserted task into canonical table: ${taskId}`);
        }

      } else if (type === 'knowledge') {
        // Write to canonical shared_knowledge table
        const knowledgeId = memory.id || id;
        const existsStmt = this.db.prepare('SELECT id FROM shared_knowledge WHERE id = ?');
        const existing = existsStmt.get(knowledgeId);

        if (existing) {
          // Update existing knowledge
          const updateStmt = this.db.prepare(`
            UPDATE shared_knowledge SET
              title = ?,
              content = ?,
              type = ?,
              tags = ?,
              confidence = ?,
              verifications = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `);
          updateStmt.run(
            memory.title || 'Untitled Knowledge',
            typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content || ''),
            memory.type || 'fact',
            JSON.stringify(memory.tags || []),
            memory.confidence || 0.5,
            JSON.stringify(memory.verifications || []),
            knowledgeId
          );
          console.log(`🔀 [DUAL-WRITE] Updated knowledge in canonical table: ${knowledgeId}`);
        } else {
          // Insert new knowledge
          const insertStmt = this.db.prepare(`
            INSERT INTO shared_knowledge (
              id, title, content, type, tags, source, confidence, verifications
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          insertStmt.run(
            knowledgeId,
            memory.title || 'Untitled Knowledge',
            typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content || ''),
            memory.type || 'fact',
            JSON.stringify(memory.tags || []),
            memory.source || agentId,
            memory.confidence || 0.5,
            JSON.stringify(memory.verifications || [])
          );
          console.log(`🔀 [DUAL-WRITE] Inserted knowledge into canonical table: ${knowledgeId}`);
        }
      }
      // Other types (artifact, etc.) are not dual-written - only task and knowledge
      recordDualWriteResult(true);
    } catch (error) {
      console.error(`⚠️ [DUAL-WRITE] Failed to write to canonical table:`, error);
      recordDualWriteResult(false);
      // Don't throw - dual-write failures shouldn't break primary storage
    }
  }

  async retrieve(query: MemoryQuery, scope: MemoryScope): Promise<any[]> {
    const results: any[] = [];

    if (scope.individual && query.agentId) {
      const agentMemory = this.memorySystem.individual.get(query.agentId);
      if (agentMemory) {
        results.push(agentMemory);
      }
    }

    if (scope.shared) {
      // Always include shared memory when scope includes shared
      const tasks = Array.from(this.memorySystem.shared.tasks.tasks.values());
      results.push(...tasks);
      results.push(...this.memorySystem.shared.knowledge);
      results.push(...this.memorySystem.shared.artifacts);
    }

    return results.slice(0, query.limit || 100);
  }

  async update(id: string, updates: any, scope: 'individual' | 'shared'): Promise<void> {
    if (scope === 'individual') {
      const stmt = this.db.prepare(`
        UPDATE individual_memory 
        SET content = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `);
      stmt.run(JSON.stringify(updates), id);
    } else {
      const stmt = this.db.prepare(`
        UPDATE shared_memory 
        SET content = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `);
      stmt.run(JSON.stringify(updates), id);
    }

    console.log(`🔄 Updated ${scope} memory: ${id}`);
  }

  /**
   * Update delivery status for a message in ai_messages table.
   * Merges the new status into the existing metadata JSON column.
   */
  async updateMessageStatus(messageId: string, deliveryStatus: string): Promise<void> {
    try {
      this.ensureMessageDeliveryColumn();
      const row = this.db.prepare('SELECT metadata FROM ai_messages WHERE id = ?').get(messageId) as any;
      if (!row) {
        console.warn(`⚠️ updateMessageStatus: message ${messageId} not found in ai_messages`);
        return;
      }
      const metadata = row.metadata ? JSON.parse(row.metadata) : {};
      metadata.deliveryStatus = deliveryStatus;
      const now = new Date().toISOString();
      if (deliveryStatus === 'delivered' || deliveryStatus === 'read') {
        metadata.deliveredAt = metadata.deliveredAt || now;
        this.db.prepare(
          'UPDATE ai_messages SET metadata = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?'
        ).run(JSON.stringify(metadata), now, messageId);
      } else {
        this.db.prepare('UPDATE ai_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
      }
    } catch (err: any) {
      if (err.message?.includes('no such table')) {
        console.warn('⚠️ updateMessageStatus: ai_messages table not found, skipping');
        return;
      }
      throw err;
    }
  }

  async share(fromAgent: string, toAgent: string, memory: any): Promise<void> {
    // Create a shared knowledge entry
    const sharedKnowledge: SharedKnowledge = {
      id: uuidv4(),
      title: `Shared from ${fromAgent}`,
      content: JSON.stringify(memory),
      type: 'lesson-learned',
      tags: ['shared', fromAgent],
      source: fromAgent,
      confidence: 0.8,
      verifications: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.store(fromAgent, sharedKnowledge, 'shared', 'knowledge');
    console.log(`🤝 Shared memory from ${fromAgent} to ${toAgent}`);
  }

  async search(query: string, scope: MemoryScope | string, tenantId: string = 'default', options?: { limit?: number }): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const searchTerm = query.toLowerCase();
    const queryLimit = options?.limit ?? 50;

    // Handle scope parameter - convert string to MemoryScope object
    let searchScope: MemoryScope;
    if (typeof scope === 'string') {
      switch (scope) {
        case 'individual':
          searchScope = { individual: true, shared: false };
          break;
        case 'shared':
          searchScope = { shared: true, individual: false };
          break;
        case 'all':
        default:
          searchScope = { shared: true, individual: true };
          break;
      }
    } else {
      searchScope = scope;
    }

    // 2. Enhanced search with advanced systems (tenant-scoped)
    if (this.isAdvancedSystemsEnabled) {
      await this.searchInAdvancedSystems(query, searchScope, results, tenantId, queryLimit);
    }

    // NOTE: In-memory caches (memorySystem.individual) are NOT tenant-scoped.
    // All search uses SQL paths below which ARE tenant-scoped.
    if (searchScope.individual) {
      // Search individual_memory table directly (tenant-scoped)
      try {
        const individualStmt = this.db.prepare(`
          SELECT id, agent_id, memory_type, content, importance, created_at
          FROM individual_memory
          WHERE tenant_id = ? AND LOWER(content) LIKE ?
          ORDER BY importance DESC
          LIMIT ?
        `);

        const individualRows = individualStmt.all(tenantId, `%${searchTerm}%`, queryLimit) as any[];
        
        for (const row of individualRows) {
          try {
            const content = JSON.parse(row.content);
              results.push({
                id: row.id,
                type: 'individual',
                content: content,
                relevance: row.importance || 0.5,
                source: row.agent_id,
                timestamp: new Date(row.created_at),
                memoryType: row.memory_type
              });
            } catch (parseError) {
              // If JSON parse fails, include raw content
              results.push({
                id: row.id,
                type: 'individual',
                content: { raw: row.content, type: row.memory_type },
                relevance: row.importance || 0.5,
                source: row.agent_id,
                timestamp: new Date(row.created_at),
                memoryType: row.memory_type
              });
            }
          }
        } catch (dbError) {
        console.warn('🔍 Database search error for individual memory:', dbError);
      }
    }

    if (searchScope.shared) {
      // NOTE: In-memory caches (memorySystem.shared.knowledge, tasks) are NOT tenant-scoped.
      // All search uses SQL paths below which ARE tenant-scoped.

      // Search shared_memory table with smart chunking for large content (tenant-scoped)
      try {
        // Phase 1: Query with content size to identify large rows
        const sizeStmt = this.db.prepare(`
          SELECT id, memory_type, LENGTH(content) as content_size, created_by, created_at,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.name') END AS probe_name,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.aliases') END AS probe_aliases,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.entityName') END AS probe_entity_name,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.metadata.entityId') END AS probe_entity_id,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.from') END AS probe_from,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.to') END AS probe_to,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.type') END AS probe_type,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.entityType') END AS probe_entity_type,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.memoryType') END AS probe_memory_type,
            CASE WHEN json_valid(content) THEN json_extract(content, '$.memory_type') END AS probe_memory_type_legacy,
            CASE WHEN json_valid(content)
              THEN CASE WHEN json_type(content) = 'object' THEN 1 ELSE 0 END
              ELSE 0
            END AS probe_json_object
          FROM shared_memory
          WHERE tenant_id = ?
            AND LOWER(memory_type) NOT IN ('ai_message', 'message_detail')
            AND NOT (
              json_valid(content)
              AND (
                LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
                OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
                OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
                OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
              )
            )
            AND LOWER(content) LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `);
        const sizeRows = sizeStmt.all(tenantId, `%${searchTerm}%`, queryLimit) as any[];

        // Classify graph rows before any lossy preview is constructed. For an
        // oversized JSON row the first 50 KiB is normally incomplete; parsing
        // that preview falls back to { raw }, which erases entityName,
        // metadata.entityId, from/to, and reserved entity aliases. The compact
        // JSON extracts above retain exactly the fields needed by the central
        // confidentiality policy without loading the full large body.
        const parseProbeAliases = (value: unknown): unknown[] => {
          if (Array.isArray(value)) return value;
          if (typeof value !== 'string') return [];
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        };
        const visibleSizeRows = sizeRows.filter((row) => {
          const normalizedMemoryType = String(row.memory_type || '').trim().toLowerCase();
          if (
            ['entity', 'observation', 'relation'].includes(normalizedMemoryType)
            && row.probe_json_object !== 1
          ) {
            return false;
          }
          const probe = {
            name: row.probe_name,
            aliases: parseProbeAliases(row.probe_aliases),
            entityName: row.probe_entity_name,
            metadata: { entityId: row.probe_entity_id },
            from: row.probe_from,
            to: row.probe_to,
            type: row.probe_type,
            entityType: row.probe_entity_type,
            memoryType: row.probe_memory_type,
            memory_type: row.probe_memory_type_legacy,
          };
          return !this.isConfidentialGraphRow(row.memory_type, probe, tenantId);
        });

        // Phase 2: Fetch full content for small rows, truncated for large rows
        const threshold = this.contentSizeThreshold;
        const smallIds = visibleSizeRows.filter(r => r.content_size <= threshold).map(r => r.id);
        const largeRows = visibleSizeRows.filter(r => r.content_size > threshold);

        // Batch-fetch small rows with full content
        if (smallIds.length > 0) {
          const placeholders = smallIds.map(() => '?').join(',');
          const fullStmt = this.db.prepare(
            `SELECT id, memory_type, content, created_by, created_at FROM shared_memory WHERE id IN (${placeholders})`
          );
          const fullRows = fullStmt.all(...smallIds) as any[];
          for (const row of fullRows) {
            try {
              const content = JSON.parse(row.content);
              results.push({
                id: row.id, type: 'shared', content, relevance: 0.6,
                source: row.created_by, timestamp: new Date(row.created_at),
                memoryType: row.memory_type
              });
            } catch {
              results.push({
                id: row.id, type: 'shared',
                content: { raw: row.content, type: row.memory_type },
                relevance: 0.6, source: row.created_by, timestamp: new Date(row.created_at),
                memoryType: row.memory_type
              });
            }
          }
        }

        // For large rows, return metadata + truncated preview + chunk info
        for (const row of largeRows) {
          const chunkSize = this.contentSizeThreshold;
          const totalChunks = Math.ceil(row.content_size / chunkSize);
          // Fetch only the first chunk as preview
          const previewStmt = this.db.prepare(
            `SELECT SUBSTR(content, 1, ?) as preview, memory_type FROM shared_memory WHERE id = ?`
          );
          const preview = previewStmt.get(chunkSize, row.id) as any;
          let previewContent: any;
          try {
            // Try to parse preview — may be incomplete JSON
            previewContent = JSON.parse(preview?.preview || '{}');
          } catch {
            previewContent = { raw: preview?.preview, type: preview?.memory_type };
          }
          results.push({
            id: row.id, type: 'shared',
            content: previewContent,
            relevance: 0.6, source: row.created_by, timestamp: new Date(row.created_at),
            memoryType: row.memory_type,
            chunked: true, contentSize: row.content_size, totalChunks, chunkSize
          });
        }
      } catch (dbError) {
        console.warn('🔍 Database search error for shared memory:', dbError);
      }
      
      // Search shared_knowledge table directly (tenant-scoped)
      try {
        const knowledgeStmt = this.db.prepare(`
          SELECT id, title, content, type, source, confidence, created_at
          FROM shared_knowledge
          WHERE tenant_id = ? AND (LOWER(title) LIKE ? OR LOWER(content) LIKE ?)
          ORDER BY confidence DESC
          LIMIT ?
        `);

        const knowledgeRows = knowledgeStmt.all(tenantId, `%${searchTerm}%`, `%${searchTerm}%`, queryLimit) as any[];
        
        for (const row of knowledgeRows) {
          results.push({
            id: row.id,
            type: 'shared',
            content: {
              id: row.id,
              title: row.title,
              content: row.content,
              type: row.type,
              source: row.source,
              confidence: row.confidence
            },
            relevance: row.confidence || 0.5,
            source: row.source,
            timestamp: new Date(row.created_at),
            memoryType: 'knowledge'
          });
        }
      } catch (dbError) {
        console.warn('🔍 Database search error for shared knowledge:', dbError);
      }
      
      // Search tasks table directly (tenant-scoped)
      try {
        const tasksStmt = this.db.prepare(`
          SELECT id, title, description, status, created_by, created_at
          FROM tasks
          WHERE tenant_id = ? AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)
          ORDER BY created_at DESC
          LIMIT ?
        `);

        const taskRows = tasksStmt.all(tenantId, `%${searchTerm}%`, `%${searchTerm}%`, queryLimit) as any[];
        
        for (const row of taskRows) {
          results.push({
            id: row.id,
            type: 'shared',
            content: {
              id: row.id,
              title: row.title,
              description: row.description,
              status: row.status,
              createdBy: row.created_by
            },
            relevance: 0.7,
            source: row.created_by,
            timestamp: new Date(row.created_at),
            memoryType: 'task'
          });
        }
      } catch (dbError) {
        console.warn('🔍 Database search error for tasks:', dbError);
      }
    }

    // Remove duplicates based on ID and sort by relevance
    const uniqueResults = new Map<string, SearchResult>();
    for (const result of results) {
      if (this.isConfidentialGraphRow(result.memoryType || result.type, result.content, tenantId)) {
        continue;
      }
      if (!uniqueResults.has(result.id) || uniqueResults.get(result.id)!.relevance < result.relevance) {
        uniqueResults.set(result.id, result);
      }
    }

    const finalResults = Array.from(uniqueResults.values()).sort((a, b) => b.relevance - a.relevance);

    return finalResults;
  }

  private async searchInAdvancedSystems(query: string, scope: MemoryScope, results: SearchResult[], tenantId: string = 'default', limit: number = 50): Promise<void> {
    try {
      // 1. Semantic search with sqlite-vec (post-filtered by tenant)
      if (this.vectorClient && scope.shared) {
        // Search terms may contain private message text or other sensitive user
        // content. Keep operational metadata while excluding the query itself.
        console.log(`🔍 Performing semantic search with sqlite-vec (tenant: ${tenantId}, queryLength: ${query.length})`);
        const vectorResults = await this.vectorClient.searchMemories({
          query,
          tenantId,
          limit,
        });

        for (const wResult of vectorResults) {
          if (this.isConfidentialGraphRow(wResult.type, wResult.content, tenantId)) {
            continue;
          }
          // Propagate the vec0 distance so the caller can rank by semantic
          // similarity. Without this the distance computed in rowToMemoryItem
          // is dropped here, every semantic hit collapses to a flat score, and
          // results fall back to arbitrary order (irrelevant rows float up).
          const distance = (wResult.metadata && typeof (wResult.metadata as any).distance === 'number')
            ? (wResult.metadata as any).distance
            : undefined;
          // vec0 default metric is L2; map to a bounded 0..1 similarity.
          const semanticSimilarity = distance !== undefined ? 1 / (1 + distance) : undefined;
          results.push({
            id: wResult.id,
            type: 'shared',
            content: {
              original: wResult.content,
              tags: wResult.tags,
              agentId: wResult.agentId,
              source: 'sqlite-vec'
            },
            relevance: semanticSimilarity ?? (wResult.priority || 5) / 10,
            source: `sqlite-vec:${wResult.agentId}`,
            timestamp: new Date(wResult.timestamp),
            memoryType: wResult.type,
            ...(distance !== undefined ? { distance, semanticSimilarity } : {}),
          } as SearchResult);
        }
      }


    } catch (error) {
      console.warn('⚠️ Advanced search systems error:', error);
    }
  }

  /**
   * Vector-only retrieval for related-context discovery. Unlike `search()`,
   * this surface does not mix lexical/table matches into the result and does
   * not swallow backend availability or query failures. That lets the caller
   * report semantic degradation honestly while still applying the same
   * tenant and private-graph filters as every other memory read.
   */
  async searchRelatedContextSemantic(
    query: string,
    tenantId: string = 'default',
    limit: number = 30,
  ): Promise<{ results: SearchResult[]; degraded: boolean; reasons: string[] }> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 30), 75));
    if (!this.isAdvancedSystemsEnabled || !this.vectorClient) {
      return {
        results: [],
        degraded: true,
        reasons: ['semantic_backend_unavailable'],
      };
    }

    try {
      const semantic = await this.vectorClient.searchSemanticMemories({
        query,
        tenantId,
        limit: boundedLimit,
      });
      const results: SearchResult[] = [];
      const reasons = new Set(semantic.reasons);
      const backingRow = this.db.prepare(
        `SELECT id, memory_type, content, created_by, created_at
         FROM shared_memory
         WHERE tenant_id = ? AND id = ? AND memory_type IN ('entity', 'observation', 'relation')
         LIMIT 1`,
      );
      for (const vectorResult of semantic.memories) {
        const row = backingRow.get(tenantId, vectorResult.id) as {
          id: string;
          memory_type: string;
          content: string;
          created_by: string;
          created_at: string;
        } | undefined;
        if (!row) {
          reasons.add('semantic_backing_row_missing');
          continue;
        }
        if (String(vectorResult.type).toLowerCase() !== String(row.memory_type).toLowerCase()) {
          reasons.add('semantic_backing_type_mismatch');
          continue;
        }
        if (String(vectorResult.content) !== row.content) {
          reasons.add('semantic_index_backing_mismatch');
          continue;
        }
        if (this.isConfidentialGraphRow(row.memory_type, row.content, tenantId)) {
          reasons.add('semantic_private_row_filtered');
          continue;
        }
        const distance = vectorResult.metadata
          && typeof (vectorResult.metadata as any).distance === 'number'
          ? (vectorResult.metadata as any).distance
          : undefined;
        if (distance === undefined || !Number.isFinite(distance)) {
          reasons.add('semantic_similarity_unavailable');
          continue;
        }
        const semanticSimilarity = 1 / (1 + distance);
        results.push({
          id: row.id,
          type: 'shared',
          content: { original: row.content },
          relevance: semanticSimilarity,
          source: `sqlite-vec:${row.created_by}`,
          timestamp: new Date(row.created_at),
          memoryType: row.memory_type,
          distance,
          semanticSimilarity,
        });
      }
      return {
        results,
        degraded: semantic.degraded || reasons.size > 0,
        reasons: [...reasons].sort(),
      };
    } catch {
      return {
        results: [],
        degraded: true,
        reasons: ['semantic_backend_failed'],
      };
    }
  }

  getMemorySystem(): MemorySystem {
    return this.memorySystem;
  }

  getAgentMemory(agentId: string, tenantId: string = 'default'): IndividualMemory | undefined {
    // Cache key: tenantId:agentId for tenant isolation (no bare agentId fallback)
    const cacheKey = `${tenantId}:${agentId}`;
    return this.memorySystem.individual.get(cacheKey);
  }

  private comparableAgentId(agentId: string): string {
    return String(agentId || '').trim().toLowerCase();
  }

  private normalizeAgentId(agentId: string): string {
    let normalized = this.comparableAgentId(agentId);
    for (const suffix of ['-ide-agent', '-cli']) {
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        normalized = normalized.slice(0, -suffix.length);
        break;
      }
    }
    return normalized;
  }

  private getHeuristicAgentAliases(agentId: string): string[] {
    const comparable = this.comparableAgentId(agentId);
    if (!comparable) return [];

    const normalized = this.normalizeAgentId(comparable);
    return Array.from(new Set([
      comparable,
      normalized,
      `${normalized}-cli`,
      `${normalized}-ide-agent`,
    ].filter(Boolean)));
  }

  public inferCanonicalAgentId(agentId: string, name?: string, metadata: any = {}): string {
    const explicit = metadata?.canonicalAgentId || metadata?.canonical_agent_id || metadata?.canonical;
    if (typeof explicit === 'string' && explicit.trim()) {
      return this.comparableAgentId(explicit);
    }

    const comparable = this.comparableAgentId(agentId);
    const display = this.comparableAgentId(name || '');
    const looksEphemeral = /^agent-(?:.+-)?\d+-[a-z0-9]+(?:-.+)?$/.test(comparable);
    const displayIsUseful = !!display && !display.startsWith('stdio-bridge-');

    if (looksEphemeral && displayIsUseful) {
      return display;
    }

    return this.normalizeAgentId(comparable);
  }

  private parseAgentMetadata(metadataJson?: string | null): any {
    if (!metadataJson) return {};
    try {
      const parsed = JSON.parse(metadataJson);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private isAgentRegistrationLive(metadataJson?: string | null, now: number = Date.now()): boolean {
    const metadata = this.parseAgentMetadata(metadataJson);
    const expiresAt = metadata?.expiresAt || metadata?.expires_at;
    if (typeof expiresAt !== 'string' || !expiresAt.trim()) return true;
    const expiresAtMs = Date.parse(expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs > now;
  }

  private getRegisteredAgentRows(tenantId: string = 'default'): Array<{ agentId: string; name: string; metadataJson: string; updatedAt: string }> {
    try {
      const rows = this.db.prepare(
        `SELECT agent_id as agentId, name, metadata_json as metadataJson, updated_at as updatedAt
         FROM agent_registrations
         WHERE tenant_id = ? AND status = 'active'
         ORDER BY updated_at DESC`
      ).all(tenantId) as Array<{ agentId: string; name: string; metadataJson: string; updatedAt: string }>;

      const now = Date.now();
      return rows.filter((row) => this.isAgentRegistrationLive(row.metadataJson, now));
    } catch {
      return [];
    }
  }

  /**
   * Registration-derived grouping for status and presentation only; mailbox
   * authorization and ENG-4 authorship use resolveMailboxIdentity instead. Historical
   * identity-change rows are an unscoped audit log, not a live alias registry:
   * treating them as an
   * undirected transitive graph permanently joined reused handles and allowed
   * the newest registration heartbeat to change another agent's canonical id.
   */
  private resolveAgentFamily(agentId: string, tenantId: string = 'default'): { aliases: string[]; canonical: string } {
    const requested = this.comparableAgentId(agentId);
    if (!requested) {
      return { aliases: [], canonical: '' };
    }

    const registrations = this.getRegisteredAgentRows(tenantId);
    const normalized = this.normalizeAgentId(requested);
    const aliases = new Set<string>(this.getHeuristicAgentAliases(requested));

    const addAlias = (candidate?: string | null) => {
      const comparable = this.comparableAgentId(candidate || '');
      if (!comparable || aliases.has(comparable)) return;
      aliases.add(comparable);
    };

    for (const row of registrations) {
      const metadata = this.parseAgentMetadata(row.metadataJson);
      const canonical = this.inferCanonicalAgentId(row.agentId, row.name, metadata);
      const rowAliases = [
        row.agentId,
        row.name,
        canonical,
        ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
      ];

      if (
        this.normalizeAgentId(row.agentId) === normalized ||
        this.normalizeAgentId(row.name) === normalized ||
        canonical === normalized ||
        rowAliases.some((alias) => this.getHeuristicAgentAliases(alias).includes(requested))
      ) {
        for (const alias of rowAliases) addAlias(alias);
        addAlias(row.agentId);
      }
    }

    let canonical = requested;
    const aliasList = Array.from(aliases);
    const registeredMatches = registrations
      .filter((row) => {
        const metadata = this.parseAgentMetadata(row.metadataJson);
        const canonical = this.inferCanonicalAgentId(row.agentId, row.name, metadata);
        return (
          aliasList.includes(this.comparableAgentId(row.agentId)) ||
          aliasList.includes(this.comparableAgentId(row.name)) ||
          aliasList.includes(canonical)
        );
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    if (registeredMatches.length > 0) {
      const row = registeredMatches[0];
      canonical = this.inferCanonicalAgentId(row.agentId, row.name, this.parseAgentMetadata(row.metadataJson));
    }

    if (!aliases.has(canonical)) {
      aliases.add(canonical);
    }

    return { aliases: Array.from(aliases), canonical };
  }

  public getAgentAliases(agentId: string, tenantId: string = 'default'): string[] {
    return this.resolveAgentFamily(agentId, tenantId).aliases;
  }

  public resolvePreferredAgentId(agentId: string, tenantId: string = 'default'): string {
    return this.resolveAgentFamily(agentId, tenantId).canonical || this.comparableAgentId(agentId);
  }

  /**
   * Resolve an address for mailbox authorization, delivery, and ENG-4
   * authorship. Agent ids are opaque, exact handles: case, transport-looking
   * suffixes, and every other character are identity-significant. Display
   * aliases, registration metadata, and registration lifecycle must never
   * change who can read an existing mailbox or own an existing checkpoint.
   */
  public resolveMailboxIdentity(
    agentId: string,
    _tenantId: string = 'default'
  ): { aliases: string[]; canonical: string } {
    if (typeof agentId !== 'string') return { aliases: [], canonical: '' };
    const requested = agentId;
    if (
      requested.length < 1
      || requested.length > 100
      || !/^[A-Za-z0-9_.:-]+$/.test(requested)
    ) {
      return { aliases: [], canonical: '' };
    }
    return { aliases: [requested], canonical: requested };
  }

  public getMailboxAliases(agentId: string, tenantId: string = 'default'): string[] {
    return this.resolveMailboxIdentity(agentId, tenantId).aliases;
  }

  public resolveMailboxAddress(agentId: string, tenantId: string = 'default'): string {
    return this.resolveMailboxIdentity(agentId, tenantId).canonical;
  }

  /**
   * Return whether a shared/search result contains private direct-message
   * material. Kept public so the MCP search adapter can apply the same policy
   * to graph-index exact matches, which bypass the broad SQL/vector search.
   */
  public isConfidentialMessageSearchItem(memoryType: unknown, content: unknown): boolean {
    const normalizedMemoryType = String(memoryType || '').trim().toLowerCase();
    const isGraphType = normalizedMemoryType === 'entity'
      || normalizedMemoryType === 'observation'
      || normalizedMemoryType === 'relation';
    if (normalizedMemoryType === 'ai_message' || normalizedMemoryType === 'message_detail') {
      return true;
    }

    let payload = content;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // Shared graph rows are JSON objects by contract. A malformed legacy
        // row cannot be proven public, and returning its raw bytes would turn
        // corruption into a confidentiality bypass.
        return isGraphType;
      }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return isGraphType;
    }

    const candidate = payload as Record<string, any>;
    if ([candidate.entityType, candidate.type, candidate.memoryType, candidate.memory_type]
      .some((domainType) => String(domainType || '').trim().toLowerCase() === 'message_detail')) {
      return true;
    }

    // Historical private payload entities used msg-detail-* as a reserved
    // canonical namespace. A damaged/imported row must not become public just
    // because its domain discriminator was rewritten to `project` (or any
    // other value). An alias in the reserved namespace makes the whole entity
    // private too, because graph children can address the entity by that alias.
    if (normalizedMemoryType === 'entity') {
      const entityReferences = [
        candidate.name,
        ...(Array.isArray(candidate.aliases) ? candidate.aliases : []),
      ];
      if (entityReferences.some((reference) =>
        typeof reference === 'string'
        && this.normalizeEntityLookup(reference).startsWith('msg-detail-')
      )) {
        return true;
      }
    }

    return false;
  }

  private getConfidentialEntityReferences(tenantId: string): Set<string> {
    const cached = this.confidentialEntityReferenceCache.get(tenantId);
    if (cached) return cached;

    const references = new Set<string>();
    const rows = this.db.prepare(`
      SELECT id, content, memory_type
      FROM shared_memory
      WHERE tenant_id = ?
        AND LOWER(memory_type) IN ('entity', 'message_detail')
    `).all(tenantId) as Array<{ id: string; memory_type: string; content: string }>;
    for (const row of rows) {
      let content: any;
      try {
        content = JSON.parse(row.content || '{}');
      } catch {
        // The row itself is fail-closed by isConfidentialGraphRow. Retain its
        // opaque ID too so a still-valid child observation cannot expose bytes
        // merely because its corrupt parent no longer yields a name or alias.
        references.add(`id:${row.id}`);
        continue;
      }
      if (!this.isConfidentialMessageSearchItem(row.memory_type, content)) continue;
      references.add(`id:${row.id}`);
      for (const value of [content.name, ...(Array.isArray(content.aliases) ? content.aliases : [])]) {
        for (const variant of this.entityQueryVariants(value)) references.add(`name:${variant}`);
      }
    }
    this.confidentialEntityReferenceCache.set(tenantId, references);
    return references;
  }

  /** Resolve a private historical message-detail entity by exact ID/name/alias. */
  public isConfidentialEntityReference(entityRef: unknown, tenantId: string = 'default'): boolean {
    if (typeof entityRef !== 'string' || !entityRef.trim()) return false;
    // Historical oversized-message entities used this reserved canonical
    // namespace. Keep orphan child rows private even when the parent was
    // already lost or cannot be safely reconstructed by migration 007.
    if (this.normalizeEntityLookup(entityRef).startsWith('msg-detail-')) return true;
    const references = this.getConfidentialEntityReferences(tenantId);
    if (references.has(`id:${entityRef}`)) return true;
    return this.entityQueryVariants(entityRef).some((variant) => references.has(`name:${variant}`));
  }

  /**
   * Private-message confidentiality follows materialized child observations.
   * Those rows must not become public merely because their storage type is
   * `observation` rather than `entity`.
   */
  public isConfidentialGraphRow(
    memoryType: unknown,
    content: unknown,
    tenantId: string = 'default'
  ): boolean {
    if (this.isConfidentialMessageSearchItem(memoryType, content)) return true;
    const normalizedMemoryType = String(memoryType || '').trim().toLowerCase();
    if (normalizedMemoryType !== 'observation' && normalizedMemoryType !== 'relation') return false;

    let payload = content;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return true; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
    const graphRow = payload as Record<string, any>;
    if (normalizedMemoryType === 'relation') {
      return this.isConfidentialEntityReference(graphRow.from, tenantId)
        || this.isConfidentialEntityReference(graphRow.to, tenantId);
    }
    if (this.isConfidentialEntityReference(graphRow.metadata?.entityId, tenantId)) return true;
    return this.isConfidentialEntityReference(graphRow.entityName, tenantId);
  }

  getSharedMemory(): SharedMemory {
    return this.memorySystem.shared;
  }

  async recordLearning(agentId: string, context: string, lesson: string, confidence: number = 0.8, tenantId: string = 'default'): Promise<void> {
    const learning: LearningHistory = {
      id: uuidv4(),
      timestamp: new Date(),
      context,
      lesson,
      confidence,
      reinforcements: 1
    };

    await this.store(agentId, learning, 'individual', 'learning', tenantId);
  }

  async updateAgentPreferences(agentId: string, preferences: Partial<AgentPreferences>, tenantId: string = 'default'): Promise<void> {
    const cacheKey = `${tenantId}:${agentId}`;
    const currentMemory = this.memorySystem.individual.get(cacheKey);
    if (currentMemory) {
      currentMemory.preferences = { ...currentMemory.preferences, ...preferences };
      await this.store(agentId, currentMemory.preferences, 'individual', 'preferences', tenantId);
    }
  }

  async getSystemStatus(): Promise<any> {
    const status = {
      sqlite: { connected: true, type: 'SQLite' },
      vector: { connected: false, type: 'sqlite-vec', backend: 'sqlite-vec' },
      // Backward-compat alias for older dashboards/clients.
      weaviate: { connected: false, type: 'Vector Database (legacy alias)', backend: 'sqlite-vec' },
      advancedSystemsEnabled: this.isAdvancedSystemsEnabled
    };

    if (this.isAdvancedSystemsEnabled) {
      if (this.vectorClient) {
        const connected = await this.vectorClient.healthCheck();
        status.vector.connected = connected;
        status.weaviate.connected = connected;
      }
    }

    return status;
  }

  /**
   * Retrieve a specific chunk of a large content row from shared_memory.
   * Used by callers when search results include chunked: true.
   */
  getContentChunk(id: string, chunkIndex: number): { chunk: string; chunkIndex: number; totalChunks: number; contentSize: number } {
    const sizeRow = this.db.prepare(
      'SELECT LENGTH(content) as content_size FROM shared_memory WHERE id = ?'
    ).get(id) as any;
    if (!sizeRow) throw new Error(`Entity ${id} not found`);

    const contentSize = sizeRow.content_size;
    const chunkSize = this.contentSizeThreshold;
    const totalChunks = Math.ceil(contentSize / chunkSize);

    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new Error(`Chunk index ${chunkIndex} out of range [0, ${totalChunks - 1}]`);
    }

    const offset = chunkIndex * chunkSize;
    const row = this.db.prepare(
      'SELECT SUBSTR(content, ?, ?) as chunk FROM shared_memory WHERE id = ?'
    ).get(offset + 1, chunkSize, id) as any; // SUBSTR is 1-indexed

    return { chunk: row.chunk, chunkIndex, totalChunks, contentSize };
  }

  // ─── Security: Content Sanitization + Audit ───

  private static readonly INJECTION_PATTERNS: RegExp[] = [
    /ignore previous/i,
    /system override/i,
    /\bSYSTEM:/,
    /\[INST\]/,
    /<\|.*?\|>/,
    /\}\s*\{.*tool/i,
  ];

  static sanitizeContent(content: string): { safe: boolean; reason?: string } {
    for (const pattern of MemoryManager.INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        return { safe: false, reason: `Flagged pattern: ${pattern.toString()}` };
      }
    }
    if (content.length > 10000) {
      return { safe: false, reason: 'Content exceeds 10000 character limit' };
    }
    return { safe: true };
  }

  static contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Write an entry to the neural_audit_log table.
   * Fire-and-forget — failures are logged but never throw.
   */
  auditLog(operation: string, agentId: string, content: string, entityName?: string, flagged: boolean = false, flagReason?: string): void {
    try {
      const id = uuidv4();
      const hash = MemoryManager.contentHash(content);
      this.db.prepare(
        `INSERT INTO neural_audit_log (id, operation, agent_id, entity_name, content_hash, flagged, flag_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, operation, agentId, entityName || null, hash, flagged ? 1 : 0, flagReason || null);
    } catch (e: any) {
      console.error(`⚠️ Audit log write failed (non-fatal): ${e.message}`);
    }
  }

  /**
   * Query the neural_audit_log table (for admin/testing).
   */
  queryAuditLog(agentId?: string, operation?: string, limit: number = 20): any[] {
    let query = 'SELECT * FROM neural_audit_log WHERE 1=1';
    const params: any[] = [];
    if (agentId) { query += ' AND agent_id = ?'; params.push(agentId); }
    if (operation) { query += ' AND operation = ?'; params.push(operation); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(query).all(...params);
  }

  /**
   * Escape a string for safe use inside XML/HTML attribute values.
   */
  private static escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Wrap content string in <neural_memory> structural delimiters.
   * trust levels: 'verified' (server-generated), 'agent' (agent-submitted), 'identity' (agent identity data)
   */
  static wrapContent(content: string, source: string, entity: string, trust: 'verified' | 'agent' | 'identity' = 'verified'): string {
    return `<neural_memory source="${MemoryManager.escapeAttr(source)}" entity="${MemoryManager.escapeAttr(entity)}" trust="${trust}">\n${content}\n</neural_memory>`;
  }

  // ─── Session Protocol methods ───

  /**
   * Build a tiered context bundle for an agent.
   * depth: 'hot' | 'warm' | 'cold'
   *   HOT:  identity + unread messages + handoff flag + guardrails
   *   WARM: HOT + project observations (30d) + recent decisions
   *   COLD: everything
   */
  getAgentContext(
    agentId: string,
    projectId?: string,
    depth: 'hot' | 'warm' | 'cold' = projectId ? 'warm' : 'hot',
    tenantId: string = 'default',
    maxTokens: number = 4000,
    userId?: string | null
  ): any {
    const requestedMaxTokens = Number.isFinite(maxTokens)
      ? Math.max(1, Math.floor(maxTokens))
      : 4000;
    const minimumTokenBudget = MemoryManager.MIN_CONTEXT_TOKEN_BUDGET;
    const effectiveMaxTokens = Math.max(requestedMaxTokens, minimumTokenBudget);
    const minimalContextBundle = (truncationReason: string) => {
      const minimal: any = {
        identity: { learnings: [] },
        meta: {
          depth,
          tokenEstimate: 0,
          requestedMaxTokens,
          effectiveMaxTokens,
          minimumTokenBudget,
          budgetFloorApplied: effectiveMaxTokens !== requestedMaxTokens,
          truncated: true,
          truncationReason,
          sectionsDropped: ['contextBeyondIdentityEnvelope'],
        },
      };
      const estimate = () => Math.ceil(JSON.stringify(minimal).length / 4);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        minimal.meta.tokenEstimate = estimate();
      }
      return minimal;
    };

    if (effectiveMaxTokens !== requestedMaxTokens) {
      return minimalContextBundle('minimum_identity_envelope');
    }

    const bundle: any = {
      identity: { learnings: [] },
      user: null,
      project: null,
      handoff: null,
      unreadMessages: { count: 0, hint: 'Use get_ai_messages(agentId) to retrieve' },
      guardrails: [],
      meta: {
        depth,
        tokenEstimate: 0,
        requestedMaxTokens,
        effectiveMaxTokens,
        minimumTokenBudget,
        budgetFloorApplied: effectiveMaxTokens !== requestedMaxTokens,
        truncated: false,
        truncationReason: null,
        sectionsDropped: [],
      }
    };
    let previewMessageIds: string[] = [];

    // --- HOT tier (always included) ---

    // 1. Agent identity: learnings + preferences (tenant-scoped cache key, no bare agentId fallback)
    const agentMem = this.memorySystem.individual.get(`${tenantId}:${agentId}`);
    if (agentMem) {
      bundle.identity.learnings = agentMem.learnings.slice(-20).map((l: any) => ({
        _wrapped: MemoryManager.wrapContent(JSON.stringify(l), 'learning', agentId, 'identity')
      }));
      bundle.identity._preferencesWrapped = MemoryManager.wrapContent(
        JSON.stringify(agentMem.preferences || {}), 'preferences', agentId, 'identity'
      );
    }

    // 1b. Task 1100: HOT tier user block (included when userId provided)
    if (userId) {
      const userProfile = this.getUserProfile(userId, tenantId);
      if (userProfile) {
        bundle.user = {
          _wrapped: MemoryManager.wrapContent(JSON.stringify({
            id: userProfile.id,
            displayName: userProfile.displayName,
            timezone: userProfile.timezone,
            locale: userProfile.locale,
            dateFormat: userProfile.dateFormat,
            units: userProfile.units,
            workingHours: userProfile.workingHours,
          }), 'user_profile', userId, 'identity'),
        };
      }
    }

    // 2. Unread messages — count + inlined compact previews (tenant-scoped).
    // Previously this returned ONLY a count, so an agent that loads context at
    // the start of a turn saw "you have N unread" but not the content, and had
    // to make a second get_ai_messages call. Agents that don't (or can't poll,
    // e.g. Cowork / web chats) never saw their messages. Inlining compact
    // previews here makes the single context-load deliver the actual messages,
    // so cross-agent comms work without any polling. Excludes archived; newest
    // first; uses the idx_ai_messages_read_path index; previews use the compact
    // `summary` column. Capped small (budget trimming can drop these first).
    try {
      this.ensureReadAtColumn();
      this.ensureArchivedAtColumn();
      this.ensureSummaryColumn();
      this.ensureMessageSupersessionColumns();
      this.ensureMessageDeliveryColumn();
      const previewLimit = 5;
      const countRow = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM ai_messages WHERE to_agent = ? AND tenant_id = ? AND read_at IS NULL AND archived_at IS NULL AND superseded_at IS NULL'
      ).get(agentId, tenantId) as any;
      const unreadCount = countRow?.cnt ?? 0;
      const previewRows = unreadCount > 0 ? this.db.prepare(
        `SELECT id, from_agent, message_type, priority, created_at, summary, content
         FROM ai_messages
         WHERE to_agent = ? AND tenant_id = ? AND read_at IS NULL AND archived_at IS NULL AND superseded_at IS NULL
         ORDER BY created_at DESC LIMIT ?`
      ).all(agentId, tenantId, previewLimit) as any[] : [];
      previewMessageIds = previewRows.map((row: any) => row.id);
      const messages = previewRows.map((m: any) => {
        const raw = (typeof m.summary === 'string' && m.summary.length > 0) ? m.summary : (m.content || '');
        const preview = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
        return {
          id: m.id,
          from: m.from_agent,
          type: m.message_type,
          priority: m.priority,
          timestamp: m.created_at,
          preview,
        };
      });
      bundle.unreadMessages = {
        count: unreadCount,
        messages,
        truncated: unreadCount > messages.length,
        hint: unreadCount > messages.length
          ? `Showing ${messages.length} of ${unreadCount} unread (compact previews). Use get_ai_messages(agentId) for the rest, get_message_detail(messageId) for full content.`
          : 'Compact previews shown. Use get_ai_messages(agentId) to mark read, get_message_detail(messageId) for full content.',
      };
    } catch { /* ai_messages table may not exist */ }

    // 3. Guardrails — entities of type 'guardrail' (tenant-scoped)
    try {
      const guardrailRows = this.db.prepare(
        `SELECT id, content, created_at FROM shared_memory
         WHERE tenant_id = ? AND memory_type = 'entity' AND LOWER(content) LIKE '%"type":"guardrail"%'
         ORDER BY created_at DESC LIMIT 10`
      ).all(tenantId) as any[];
      bundle.guardrails = guardrailRows
        .filter((r: any) => !this.isConfidentialGraphRow('entity', r.content, tenantId))
        .map((r: any) => {
        try {
          const parsed = JSON.parse(r.content);
          return { _wrapped: MemoryManager.wrapContent(JSON.stringify(parsed), 'guardrail', parsed.name || 'guardrail') };
        } catch { return { _wrapped: MemoryManager.wrapContent(r.content, 'guardrail', 'unknown') }; }
      });
    } catch { /* ok */ }

    // 4. HOT-tagged observations (tenant-scoped)
    try {
      const hotRows = this.db.prepare(
        `SELECT id, content, created_at FROM shared_memory
         WHERE tenant_id = ? AND memory_type = 'observation' AND content LIKE '%[HOT]%'
         ORDER BY created_at DESC LIMIT 20`
      ).all(tenantId) as any[];
      if (hotRows.length > 0) {
        if (!bundle.project) bundle.project = {};
      bundle.project.hotObservations = hotRows
        .filter((r: any) => !this.isConfidentialGraphRow('observation', r.content, tenantId))
        .map((r: any) => {
          try {
            const parsed = JSON.parse(r.content);
            return { _wrapped: MemoryManager.wrapContent(JSON.stringify(parsed), 'observation', parsed.entityName || 'hot', 'agent') };
          } catch { return { _wrapped: MemoryManager.wrapContent(r.content, 'observation', 'hot', 'agent') }; }
        });
      }
    } catch { /* ok */ }

    // 5. Handoff flag (filter consumed handoffs for context isolation, tenant-scoped)
    if (projectId) {
      const rawHandoff = this.getActiveHandoff(projectId, tenantId);
      const handoff = rawHandoff && !rawHandoff.consumedAt ? rawHandoff : null;
      if (handoff) {
        bundle.handoff = {
          _wrapped: MemoryManager.wrapContent(handoff.summary, 'handoff', projectId, 'agent'),
          _openItemsWrapped: (handoff.openItems || []).map((item: string) =>
            MemoryManager.wrapContent(item, 'handoff_item', projectId, 'agent')
          ),
          fromAgent: handoff.fromAgent,
          projectId: handoff.projectId,
          createdAt: handoff.createdAt,
        };
      }
    }

    // --- WARM tier (project context, 30-day window) ---
    if ((depth === 'warm' || depth === 'cold') && projectId) {
      if (!bundle.project) bundle.project = {};

      // Project entity (tenant-scoped)
      try {
        const projRow = this.db.prepare(
          `SELECT id, content, created_at FROM shared_memory
           WHERE tenant_id = ? AND memory_type = 'entity' AND LOWER(content) LIKE ?
           AND NOT (
             json_valid(content)
             AND (
               LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
             )
           )
           ORDER BY created_at DESC LIMIT 1`
        ).get(tenantId, `%"name":"${projectId.toLowerCase()}"%`) as any;
        if (projRow) {
          try {
            const projData = JSON.parse(projRow.content);
            if (!this.isConfidentialGraphRow('entity', projData, tenantId)) {
              const summaryText = projData.observations?.join('; ') || projData.name || projectId;
              bundle.project._summaryWrapped = MemoryManager.wrapContent(summaryText, 'project_summary', projectId!, 'agent');
              bundle.project._entityWrapped = MemoryManager.wrapContent(JSON.stringify(projData), 'entity', projectId!, 'agent');
            }
          } catch { /* ok */ }
        }
      } catch { /* ok */ }

      // Recent observations for project (30 days, tenant-scoped)
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
        const obsRows = this.db.prepare(
          `SELECT id, content, created_at FROM shared_memory
           WHERE tenant_id = ? AND memory_type = 'observation' AND LOWER(content) LIKE ?
           AND created_at >= ? ORDER BY created_at DESC LIMIT 3`
        ).all(tenantId, `%${projectId.toLowerCase()}%`, thirtyDaysAgo) as any[];
        bundle.project.recentObservations = obsRows
          .filter((r: any) => !this.isConfidentialGraphRow('observation', r.content, tenantId))
          .map((r: any) => {
          try {
            const parsed = JSON.parse(r.content);
            return { _wrapped: MemoryManager.wrapContent(JSON.stringify(parsed), 'observation', parsed.entityName || projectId!, 'agent') };
          } catch { return { _wrapped: MemoryManager.wrapContent(r.content, 'observation', projectId!, 'agent') }; }
        });
      } catch { /* ok */ }

      // Recent decisions (last 5, tenant-scoped)
      try {
        const decRows = this.db.prepare(
          `SELECT id, decision, reasoning, created_at FROM consensus_history
           WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 5`
        ).all(tenantId) as any[];
        bundle.project.recentDecisions = decRows.map((d: any) => ({
          _wrapped: MemoryManager.wrapContent(JSON.stringify(d), 'decision', projectId!, 'agent')
        }));
      } catch { /* ok */ }
    }

    // --- COLD tier (everything, tenant-scoped) ---
    if (depth === 'cold' && projectId) {
      try {
        const allObs = this.db.prepare(
          `SELECT id, content, created_at FROM shared_memory
           WHERE tenant_id = ? AND memory_type = 'observation' AND LOWER(content) LIKE ?
           ORDER BY created_at DESC LIMIT 100`
        ).all(tenantId, `%${projectId.toLowerCase()}%`) as any[];
        bundle.project.allObservations = allObs
          .filter((r: any) => !this.isConfidentialGraphRow('observation', r.content, tenantId))
          .map((r: any) => {
          try {
            const parsed = JSON.parse(r.content);
            return { _wrapped: MemoryManager.wrapContent(JSON.stringify(parsed), 'observation', parsed.entityName || projectId!, 'agent') };
          } catch { return { _wrapped: MemoryManager.wrapContent(r.content, 'observation', projectId!, 'agent') }; }
        });
      } catch { /* ok */ }

      try {
        const allEntities = this.db.prepare(
          `SELECT id, content, created_at FROM shared_memory
           WHERE tenant_id = ? AND memory_type = 'entity' AND LOWER(content) LIKE ?
           AND NOT (
             json_valid(content)
             AND (
               LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
               OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
             )
           )
           ORDER BY created_at DESC LIMIT 50`
        ).all(tenantId, `%${projectId.toLowerCase()}%`) as any[];
        bundle.project.allEntities = allEntities
          .filter((r: any) => !this.isConfidentialGraphRow('entity', r.content, tenantId))
          .map((r: any) => {
          try {
            const parsed = JSON.parse(r.content);
            return { _wrapped: MemoryManager.wrapContent(JSON.stringify(parsed), 'entity', parsed.name || projectId!, 'agent') };
          } catch { return { _wrapped: MemoryManager.wrapContent(r.content, 'entity', projectId!, 'agent') }; }
        });
      } catch { /* ok */ }
    }

    // --- Priority-based token budget enforcement ---
    // Priority order (lowest priority dropped first):
    //   summary < messages < observations < guardrails < handoff < identity
    const estimateTokens = () => Math.ceil(JSON.stringify(bundle).length / 4);
    const refreshTokenEstimate = () => {
      let estimate = estimateTokens();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        bundle.meta.tokenEstimate = estimate;
        const next = estimateTokens();
        if (next === estimate) break;
        estimate = next;
      }
      bundle.meta.tokenEstimate = estimate;
      return estimate;
    };
    const overBudget = () => refreshTokenEstimate() > effectiveMaxTokens;
    const sectionsDropped = bundle.meta.sectionsDropped as string[];
    const noteDropped = (section: string) => {
      if (!sectionsDropped.includes(section)) sectionsDropped.push(section);
    };

    refreshTokenEstimate();

    if (bundle.meta.tokenEstimate > effectiveMaxTokens) {
      bundle.meta.truncated = true;
      bundle.meta.truncationReason = 'content_trimmed';

      // 1. Drop COLD observations + entities first (lowest priority bulk)
      if (bundle.project?.allObservations && overBudget()) {
        bundle.project.allObservations = bundle.project.allObservations.slice(0, 3);
        noteDropped('allObservations(trimmed)');
        if (overBudget()) {
          delete bundle.project.allObservations;
          noteDropped('allObservations');
        }
      }
      if (bundle.project?.allEntities && overBudget()) {
        delete bundle.project.allEntities;
        noteDropped('allEntities');
      }

      // 2. Drop project summary (low priority)
      if (bundle.project?._summaryWrapped && overBudget()) {
        delete bundle.project._summaryWrapped;
        noteDropped('projectSummary');
      }

      // 2b. Drop inlined message previews (keep count + hint). Per the priority
      // order, message bodies are low — trim them before observations/guardrails.
      if (bundle.unreadMessages?.messages?.length > 0 && overBudget()) {
        const total = bundle.unreadMessages.count;
        delete bundle.unreadMessages.messages;
        bundle.unreadMessages.truncated = total > 0;
        bundle.unreadMessages.hint = 'Previews omitted for token budget. Use get_ai_messages(agentId) to retrieve.';
        noteDropped('messagePreviews');
      }

      // 3. Drop recent decisions
      if (bundle.project?.recentDecisions && overBudget()) {
        delete bundle.project.recentDecisions;
        noteDropped('recentDecisions');
      }

      // 4. Drop recent observations (warm tier)
      if (bundle.project?.recentObservations && overBudget()) {
        bundle.project.recentObservations = bundle.project.recentObservations.slice(0, 1);
        noteDropped('recentObservations(trimmed)');
        if (overBudget()) {
          delete bundle.project.recentObservations;
          noteDropped('recentObservations');
        }
      }

      // 5. Drop HOT observations
      if (bundle.project?.hotObservations && overBudget()) {
        delete bundle.project.hotObservations;
        noteDropped('hotObservations');
      }

      // 6. Drop guardrails (higher priority than observations, but lower than handoff/identity)
      if (bundle.guardrails?.length > 0 && overBudget()) {
        bundle.guardrails = bundle.guardrails.slice(0, 2);
        noteDropped('guardrails(trimmed)');
        if (overBudget()) {
          bundle.guardrails = [];
          noteDropped('guardrails');
        }
      }

      // 7. Every remaining non-identity section yields before agent identity.
      if (bundle.project?._entityWrapped && overBudget()) {
        delete bundle.project._entityWrapped;
        noteDropped('projectEntity');
      }
      if (bundle.unreadMessages && overBudget()) {
        delete bundle.unreadMessages;
        noteDropped('unreadMessages');
      }
      if (bundle.project !== undefined && overBudget()) {
        delete bundle.project;
        noteDropped('project');
      }
      if (bundle.handoff && overBudget()) {
        bundle.handoff = null;
        noteDropped('handoff');
      }
      if (bundle.user && overBudget()) {
        bundle.user = null;
        noteDropped('user');
      }
      if (bundle.handoff !== undefined && overBudget()) {
        delete bundle.handoff;
        noteDropped('handoffEnvelope');
      }
      if (bundle.user !== undefined && overBudget()) {
        delete bundle.user;
        noteDropped('userEnvelope');
      }
      if (bundle.guardrails !== undefined && overBudget()) {
        delete bundle.guardrails;
        noteDropped('guardrailsEnvelope');
      }

      // 8. Trim identity payloads while preserving the identity object itself.
      if (bundle.identity?.learnings?.length > 5 && overBudget()) {
        bundle.identity.learnings = bundle.identity.learnings.slice(-5);
        noteDropped('learnings(trimmed)');
      }
      while (bundle.identity?.learnings?.length > 0 && overBudget()) {
        bundle.identity.learnings.shift();
        noteDropped('learnings(trimmed)');
      }
      if (bundle.identity?._preferencesWrapped && overBudget()) {
        delete bundle.identity._preferencesWrapped;
        noteDropped('preferences');
      }

      refreshTokenEstimate();
    }

    // The normal trimming path preserves as much context as possible. This
    // final fallback makes the ceiling mechanically hard even if an unusually
    // large wrapper or future field slips through the priority list.
    if (refreshTokenEstimate() > effectiveMaxTokens) {
      return minimalContextBundle('content_trimmed_to_identity_envelope');
    }

    refreshTokenEstimate();
    const returnedPreviewIds = new Set(
      Array.isArray(bundle.unreadMessages?.messages)
        ? bundle.unreadMessages.messages.map((message: any) => message.id)
        : []
    );
    const deliveredPreviewIds = previewMessageIds.filter((id) => returnedPreviewIds.has(id));
    if (deliveredPreviewIds.length > 0) {
      try {
        const placeholders = deliveredPreviewIds.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE ai_messages SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`
        ).run(new Date().toISOString(), ...deliveredPreviewIds);
      } catch { /* ai_messages table may not exist */ }
    }
    return bundle;
  }

  /**
   * Get the active handoff flag for a project.
   */
  getActiveHandoff(projectId: string, tenantId: string = 'default'): any | null {
    try {
      const row = this.db.prepare(
        'SELECT * FROM session_handoffs WHERE project_id = ? AND tenant_id = ? AND active = 1'
      ).get(projectId, tenantId) as any;
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        fromAgent: row.from_agent,
        summary: row.summary,
        openItems: row.open_items_json ? JSON.parse(row.open_items_json) : [],
        createdAt: row.created_at,
        consumedAt: row.consumed_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Mark a handoff as consumed (idempotency guard for begin_session retries).
   */
  consumeHandoff(handoffId: string): void {
    try {
      this.db.prepare(
        "UPDATE session_handoffs SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL"
      ).run(handoffId);
    } catch (e: any) {
      console.error(`⚠️ consumeHandoff failed (non-fatal): ${e.message}`);
    }
  }

  /**
   * Write a new handoff flag, deactivating any previous one for the same project.
   * Runs in a single transaction for atomicity.
   */
  writeHandoff(projectId: string, fromAgent: string, summary: string, openItems?: string[], tenantId: string = 'default', userId?: string | null): string {
    const id = uuidv4();
    const txn = this.db.transaction(() => {
      // Deactivate prior handoff (tenant-scoped)
      this.db.prepare(
        'UPDATE session_handoffs SET active = 0 WHERE project_id = ? AND tenant_id = ? AND active = 1'
      ).run(projectId, tenantId);
      // Insert new active handoff with tenant_id and user_id (audit trail)
      this.db.prepare(
        `INSERT INTO session_handoffs (id, project_id, from_agent, summary, open_items_json, tenant_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, projectId, fromAgent, summary, openItems ? JSON.stringify(openItems) : null, tenantId, userId || null);
    });
    txn();
    return id;
  }

  /**
   * Ensure a project entity skeleton exists in shared_memory.
   * Returns the existing entity ID or creates a new one.
   */
  ensureProjectEntity(agentId: string, projectId: string, tenantId: string = 'default'): string {
    // Check if a project entity already exists (tenant-scoped)
    const existing = this.db.prepare(
      `SELECT id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'entity' AND LOWER(content) LIKE ?
       LIMIT 1`
    ).get(tenantId, `%"name":"${projectId.toLowerCase()}"%`) as any;

    if (existing) return existing.id;

    // Create skeleton entity
    const entityId = uuidv4();
    const skeleton = {
      name: projectId,
      type: 'project',
      observations: [`Project ${projectId} created`],
      createdBy: agentId,
      timestamp: new Date().toISOString(),
    };

    this.db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'entity', ?, ?, '["project"]')`
    ).run(entityId, tenantId, JSON.stringify(skeleton), agentId);

    return entityId;
  }

  async close(): Promise<void> {
    this.db.close();
    // Embedded vector client does not require explicit closing.
    console.log('🧠 Enhanced memory manager closed');
  }

  // ─── ai_messages table methods (P1 migration) ───

  /**
   * Store a message in the dedicated ai_messages table.
   * Falls back to shared_memory if ai_messages table doesn't exist yet.
   */
  async storeMessage(
    from: string,
    to: string,
    content: string,
    messageType: string = 'info',
    priority: string = 'normal',
    metadata?: Record<string, any>,
    tenantId: string = 'default',
    context?: RequestContext,
    supersedes: string[] = []
  ): Promise<string> {
    const id = uuidv4();
    const fromActorType = context?.authType || null;
    const fromActorId = context?.userId || context?.apiKeyId || null;
    const summary = MemoryManager.generateSummary(content);

    try {
      this.ensureSummaryColumn();
      this.ensureMessageSupersessionColumns();
      this.ensureMessageDeliveryColumn();
      const storedMetadata = {
        ...(metadata || {}),
        deliveryStatus: metadata?.deliveryStatus || 'queued',
      };
      const stmt = this.db.prepare(`
        INSERT INTO ai_messages (id, from_agent, from_source, to_agent, content, message_type, priority, metadata, tenant_id, from_actor_type, from_actor_id, summary)
        VALUES (?, ?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const requestedSupersedes = Array.from(new Set(
        supersedes.filter((candidate) => typeof candidate === 'string' && candidate.trim()).map((candidate) => candidate.trim())
      )).slice(0, 100);
      const senderAliases = this.getMailboxAliases(from, tenantId);
      const recipientAliases = this.getMailboxAliases(to, tenantId);
      const write = this.db.transaction(() => {
        stmt.run(id, from, to, content, messageType, priority, JSON.stringify(storedMetadata), tenantId, fromActorType, fromActorId, summary);
        if (requestedSupersedes.length === 0) return;

        const idPlaceholders = requestedSupersedes.map(() => '?').join(',');
        const senderPlaceholders = senderAliases.map(() => '?').join(',');
        const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE ai_messages
           SET superseded_by = ?, superseded_at = ?
           WHERE id IN (${idPlaceholders})
             AND tenant_id = ?
             AND from_agent IN (${senderPlaceholders})
             AND to_agent IN (${recipientPlaceholders})
             AND superseded_at IS NULL
             AND id <> ?`
        ).run(
          id,
          new Date().toISOString(),
          ...requestedSupersedes,
          tenantId,
          ...senderAliases,
          ...recipientAliases,
          id
        );
      });
      write();
    } catch (err: any) {
      // Fallback: ai_messages table may not exist yet (pre-migration)
      if (err.message?.includes('no such table')) {
        console.warn('⚠️ ai_messages table not found, falling back to shared_memory');
        return this.store(from, {
          id: `message-${Date.now()}`,
          to,
          target: to,
          from,
          message: content,
          content,
          type: messageType,
          messageType,
          priority,
          timestamp: new Date().toISOString(),
          deliveryStatus: 'queued',
          metadata: metadata || {},
        }, 'shared', 'ai_message', tenantId, context);
      }
      throw err;
    }

    console.log(`💬 Stored message: ${from} → ${to} [${messageType}]`);
    return id;
  }

  /**
   * Get messages for an agent from the dedicated ai_messages table.
   * Falls back to shared_memory search if ai_messages table doesn't exist.
   */
  getMessages(
    agentId: string,
    options: MessageQueryOptions = {}
  ): any[] {
    return this.getMessagesPage(agentId, options).messages;
  }

  /**
   * Get one deterministic page of messages plus the true count for the same
   * filter set. getMessages remains as the array-only compatibility wrapper.
   */
  getMessagesPage(agentId: string, options: MessageQueryOptions = {}): MessagePage {
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit!))
      : 5;
    const offset = Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset!))
      : 0;
    const tenantId = options.tenantId || 'default';
    const compact = options.compact !== false; // default true
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    const senderAliases = options.from ? this.getMailboxAliases(options.from, tenantId) : [];

    if (recipientAliases.length === 0) {
      return { messages: [], totalMatching: 0, limit, offset };
    }

    try {
      // Ensure read_at + archived_at + summary columns exist (idempotent migration)
      this.ensureReadAtColumn();
      this.ensureArchivedAtColumn();
      this.ensureMessageSupersessionColumns();
      this.ensureSummaryColumn();
      this.ensureMessageDeliveryColumn();

      // Compact mode: exclude full content column to reduce token consumption
      const columns = compact
        ? 'id, from_agent, to_agent, message_type, priority, created_at, delivered_at, read_at, archived_at, superseded_by, superseded_at, summary, metadata'
        : '*';
      const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
      let where = `to_agent IN (${recipientPlaceholders}) AND tenant_id = ?`;
      const params: any[] = [...recipientAliases, tenantId];

      // Task 1200: Exclude archived by default
      if (!options.includeArchived) {
        where += ' AND archived_at IS NULL';
      }
      if (!options.includeSuperseded) {
        where += ' AND superseded_at IS NULL';
      }

      if (options.messageType) {
        where += ' AND message_type = ?';
        params.push(options.messageType);
      }
      if (options.since) {
        where += ' AND created_at >= ?';
        params.push(options.since);
      }
      if (options.unreadOnly) {
        where += ' AND read_at IS NULL';
      }
      if (options.from) {
        const senderPlaceholders = senderAliases.map(() => '?').join(',');
        where += ` AND from_agent IN (${senderPlaceholders})`;
        params.push(...senderAliases);
      }

      const countRow = this.db.prepare(
        `SELECT COUNT(*) AS count FROM ai_messages WHERE ${where}`
      ).get(...params) as { count?: number } | undefined;
      const totalMatching = Number(countRow?.count || 0);

      const messages = this.db.prepare(
        `SELECT ${columns} FROM ai_messages WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];

      // A recipient fetching a message is the first delivery fact we can
      // always prove, even when no WebSocket client was connected at send time.
      if (messages.length > 0) {
        const now = new Date().toISOString();
        const ids = messages.map((m: any) => m.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE ai_messages SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`
        ).run(now, ...ids);
        for (const message of messages) {
          if (!message.delivered_at) message.delivered_at = now;
        }
      }

      // Mark retrieved messages as read if requested
      if (options.markAsRead && messages.length > 0) {
        const now = new Date().toISOString();
        const ids = messages.map((m: any) => m.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE ai_messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`
        ).run(now, ...ids);
        for (const message of messages) {
          if (!message.read_at) message.read_at = now;
        }
      }

      return { messages, totalMatching, limit, offset };
    } catch (err: any) {
      if (err.message?.includes('no such table')) {
        console.warn('⚠️ ai_messages table not found, falling back to shared_memory(ai_message)');
        return this.getLegacyMessagesPage(agentId, options);
      }
      throw err;
    }
  }

  /**
   * Legacy fallback: read ai_message rows from shared_memory (pre-migration schema).
   * These rows do not track read/archive state, so unreadOnly/includeArchived are best-effort.
   */
  private getLegacyMessagesPage(
    agentId: string,
    options: MessageQueryOptions = {}
  ): MessagePage {
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit!))
      : 5;
    const offset = Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset!))
      : 0;
    const tenantId = options.tenantId || 'default';
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    const senderAliases = options.from ? this.getMailboxAliases(options.from, tenantId) : [];

    if (recipientAliases.length === 0) {
      return { messages: [], totalMatching: 0, limit, offset };
    }

    try {
      const safeContent = `CASE WHEN json_valid(content) THEN content ELSE '{}' END`;
      const recipientExpression = `COALESCE(
        json_extract(${safeContent}, '$.to'),
        json_extract(${safeContent}, '$.target'),
        json_extract(${safeContent}, '$.to_agent'),
        ''
      )`;
      const senderExpression = `COALESCE(
        json_extract(${safeContent}, '$.from'),
        json_extract(${safeContent}, '$.from_agent'),
        created_by,
        ''
      )`;
      const messageTypeExpression = `COALESCE(
        json_extract(${safeContent}, '$.messageType'),
        json_extract(${safeContent}, '$.type'),
        'info'
      )`;
      const timestampExpression = `COALESCE(json_extract(${safeContent}, '$.timestamp'), created_at)`;
      const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
      let where = `tenant_id = ? AND memory_type = 'ai_message' AND json_valid(content)
        AND ${recipientExpression} IN (${recipientPlaceholders})`;
      const params: any[] = [tenantId, ...recipientAliases];

      if (options.messageType) {
        where += ` AND ${messageTypeExpression} = ?`;
        params.push(options.messageType);
      }
      if (options.since) {
        where += ` AND ${timestampExpression} >= ?`;
        params.push(options.since);
      }
      if (options.from) {
        const senderPlaceholders = senderAliases.map(() => '?').join(',');
        where += ` AND ${senderExpression} IN (${senderPlaceholders})`;
        params.push(...senderAliases);
      }

      const countRow = this.db.prepare(
        `SELECT COUNT(*) AS count FROM shared_memory WHERE ${where}`
      ).get(...params) as { count?: number } | undefined;
      const totalMatching = Number(countRow?.count || 0);
      const rows = this.db.prepare(
        `SELECT id, content, created_by, created_at
         FROM shared_memory
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];

      const messages = rows.map((row: any) => {
        const payload = JSON.parse(row.content || '{}');
        const content = String(payload.content ?? payload.message ?? '');
        return {
          id: row.id,
          from_agent: payload.from || payload.from_agent || row.created_by,
          to_agent: payload.to || payload.target || payload.to_agent,
          content,
          message_type: String(payload.messageType ?? payload.type ?? 'info'),
          priority: String(payload.priority ?? 'normal'),
          created_at: payload.timestamp || row.created_at,
          delivered_at: null,
          read_at: null,
          archived_at: null,
          superseded_by: null,
          superseded_at: null,
          summary: MemoryManager.generateSummary(content),
          metadata: JSON.stringify(payload.metadata || {}),
        };
      });

      // markAsRead is ignored in legacy mode (no read_at column).
      return { messages, totalMatching, limit, offset };
    } catch {
      return { messages: [], totalMatching: 0, limit, offset };
    }
  }

  /**
   * Get a single message by ID with full content.
   * Used by get_message_detail tool for the scan-then-detail workflow.
   */
  async getMessageById(
    messageId: string,
    agentId: string,
    markAsRead: boolean = true,
    tenantId: string = 'default'
  ): Promise<any | null> {
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    if (recipientAliases.length === 0) return null;
    try {
      this.ensureReadAtColumn();
      this.ensureSummaryColumn();
      this.ensureMessageDeliveryColumn();
      // Scope by tenant + recipient to prevent cross-tenant/cross-agent reads
      let query = 'SELECT * FROM ai_messages WHERE id = ? AND tenant_id = ?';
      const params: any[] = [messageId, tenantId];
      if (recipientAliases.length > 0) {
        const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
        query += ` AND to_agent IN (${recipientPlaceholders})`;
        params.push(...recipientAliases);
      }
      const msg = this.db.prepare(query).get(...params) as any;
      if (!msg) return null;
      const now = new Date().toISOString();
      if (!msg.delivered_at) {
        this.db.prepare('UPDATE ai_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
          .run(now, messageId);
        msg.delivered_at = now;
      }
      if (markAsRead && !msg.read_at) {
        this.db.prepare('UPDATE ai_messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
          .run(now, messageId);
        msg.read_at = now;
      }
      // Historical compatibility only: resolve pre-containment auto-split
      // pointers through a direct tenant-scoped lookup. Generic entity search
      // deliberately excludes these private payload entities.
      const pointerMatch = msg.content?.match(/^Full content stored as entity "([^"]+)"/);
      if (pointerMatch) {
        const entityName = pointerMatch[1];
        try {
          const entityRow = this.db.prepare(`
            SELECT content
            FROM shared_memory
            WHERE tenant_id = ?
              AND memory_type = 'entity'
              AND json_valid(content)
              AND LOWER(json_extract(content, '$.name')) = LOWER(?)
              AND LOWER(TRIM(COALESCE(
                json_extract(content, '$.type'),
                json_extract(content, '$.entityType'),
                ''
              ))) = 'message_detail'
            ORDER BY created_at DESC
            LIMIT 1
          `).get(tenantId, entityName) as { content: string } | undefined;
          const entity = entityRow ? JSON.parse(entityRow.content) : null;
          if (entity?.observations?.length) {
            msg.content = entity.observations[0];
            msg._resolvedFrom = entityName;
          }
        } catch {
          // If entity lookup fails, return the pointer as-is
        }
      }
      return msg;
    } catch (err: any) {
      if (err.message?.includes('no such table')) {
        // Legacy fallback from shared_memory(ai_message)
        const row = this.db.prepare(
          `SELECT id, content, created_by, created_at
           FROM shared_memory
           WHERE id = ? AND tenant_id = ? AND memory_type = 'ai_message'`
        ).get(messageId, tenantId) as any;
        if (!row) return null;

        let payload: any = {};
        try {
          payload = JSON.parse(row.content || '{}');
        } catch {
          payload = {};
        }

        const toAgent = payload.to || payload.target || payload.to_agent;
        if (!recipientAliases.includes(toAgent)) return null;

        const fromAgent = payload.from || payload.from_agent || row.created_by;
        const content = String(payload.content ?? payload.message ?? '');
        const messageType = String(payload.messageType ?? payload.type ?? 'info');
        const priority = String(payload.priority ?? 'normal');

        return {
          id: row.id,
          from_agent: fromAgent,
          to_agent: toAgent,
          content,
          message_type: messageType,
          priority,
          created_at: payload.timestamp || row.created_at,
          read_at: null,
          summary: MemoryManager.generateSummary(content),
          metadata: JSON.stringify(payload.metadata || {}),
        };
      }
      throw err;
    }
  }

  /**
   * Resolve the single authoritative ("current") observation for an entity:
   * the newest observation row whose id is not superseded by any newer one.
   *
   * Supersession is append-only metadata (each observation may carry
   * metadata.supersedes: [ids]), so "current" is resolved by fetching the
   * newest `windowSize` observation rows for the entity via the
   * graph_lookup_keys index (key_kind='entity_name') and skipping any row
   * whose id appears in a fetched row's supersedes list. No history scan:
   * cost is one index lookup + windowSize row parses regardless of how many
   * observations the entity has.
   */
  getCurrentObservation(
    entityName: string,
    tenantId: string = 'default',
    windowSize: number = 25
  ): {
    entity: string;
    canonicalKey: string;
    current: any | null;
    resolution: {
      windowSize: number;
      candidatesInWindow: number;
      supersededSkipped: number;
      widened?: boolean;
      fallback?: string;
    };
  } {
    const canonicalKey = this.normalizeEntityLookup(entityName);
    const maxWindow = 100;
    const boundedWindow = Math.max(1, Math.min(Number(windowSize) || 25, maxWindow));
    if (this.isConfidentialEntityReference(entityName, tenantId)) {
      return {
        entity: entityName,
        canonicalKey,
        current: null,
        resolution: {
          windowSize: boundedWindow,
          candidatesInWindow: 0,
          supersededSkipped: 0,
        },
      };
    }

    const fetchWindow = (limit: number) => {
      const rows = this.db.prepare(`
        SELECT sm.id, sm.content, sm.created_by, sm.created_at
        FROM graph_lookup_keys glk
        JOIN shared_memory sm
          ON sm.id = glk.memory_id AND sm.tenant_id = glk.tenant_id
        WHERE glk.tenant_id = ?
          AND glk.lookup_key = ?
          AND glk.memory_type = 'observation'
          AND glk.key_kind = 'entity_name'
          AND sm.memory_type = 'observation'
        ORDER BY sm.created_at DESC, sm.rowid DESC
        LIMIT ?
      `).all(tenantId, canonicalKey, limit) as Array<{
        id: string; content: string; created_by: string; created_at: string;
      }>;

      const parsed = rows.map((row) => {
        let content: any;
        try { content = JSON.parse(row.content); } catch { content = { raw: row.content }; }
        return { row, content };
      }).filter(({ row }) =>
        !this.isConfidentialGraphRow('observation', row.content, tenantId)
      );

      const supersededIds = new Set<string>();
      for (const { content } of parsed) {
        const supersedes = Array.isArray(content?.metadata?.supersedes)
          ? content.metadata.supersedes
          : Array.isArray(content?.supersedes) ? content.supersedes : [];
        for (const supersededId of supersedes) {
          if (typeof supersededId === 'string' && supersededId.trim()) {
            supersededIds.add(supersededId.trim());
          }
        }
      }

      let supersededSkipped = 0;
      let currentEntry: { row: any; content: any } | null = null;
      for (const entry of parsed) {
        if (supersededIds.has(entry.row.id)) {
          supersededSkipped++;
          continue;
        }
        currentEntry = entry;
        break;
      }
      return { parsed, currentEntry, supersededSkipped };
    };

    const shapeCurrent = (entry: { row: any; content: any }) => ({
      id: entry.row.id,
      entityName: entry.content?.entityName ?? entityName,
      timestamp: entry.content?.timestamp || entry.row.created_at,
      createdAt: entry.row.created_at,
      addedBy: entry.content?.addedBy || entry.row.created_by,
      kind: entry.content?.metadata?.kind ?? null,
      canonicalFact: entry.content?.metadata?.canonicalFact ?? null,
      contents: entry.content?.contents ?? [],
      metadata: entry.content?.metadata ?? {},
    });

    let effectiveWindow = boundedWindow;
    let { parsed, currentEntry, supersededSkipped } = fetchWindow(effectiveWindow);
    let widened = false;

    // Degenerate guard: with well-ordered data the newest row can never be
    // superseded (supersedes point backward in time), but anomalous data
    // (mutual/forward-pointing supersedes, clock skew) can mark every row in
    // the window. Widen once, then fall back to the newest row — never report
    // "no current observation" while observations exist.
    if (!currentEntry && parsed.length === effectiveWindow && effectiveWindow < maxWindow) {
      effectiveWindow = maxWindow;
      widened = true;
      ({ parsed, currentEntry, supersededSkipped } = fetchWindow(effectiveWindow));
    }

    let fallback: string | undefined;
    if (!currentEntry && parsed.length > 0) {
      currentEntry = parsed[0];
      fallback = 'all_candidates_superseded_returned_newest';
    }

    return {
      entity: entityName,
      canonicalKey,
      current: currentEntry ? shapeCurrent(currentEntry) : null,
      resolution: {
        windowSize: effectiveWindow,
        candidatesInWindow: parsed.length,
        supersededSkipped,
        ...(widened ? { widened: true } : {}),
        ...(fallback ? { fallback } : {}),
      },
    };
  }

  /**
   * Get a single entity by ID with full content.
   * Searches shared_memory, individual_memory, shared_knowledge, and tasks tables.
   * Used by get_entity_detail tool for the scan-then-detail workflow.
   */
  async getEntityById(entityId: string, tenantId: string = 'default'): Promise<any | null> {
    // Try shared_memory first
    try {
      const row = this.db.prepare(
        `SELECT id, memory_type, content, created_by, created_at FROM shared_memory WHERE id = ? AND tenant_id = ?`
      ).get(entityId, tenantId) as any;
      if (row) {
        if (this.isConfidentialGraphRow(row.memory_type, row.content, tenantId)) {
          return null;
        }
        let content: any;
        try { content = JSON.parse(row.content); } catch { content = { raw: row.content, type: row.memory_type }; }
        return { id: row.id, sourceTable: 'shared_memory', type: 'shared', memoryType: row.memory_type, content, source: row.created_by, createdAt: row.created_at };
      }
    } catch { /* table may not exist */ }

    // Try individual_memory
    try {
      const row = this.db.prepare(
        `SELECT id, agent_id, memory_type, content, importance, created_at FROM individual_memory WHERE id = ? AND tenant_id = ?`
      ).get(entityId, tenantId) as any;
      if (row) {
        let content: any;
        try { content = JSON.parse(row.content); } catch { content = { raw: row.content, type: row.memory_type }; }
        return { id: row.id, sourceTable: 'individual_memory', type: 'individual', memoryType: row.memory_type, content, source: row.agent_id, importance: row.importance, createdAt: row.created_at };
      }
    } catch { /* table may not exist */ }

    // Try shared_knowledge
    try {
      const row = this.db.prepare(
        `SELECT id, title, content, type, source, confidence, created_at FROM shared_knowledge WHERE id = ? AND tenant_id = ?`
      ).get(entityId, tenantId) as any;
      if (row) {
        return { id: row.id, sourceTable: 'shared_knowledge', type: 'shared', memoryType: row.type, content: { id: row.id, title: row.title, content: row.content, type: row.type, source: row.source, confidence: row.confidence }, source: row.source, createdAt: row.created_at };
      }
    } catch { /* table may not exist */ }

    // Try tasks
    try {
      const row = this.db.prepare(
        `SELECT id, title, description, status, created_by, created_at FROM tasks WHERE id = ? AND tenant_id = ?`
      ).get(entityId, tenantId) as any;
      if (row) {
        return { id: row.id, sourceTable: 'tasks', type: 'shared', memoryType: 'task', content: { id: row.id, title: row.title, description: row.description, status: row.status, createdBy: row.created_by }, source: row.created_by, createdAt: row.created_at };
      }
    } catch { /* table may not exist */ }

    return null;
  }

  /**
   * Count unread, non-archived messages for an agent within a tenant.
   */
  countUnreadMessages(agentId: string, tenantId: string = 'default'): number {
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    if (recipientAliases.length === 0) return 0;
    try {
      this.ensureReadAtColumn();
      this.ensureArchivedAtColumn();
      const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt
         FROM ai_messages
         WHERE to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND read_at IS NULL AND archived_at IS NULL AND superseded_at IS NULL`
      ).get(...recipientAliases, tenantId) as any;
      return row?.cnt ?? 0;
    } catch {
      // Legacy fallback: pre-migration rows have no read/archive tracking, treat all as unread.
      try {
        const rows = this.db.prepare(
          `SELECT content
           FROM shared_memory
           WHERE tenant_id = ? AND memory_type = 'ai_message'`
        ).all(tenantId) as Array<{ content: string }>;
        let count = 0;
        for (const row of rows) {
          try {
            const payload = JSON.parse(row.content || '{}');
            const toAgent = payload.to || payload.target || payload.to_agent;
            if (recipientAliases.includes(toAgent)) count += 1;
          } catch {
            // ignore malformed row
          }
        }
        return count;
      } catch {
        return 0;
      }
    }
  }

  /**
   * Ensure read_at column exists on ai_messages table (idempotent).
   */
  private _readAtColumnChecked = false;
  private ensureReadAtColumn(): void {
    if (this._readAtColumnChecked) return;
    if (ensureReadAtColumnImpl(this.db)) this._readAtColumnChecked = true;
  }

  // ─── Message Hygiene: summary column migration ───
  private _summaryColumnChecked = false;
  private ensureSummaryColumn(): void {
    if (this._summaryColumnChecked) return;
    if (ensureSummaryColumnImpl(this.db)) this._summaryColumnChecked = true;
  }

  /**
   * Generate a summary for a message on write.
   * Short messages (<=200 chars): summary = content.
   * Longer: first line truncated to 120 chars + approx token count.
   */
  static generateSummary(content: string): string {
    if (content.length <= 200) return content;
    const firstLine = content.split('\n')[0].slice(0, 120);
    const approxTokens = Math.ceil(content.length / 4);
    return `${firstLine} [~${approxTokens} tokens]`;
  }

  // ─── Task 1200: archived_at column migration ───
  private _archivedAtColumnChecked = false;
  private ensureArchivedAtColumn(): void {
    if (this._archivedAtColumnChecked) return;
    if (ensureArchivedAtColumnImpl(this.db)) this._archivedAtColumnChecked = true;
  }

  private _messageSupersessionColumnsChecked = false;
  private ensureMessageSupersessionColumns(): void {
    if (this._messageSupersessionColumnsChecked) return;
    if (ensureMessageSupersessionColumnsImpl(this.db)) this._messageSupersessionColumnsChecked = true;
  }

  private _messageDeliveryColumnChecked = false;
  private ensureMessageDeliveryColumn(): void {
    if (this._messageDeliveryColumnChecked) return;
    if (ensureMessageDeliveryColumnImpl(this.db)) this._messageDeliveryColumnChecked = true;
  }

  /**
   * Task 1200: Mark specific messages as read, or all unread messages for an agent.
   * Returns count of messages marked.
   */
  markMessagesRead(
    agentId: string,
    messageIds?: string[],
    tenantId: string = 'default'
  ): number {
    this.ensureReadAtColumn();
    this.ensureMessageDeliveryColumn();
    const now = new Date().toISOString();
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    if (recipientAliases.length === 0) return 0;
    const recipientPlaceholders = recipientAliases.map(() => '?').join(',');

    if (messageIds && messageIds.length > 0) {
      // Mark specific messages
      const placeholders = messageIds.map(() => '?').join(',');
      const result = this.db.prepare(
        `UPDATE ai_messages
         SET read_at = ?, delivered_at = COALESCE(delivered_at, ?)
         WHERE id IN (${placeholders}) AND to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND read_at IS NULL`
      ).run(now, now, ...messageIds, ...recipientAliases, tenantId);
      return result.changes;
    } else {
      // Mark all unread for this agent
      const result = this.db.prepare(
        `UPDATE ai_messages
         SET read_at = ?, delivered_at = COALESCE(delivered_at, ?)
         WHERE to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND read_at IS NULL`
      ).run(now, now, ...recipientAliases, tenantId);
      return result.changes;
    }
  }

  /**
   * Task 1200 / Engram comms surface: archive messages for an agent — either
   * specific messageIds (per-message archive, used by the dashboard inbox), or
   * all messages older than N days. Both paths are scoped to the agent's own
   * recipient aliases. Returns count of messages archived.
   */
  archiveMessages(
    agentId: string,
    olderThanDays?: number,
    tenantId: string = 'default',
    messageIds?: string[]
  ): number {
    return this.archiveMessagesDetailed(
      agentId,
      olderThanDays,
      tenantId,
      messageIds,
      false
    ).archived;
  }

  /**
   * Archive a scoped message set and optionally acknowledge that exact set in
   * one SQLite transaction. The existing archiveMessages() number-returning
   * wrapper remains for internal compatibility.
   */
  archiveMessagesDetailed(
    agentId: string,
    olderThanDays?: number,
    tenantId: string = 'default',
    messageIds?: string[],
    markAsRead: boolean = false
  ): {
    archived: number;
    markedAsRead: number;
    remainingUnarchived: number;
    remainingUnread: number;
  } {
    this.ensureReadAtColumn();
    this.ensureArchivedAtColumn();
    this.ensureMessageDeliveryColumn();
    this.ensureMessageSupersessionColumns();
    const now = new Date().toISOString();
    const recipientAliases = this.getMailboxAliases(agentId, tenantId);
    if (recipientAliases.length === 0) {
      return { archived: 0, markedAsRead: 0, remainingUnarchived: 0, remainingUnread: 0 };
    }
    const recipientPlaceholders = recipientAliases.map(() => '?').join(',');
    const scopedIds = Array.isArray(messageIds) ? messageIds : [];
    const byId = scopedIds.length > 0;
    let targetWhere: string;
    let targetParams: any[];

    if (byId) {
      const placeholders = scopedIds.map(() => '?').join(',');
      targetWhere = `id IN (${placeholders}) AND to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND archived_at IS NULL`;
      targetParams = [...scopedIds, ...recipientAliases, tenantId];
    } else {
      const cutoff = new Date(Date.now() - (olderThanDays ?? 30) * 86400000).toISOString();
      targetWhere = `to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND created_at < ? AND archived_at IS NULL`;
      targetParams = [...recipientAliases, tenantId, cutoff];
    }

    const run = this.db.transaction(() => {
      let markedAsRead = 0;
      if (markAsRead) {
        markedAsRead = this.db.prepare(
          `UPDATE ai_messages
           SET read_at = ?, delivered_at = COALESCE(delivered_at, ?)
           WHERE ${targetWhere} AND read_at IS NULL`
        ).run(now, now, ...targetParams).changes;
      }

      const archived = this.db.prepare(
        `UPDATE ai_messages SET archived_at = ? WHERE ${targetWhere}`
      ).run(now, ...targetParams).changes;

      const remaining = this.db.prepare(
        `SELECT
           COUNT(*) AS unarchived,
           SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM ai_messages
         WHERE to_agent IN (${recipientPlaceholders}) AND tenant_id = ? AND archived_at IS NULL AND superseded_at IS NULL`
      ).get(...recipientAliases, tenantId) as any;

      return {
        archived,
        markedAsRead,
        remainingUnarchived: Number(remaining?.unarchived || 0),
        remainingUnread: Number(remaining?.unread || 0),
      };
    });

    return run();
  }

  // ─── Task 1100: User Profile methods ───

  /**
   * Get a user profile by userId within a tenant.
   */
  getUserProfile(userId: string, tenantId: string = 'default'): any | null {
    try {
      const row = this.db.prepare(
        'SELECT * FROM users WHERE id = ? AND tenant_id = ?'
      ).get(userId, tenantId) as any;
      if (!row) return null;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        displayName: row.display_name,
        timezone: row.timezone,
        locale: row.locale,
        dateFormat: row.date_format,
        units: row.units,
        workingHours: row.working_hours ? JSON.parse(row.working_hours) : null,
        lastSeenTz: row.last_seen_tz,
        prefsVersion: row.prefs_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Update a user profile. Merges provided fields, bumps prefs_version.
   * Returns the updated profile.
   */
  updateUserProfile(
    userId: string,
    updates: {
      displayName?: string;
      timezone?: string;
      locale?: string;
      dateFormat?: string;
      units?: string;
      workingHours?: { start: string; end: string };
    },
    tenantId: string = 'default'
  ): any | null {
    const existing = this.getUserProfile(userId, tenantId);
    if (!existing) return null;

    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.displayName !== undefined) { setClauses.push('display_name = ?'); params.push(updates.displayName); }
    if (updates.timezone !== undefined) { setClauses.push('timezone = ?'); params.push(updates.timezone); }
    if (updates.locale !== undefined) { setClauses.push('locale = ?'); params.push(updates.locale); }
    if (updates.dateFormat !== undefined) { setClauses.push('date_format = ?'); params.push(updates.dateFormat); }
    if (updates.units !== undefined) { setClauses.push('units = ?'); params.push(updates.units); }
    if (updates.workingHours !== undefined) { setClauses.push('working_hours = ?'); params.push(JSON.stringify(updates.workingHours)); }

    if (setClauses.length === 0) return existing;

    setClauses.push("prefs_version = prefs_version + 1");
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`;
    params.push(userId, tenantId);
    this.db.prepare(sql).run(...params);

    return this.getUserProfile(userId, tenantId);
  }

  /**
   * Update last_seen_tz for a user (from X-User-Timezone header).
   * Fire-and-forget; never throws.
   */
  updateLastSeenTz(userId: string, timezone: string, tenantId: string = 'default'): void {
    try {
      this.db.prepare(
        `UPDATE users SET last_seen_tz = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`
      ).run(timezone, userId, tenantId);
    } catch { /* non-fatal */ }
  }

  /**
   * Check if ai_messages table exists (for graceful migration detection)
   */
  hasAiMessagesTable(): boolean {
    try {
      const result = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_messages'"
      ).get() as any;
      return !!result;
    } catch {
      return false;
    }
  }

  // ─── Phase A: Knowledge Graph Mutation Helpers ───

  /**
   * Escape special SQL LIKE characters in a pattern substring.
   * Codex finding #7: escape % and _ before wrapping with %..%
   */
  static escapeLikePattern(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  /**
   * Authorize a graph mutation using ONLY the RequestContext (codex findings #1, #2).
   * Never trusts tool args for identity.
   */
  authorizeGraphMutation(
    action: string,
    context: RequestContext
  ): { authorized: boolean; reason?: string } {
    return authorizeGraphMutationImpl(action, context);
  }

  // ─── BV-S1: Graph Export Read Authorization + Data Access ───

  /**
   * Permission vocabulary for graph read operations:
   *   graph:view              — topology (nodes + links). Minimum to access endpoint.
   *   graph:observations:view — non-sensitive observations.
   *   graph:sensitive:view    — agent-internal/system observations.
   *   Legacy: graph:read, graph:write, * imply graph:view + graph:observations:view.
   */
  authorizeGraphRead(
    context: RequestContext
  ): { permissions: Set<string>; authorized: boolean; reason?: string } {
    return authorizeGraphReadImpl(context);
  }

  /**
   * Deterministic 4-step sensitivity classification for an observation row.
   * contents is string[] — any match in any entry → entire observation is sensitive.
   */
  static classifyObservationSensitivity(
    observationContent: { entityName: string; contents: string[]; messageType?: string; sensitive?: boolean }
  ): boolean {
    return classifyObservationSensitivityImpl(observationContent);
  }

  /**
   * Fetch graph data for export (tenant-scoped).
   * Returns entities (nodes), relations (links), and optionally observations.
   */
  getGraphExport(options: {
    tenantId: string;
    limit: number;
    cursor?: string;
    includeObservations: boolean;
    updatedSince?: string;
    entityName?: string;
    permissions: Set<string>;
  }): {
    nodes?: any[];
    links?: any[];
    observations?: any[];
    nextCursor: string | null;
    totals: { nodes?: number; links?: number; observations: number };
    maxUpdatedAt?: string;
  } {
    const { tenantId, limit, cursor, includeObservations, updatedSince, entityName, permissions } = options;
    const offset = cursor ? parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0 : 0;
    const canSeeSensitive = permissions.has('graph:sensitive:view');

    // entityName mode: observations-only
    if (entityName) {
      if (this.isConfidentialEntityReference(entityName, tenantId)) {
        return { observations: [], nextCursor: null, totals: { observations: 0 } };
      }
      let obsQuery = `SELECT id, content, created_at, updated_at FROM shared_memory
        WHERE tenant_id = ? AND memory_type = 'observation'
        AND CASE WHEN json_valid(content)
          THEN json_extract(content, '$.entityName') END = ?`;
      const obsParams: any[] = [tenantId, entityName];
      if (updatedSince) {
        obsQuery += ' AND updated_at >= ?';
        obsParams.push(updatedSince);
      }
      obsQuery += ' ORDER BY created_at ASC';

      const allObs = this.db.prepare(obsQuery).all(...obsParams) as any[];
      const filtered = this.filterAndMapObservations(allObs, canSeeSensitive, tenantId);

      // Apply pagination to filtered observations
      const paged = filtered.observations.slice(offset, offset + limit);
      const nextOffset = offset + limit;
      const nextCursor = nextOffset < filtered.observations.length
        ? Buffer.from(String(nextOffset)).toString('base64')
        : null;

      return {
        observations: paged,
        nextCursor,
        totals: { observations: filtered.observations.length },
        maxUpdatedAt: filtered.maxUpdatedAt || undefined,
      };
    }

    // Full mode: nodes + links + optional observations
    // Nodes (entities)
    let entityQuery = `SELECT id, content, created_at, updated_at FROM shared_memory
      WHERE tenant_id = ? AND memory_type = 'entity'
      AND NOT (
        json_valid(content)
        AND (
          LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
          OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
          OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
          OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
        )
      )`;
    const entityParams: any[] = [tenantId];
    if (updatedSince) {
      entityQuery += ' AND updated_at >= ?';
      entityParams.push(updatedSince);
    }
    entityQuery += ' ORDER BY created_at ASC';

    const entityRows = (this.db.prepare(entityQuery).all(...entityParams) as any[]).filter((row: any) =>
      !this.isConfidentialGraphRow('entity', row.content, tenantId)
    );
    const updTracker = { max: undefined as string | undefined };

    const nodes = entityRows.map((row: any) => {
      const content = JSON.parse(row.content);
      // Count only public observations for this entity. A corrupt historical
      // child can carry a public-looking entityName while metadata.entityId
      // still points at private mailbox data; including it in this aggregate
      // would leak private-row existence even when the body is filtered.
      const obsCount = (this.db.prepare(
        `SELECT content FROM shared_memory
         WHERE tenant_id = ? AND memory_type = 'observation'
         AND CASE WHEN json_valid(content)
           THEN json_extract(content, '$.entityName') END = ?`
      ).all(tenantId, content.name) as Array<{ content: string }>)
        .filter((observation) =>
          !this.isConfidentialGraphRow('observation', observation.content, tenantId)
        ).length;

      // Track max updated_at from included entity rows
      if (row.updated_at && (!updTracker.max || row.updated_at > updTracker.max)) {
        updTracker.max = row.updated_at;
      }

      return {
        name: content.name,
        entityType: content.entityType || content.type,
        observationCount: obsCount,
        id: row.id,
        createdAt: row.created_at,
      };
    });

    // Links (relations)
    let relQuery = `SELECT id, content, created_at, updated_at FROM shared_memory
      WHERE tenant_id = ? AND memory_type = 'relation'`;
    const relParams: any[] = [tenantId];
    if (updatedSince) {
      relQuery += ' AND updated_at >= ?';
      relParams.push(updatedSince);
    }
    relQuery += ' ORDER BY created_at ASC';

    const relRows = (this.db.prepare(relQuery).all(...relParams) as any[]).filter((row: any) =>
      !this.isConfidentialGraphRow('relation', row.content, tenantId)
    );
    const links = relRows.map((row: any) => {
      const content = JSON.parse(row.content);
      // Track max updated_at from included relation rows
      if (row.updated_at && (!updTracker.max || row.updated_at > updTracker.max)) {
        updTracker.max = row.updated_at;
      }
      return {
        source: content.from,
        target: content.to,
        relationType: content.relationType,
      };
    });

    // Observations (optional)
    let observations: any[] | undefined;
    let totalObs = 0;
    if (includeObservations) {
      let obsQuery = `SELECT id, content, created_at, updated_at FROM shared_memory
        WHERE tenant_id = ? AND memory_type = 'observation'`;
      const obsParams: any[] = [tenantId];
      if (updatedSince) {
        obsQuery += ' AND updated_at >= ?';
        obsParams.push(updatedSince);
      }
      obsQuery += ' ORDER BY created_at ASC';

      const allObs = this.db.prepare(obsQuery).all(...obsParams) as any[];
      const filtered = this.filterAndMapObservations(allObs, canSeeSensitive, tenantId);
      totalObs = filtered.observations.length;
      observations = filtered.observations;
      // Include observation max in overall max
      if (filtered.maxUpdatedAt && (!updTracker.max || filtered.maxUpdatedAt > updTracker.max)) {
        updTracker.max = filtered.maxUpdatedAt;
      }
    }

    // Paginate the combined result by nodes
    const pagedNodes = nodes.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < nodes.length
      ? Buffer.from(String(nextOffset)).toString('base64')
      : null;

    return {
      nodes: pagedNodes,
      links,
      observations,
      nextCursor,
      totals: {
        nodes: nodes.length,
        links: links.length,
        observations: totalObs,
      },
      maxUpdatedAt: updTracker.max,
    };
  }

  /**
   * Filter observations by sensitivity and map to export shape.
   */
  private filterAndMapObservations(
    rows: any[],
    canSeeSensitive: boolean,
    tenantId: string
  ): { observations: any[]; maxUpdatedAt: string | null } {
    const result: any[] = [];
    let maxUpdatedAt: string | null = null;
    for (const row of rows) {
      if (this.isConfidentialGraphRow('observation', row.content, tenantId)) continue;
      let content: any;
      try {
        content = JSON.parse(row.content);
      } catch {
        // The classifier above rejects malformed graph rows. Keep this guard
        // for concurrent/corrupt storage rather than failing the whole export.
        continue;
      }
      const isSensitive = MemoryManager.classifyObservationSensitivity(content);
      if (isSensitive && !canSeeSensitive) continue;
      result.push({
        id: row.id,
        entityName: content.entityName,
        contents: content.contents || [],
        metadata: content.metadata || {},
        addedBy: content.addedBy,
        createdAt: row.created_at,
      });
      if (row.updated_at && (!maxUpdatedAt || row.updated_at > maxUpdatedAt)) {
        maxUpdatedAt = row.updated_at;
      }
    }
    return { observations: result, maxUpdatedAt };
  }

  private isGraphMemoryType(type: string): type is GraphMemoryType {
    return type === 'entity' || type === 'observation' || type === 'relation';
  }

  private addGraphLookupEntry(
    entries: Map<string, GraphLookupEntry>,
    rawValue: any,
    keyKind: string,
    weight: number
  ): void {
    if (typeof rawValue !== 'string') return;
    const lookupKey = this.normalizeEntityLookup(rawValue);
    if (!lookupKey) return;

    const existing = entries.get(lookupKey);
    if (!existing || weight > existing.weight) {
      entries.set(lookupKey, { lookupKey, keyKind, weight });
    }
  }

  private addGraphLookupVariants(
    entries: Map<string, GraphLookupEntry>,
    value: any,
    keyKind: string,
    weight: number
  ): void {
    if (typeof value !== 'string' || !value.trim()) return;
    for (const variant of this.entityLookupVariants(value)) {
      this.addGraphLookupEntry(entries, variant, keyKind, weight);
    }
  }

  private addGraphLookupHandles(
    entries: Map<string, GraphLookupEntry>,
    value: any,
    keyKind: string,
    weight: number
  ): void {
    if (typeof value !== 'string' || !value.trim()) return;
    // ENG-2 index diet: content-derived handles are indexed under their plain
    // normalized key only. Variant fabrication (company suffixes, acronyms)
    // stays reserved for entity names/aliases — running it over every
    // token-ish handle in free text multiplied the lookup index ~6-10x with
    // junk keys (measured 2026-07-06: 838k of 1.0M rows were handle kinds).
    // Query-side expansion (entityQueryVariants) still bridges real lookups.
    for (const handle of this.extractLookupHandles(value)) {
      this.addGraphLookupEntry(entries, handle, keyKind, weight);
    }
  }

  private graphLookupEntriesForContent(content: any, memoryType: GraphMemoryType): GraphLookupEntry[] {
    const entries = new Map<string, GraphLookupEntry>();
    const inlineObservationsMaterialized = memoryType === 'entity' &&
      content?.metadata?.inlineObservationsMaterialized === true;
    const derivedContent = inlineObservationsMaterialized
      ? { ...content, observations: [] }
      : content;

    for (const value of this.entityLookupValues(derivedContent || {})) {
      this.addGraphLookupEntry(entries, value, 'derived', 50);
    }

    if (memoryType === 'entity') {
      this.addGraphLookupVariants(entries, content?.name, 'canonical_name', 100);
      if (Array.isArray(content?.aliases)) {
        for (const alias of content.aliases) {
          this.addGraphLookupVariants(entries, alias, 'alias', 95);
        }
      }
      if (!inlineObservationsMaterialized && Array.isArray(content?.observations)) {
        for (const observation of content.observations) {
          this.addGraphLookupHandles(entries, observation, 'embedded_observation_handle', 70);
        }
      }
      if (Array.isArray(content?.agentBootstrap)) {
        for (const bootstrap of content.agentBootstrap) {
          this.addGraphLookupHandles(entries, bootstrap, 'agent_bootstrap_handle', 65);
        }
      }
    }

    if (memoryType === 'observation') {
      this.addGraphLookupVariants(entries, content?.entityName, 'entity_name', 95);
      if (Array.isArray(content?.appliesTo)) {
        for (const appliesTo of content.appliesTo) {
          this.addGraphLookupVariants(entries, appliesTo, 'applies_to', 85);
        }
      }
      if (Array.isArray(content?.metadata?.appliesTo)) {
        for (const appliesTo of content.metadata.appliesTo) {
          this.addGraphLookupVariants(entries, appliesTo, 'metadata_applies_to', 85);
        }
      }
      if (Array.isArray(content?.contents)) {
        for (const item of content.contents) {
          this.addGraphLookupHandles(entries, item, 'observation_handle', 75);
        }
      }
      this.addGraphLookupHandles(entries, content?.metadata?.canonicalFact, 'canonical_fact_handle', 80);
    }

    if (memoryType === 'relation') {
      this.addGraphLookupVariants(entries, content?.from, 'relation_from', 90);
      this.addGraphLookupVariants(entries, content?.to, 'relation_to', 90);
    }

    // ENG-2 index diet: cap keys per memory. Highest-weight entries survive
    // (entity names/aliases/entity_name at 90-100 always fit; only long-tail
    // content handles get trimmed). Ties break on lookupKey so rebuilds are
    // deterministic. Measured worst case before the cap: 1,927 keys for one
    // memory.
    const all = Array.from(entries.values());
    if (all.length <= MemoryManager.MAX_LOOKUP_KEYS_PER_MEMORY) return all;
    return all
      .sort((a, b) => (b.weight - a.weight) || (a.lookupKey < b.lookupKey ? -1 : 1))
      .slice(0, MemoryManager.MAX_LOOKUP_KEYS_PER_MEMORY);
  }

  private replaceGraphLookupIndexForMemory(
    memoryId: string,
    tenantId: string,
    memoryType: GraphMemoryType,
    content: any,
    deleteStmt?: Database.Statement,
    insertStmt?: Database.Statement
  ): number {
    const entries = this.graphLookupEntriesForContent(content, memoryType);
    const del = deleteStmt || this.db.prepare(
      'DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?'
    );
    const insert = insertStmt || this.db.prepare(`
      INSERT INTO graph_lookup_keys (tenant_id, lookup_key, memory_type, memory_id, key_kind, weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, lookup_key, memory_type, memory_id) DO UPDATE SET
        key_kind = excluded.key_kind,
        weight = excluded.weight,
        updated_at = CURRENT_TIMESTAMP
    `);

    del.run(tenantId, memoryId);
    for (const entry of entries) {
      insert.run(tenantId, entry.lookupKey, memoryType, memoryId, entry.keyKind, entry.weight);
    }
    return entries.length;
  }

  private refreshGraphLookupIndexForMemory(
    memoryId: string,
    tenantId: string,
    memoryType: string,
    content: any
  ): void {
    if (!this.isGraphMemoryType(memoryType)) return;

    // Entity writes can create, remove, or rename a historical private
    // message-detail reference (including its aliases). Invalidate before any
    // caller can classify materialized observations against stale state.
    if (memoryType === 'entity') {
      this.confidentialEntityReferenceCache.delete(tenantId);
    }

    try {
      const replace = this.db.transaction(() => {
        this.replaceGraphLookupIndexForMemory(memoryId, tenantId, memoryType, content);
      });
      replace();
    } catch (error: any) {
      console.warn(`⚠️ Failed to refresh graph lookup index for ${memoryId}:`, error?.message || error);
    }
  }

  public rebuildGraphLookupIndex(tenantId?: string): { rowsIndexed: number; keysIndexed: number } {
    // A rebuild is also a synchronization boundary for the private-entity
    // reference cache. Direct database maintenance can change an entity's
    // name/aliases without passing through store(), so never classify child
    // observations against references captured before the rebuild.
    if (tenantId) {
      this.confidentialEntityReferenceCache.delete(tenantId);
    } else {
      this.confidentialEntityReferenceCache.clear();
    }

    const params: any[] = [];
    let where = "WHERE memory_type IN ('entity', 'observation', 'relation')";
    if (tenantId) {
      where += ' AND tenant_id = ?';
      params.push(tenantId);
    }

    const rows = this.db.prepare(`
      SELECT id, COALESCE(tenant_id, 'default') as tenant_id, memory_type, content
      FROM shared_memory
      ${where}
      ORDER BY created_at ASC
    `).all(...params) as Array<{ id: string; tenant_id: string; memory_type: string; content: string }>;

    const deleteAll = tenantId
      ? this.db.prepare('DELETE FROM graph_lookup_keys WHERE tenant_id = ?')
      : this.db.prepare('DELETE FROM graph_lookup_keys');
    const deleteRow = this.db.prepare('DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO graph_lookup_keys (tenant_id, lookup_key, memory_type, memory_id, key_kind, weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, lookup_key, memory_type, memory_id) DO UPDATE SET
        key_kind = excluded.key_kind,
        weight = excluded.weight,
        updated_at = CURRENT_TIMESTAMP
    `);

    let rowsIndexed = 0;
    let keysIndexed = 0;
    const rebuild = this.db.transaction(() => {
      if (tenantId) {
        deleteAll.run(tenantId);
      } else {
        deleteAll.run();
      }

      for (const row of rows) {
        if (!this.isGraphMemoryType(row.memory_type)) continue;
        let content: any;
        try {
          content = JSON.parse(row.content || '{}');
        } catch {
          continue;
        }
        keysIndexed += this.replaceGraphLookupIndexForMemory(
          row.id,
          row.tenant_id || 'default',
          row.memory_type,
          content,
          deleteRow,
          insert
        );
        rowsIndexed++;
      }
    });
    rebuild();

    if (tenantId) {
      this.confidentialEntityReferenceCache.delete(tenantId);
    } else {
      this.confidentialEntityReferenceCache.clear();
    }

    return { rowsIndexed, keysIndexed };
  }

  public async materializeInlineObservations(
    agentId: string,
    entityId: string,
    entityName: string,
    observations: any[],
    tenantId: string = 'default',
    context?: RequestContext
  ): Promise<any[]> {
    if (!Array.isArray(observations) || observations.length === 0) return [];
    if (
      this.isConfidentialEntityReference(entityId, tenantId)
      || this.isConfidentialEntityReference(entityName, tenantId)
    ) {
      throw new Error('message_detail is reserved for private mailbox compatibility');
    }

    const materialized: any[] = [];
    let validInlineObservationCount = 0;
    for (let inlineIndex = 0; inlineIndex < observations.length; inlineIndex++) {
      const raw = observations[inlineIndex];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      validInlineObservationCount++;

      const contentHash = MemoryManager.contentHash(raw);
      const inlineKey = `${entityId}:${inlineIndex}:${contentHash}`;
      const existing = this.db.prepare(
        `SELECT id, content, created_by, created_at
         FROM shared_memory
         WHERE tenant_id = ?
           AND memory_type = 'observation'
           AND json_valid(content)
           AND json_extract(content, '$.metadata.inlineKey') = ?
         LIMIT 1`
      ).get(tenantId, inlineKey) as any;

      if (existing) {
        let existingContent: any = {};
        try {
          existingContent = JSON.parse(existing.content || '{}');
        } catch {}
        materialized.push({
          id: existing.id,
          ...existingContent,
          skipped: true,
          skipReason: 'existing_inline_observation',
        });
        continue;
      }

      const observationData = {
        entityName,
        contents: [raw],
        addedBy: agentId,
        timestamp: new Date().toISOString(),
        metadata: {
          source: 'create_entities_inline',
          entityId,
          inlineIndex,
          inlineKey,
          contentHash,
          canonicalEntityKey: this.normalizeEntityLookup(entityName),
          vectorEmbedded: true,
          relationshipsUpdated: true,
        },
      };

      const observationId = await this.store(agentId, observationData, 'shared', 'observation', tenantId, context);
      materialized.push({ id: observationId, ...observationData });
    }

    if (validInlineObservationCount > 0 && materialized.length === validInlineObservationCount) {
      this.markEntityInlineObservationsMaterialized(entityId, tenantId, materialized);
    }

    return materialized;
  }

  private markEntityInlineObservationsMaterialized(
    entityId: string,
    tenantId: string,
    materialized: any[]
  ): void {
    try {
      const row = this.db.prepare(
        `SELECT content
         FROM shared_memory
         WHERE id = ? AND tenant_id = ? AND memory_type = 'entity'
         LIMIT 1`
      ).get(entityId, tenantId) as any;
      if (!row) return;

      let content: any;
      try {
        content = JSON.parse(row.content || '{}');
      } catch {
        return;
      }
      if (!content || typeof content !== 'object') return;

      const hashes = Array.from(new Set(
        materialized
          .map((obs) => obs?.metadata?.contentHash)
          .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0)
      ));

      content.metadata = {
        ...(content.metadata && typeof content.metadata === 'object' ? content.metadata : {}),
        inlineObservationsMaterialized: true,
        materializedInlineObservationCount: materialized.length,
        materializedInlineObservationHashes: hashes,
      };

      this.db.prepare(
        `UPDATE shared_memory
         SET content = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tenant_id = ? AND memory_type = 'entity'`
      ).run(JSON.stringify(content), entityId, tenantId);

      this.refreshGraphLookupIndexForMemory(entityId, tenantId, 'entity', content);
    } catch (error: any) {
      console.warn(`⚠️ Failed to mark inline observations materialized for entity ${entityId}:`, error?.message || error);
    }
  }

  private backfillGraphLookupIndexIfEmpty(): void {
    try {
      const lookupCount = (this.db.prepare(
        'SELECT COUNT(*) as cnt FROM graph_lookup_keys'
      ).get() as any)?.cnt || 0;
      if (lookupCount > 0) return;

      const graphCount = (this.db.prepare(
        "SELECT COUNT(*) as cnt FROM shared_memory WHERE memory_type IN ('entity', 'observation', 'relation')"
      ).get() as any)?.cnt || 0;
      if (graphCount === 0) return;

      const result = this.rebuildGraphLookupIndex();
      console.log(`🔎 Backfilled graph lookup index: ${result.rowsIndexed} rows, ${result.keysIndexed} keys`);
    } catch (error: any) {
      console.warn('⚠️ Graph lookup index backfill skipped:', error?.message || error);
    }
  }

  private graphLookupIndexHasRows(tenantId: string): boolean {
    try {
      const row = this.db.prepare(
        'SELECT 1 FROM graph_lookup_keys WHERE tenant_id = ? LIMIT 1'
      ).get(tenantId) as any;
      return !!row;
    } catch {
      return false;
    }
  }

  private findRowsByLookupIndexValues(
    lookupValues: Iterable<string>,
    tenantId: string,
    memoryTypes: GraphMemoryType[]
  ): { usedIndex: boolean; rows: any[] } {
    const lookupKeys = Array.from(new Set(
      Array.from(lookupValues)
        .map((value) => this.normalizeEntityLookup(value))
        .filter(Boolean)
    ));
    const usedIndex = this.graphLookupIndexHasRows(tenantId);
    if (!usedIndex || lookupKeys.length === 0 || memoryTypes.length === 0) {
      return { usedIndex, rows: [] };
    }

    const rowsById = new Map<string, any>();
    const typePlaceholders = memoryTypes.map(() => '?').join(',');
    const maxKeysPerQuery = Math.max(1, 900 - memoryTypes.length);

    for (let i = 0; i < lookupKeys.length; i += maxKeysPerQuery) {
      const keyChunk = lookupKeys.slice(i, i + maxKeysPerQuery);
      const keyPlaceholders = keyChunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT
          sm.id,
          sm.content,
          sm.created_by,
          sm.created_at,
          sm.owner_actor_type,
          sm.owner_actor_id,
          sm.memory_type,
          MAX(gl.weight) as lookup_weight,
          GROUP_CONCAT(DISTINCT gl.key_kind) as lookup_key_kinds
        FROM graph_lookup_keys gl
        JOIN shared_memory sm
          ON sm.id = gl.memory_id
         AND sm.tenant_id = gl.tenant_id
         AND sm.memory_type = gl.memory_type
        WHERE gl.tenant_id = ?
          AND gl.lookup_key IN (${keyPlaceholders})
          AND gl.memory_type IN (${typePlaceholders})
        GROUP BY sm.id
        ORDER BY MAX(gl.weight) DESC, sm.created_at DESC
      `).all(tenantId, ...keyChunk, ...memoryTypes) as any[];

      for (const row of rows) {
        const existing = rowsById.get(row.id);
        if (!existing || (row.lookup_weight || 0) > (existing.lookup_weight || 0)) {
          rowsById.set(row.id, row);
        }
      }
    }

    return {
      usedIndex,
      rows: Array.from(rowsById.values()).sort((a: any, b: any) =>
        (b.lookup_weight || 0) - (a.lookup_weight || 0) ||
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      ),
    };
  }

  /**
   * Normalize human-entered entity names for alias resolution.
   * This keeps the caller workflow natural: "ascend-consult" can resolve to
   * the canonical graph entity "Ascend-Consult-LLC" without a separate tool.
   */
  private normalizeEntityLookup(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  public canonicalEntityKey(value: string): string {
    return this.normalizeEntityLookup(value);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1"
    ).get(tableName) as any;
    return !!row;
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    if (!this.tableExists(tableName)) return false;
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    return rows.some((row: any) => row.name === columnName);
  }

  private countTableRows(tableName: string, tenantId?: string): number {
    if (!this.tableExists(tableName)) return 0;
    if (tenantId && this.tableHasColumn(tableName, 'tenant_id')) {
      return (this.db.prepare(`SELECT COUNT(*) as cnt FROM ${tableName} WHERE tenant_id = ?`).get(tenantId) as any)?.cnt || 0;
    }
    return (this.db.prepare(`SELECT COUNT(*) as cnt FROM ${tableName}`).get() as any)?.cnt || 0;
  }

  private entityLookupVariants(value: string): string[] {
    const normalized = this.normalizeEntityLookup(value);
    if (!normalized) return [];

    const variants = new Set<string>([normalized]);
    const parts = normalized.split('-').filter(Boolean);

    for (const suffix of ['-llc', '-inc', '-corp', '-co', '-company']) {
      if (normalized.endsWith(suffix)) {
        variants.add(normalized.slice(0, -suffix.length));
      } else {
        variants.add(`${normalized}${suffix}`);
      }
    }
    if (/-v\d{1,3}$/.test(normalized)) {
      variants.add(normalized.replace(/-v\d{1,3}$/, ''));
    }
    if (parts.length >= 2) {
      variants.add(parts.slice(0, 2).join('-'));
    }
    if (parts.length >= 3) {
      variants.add(parts.slice(0, 3).join('-'));
      variants.add(parts.map((part) => part[0]).join(''));
      variants.add(`${parts[0][0]}${parts[1][0]}-${parts[2]}`);
    }
    if (parts.length >= 4) {
      variants.add(`${parts[0][0]}${parts[1][0]}-${parts.slice(2, 4).join('-')}`);
    }
    return Array.from(variants).filter(Boolean);
  }

  private entityQueryVariants(value: string): string[] {
    const normalized = this.normalizeEntityLookup(value);
    if (!normalized) return [];

    const variants = new Set<string>([normalized]);
    for (const suffix of ['-llc', '-inc', '-corp', '-co', '-company']) {
      if (normalized.endsWith(suffix)) {
        variants.add(normalized.slice(0, -suffix.length));
      } else {
        variants.add(`${normalized}${suffix}`);
      }
    }
    if (/-v\d{1,3}$/.test(normalized)) {
      variants.add(normalized.replace(/-v\d{1,3}$/, ''));
    }
    return Array.from(variants).filter(Boolean);
  }

  private extractLookupHandles(value: string): string[] {
    const handles = new Set<string>();
    const pattern = /\b[a-zA-Z][a-zA-Z0-9]*(?:[._/-][a-zA-Z0-9]+)+\b/g;
    for (const match of value.matchAll(pattern)) {
      const raw = match[0];
      const normalized = this.normalizeEntityLookup(raw);
      if (normalized.length >= 3 && /[a-z]/.test(normalized)) {
        handles.add(raw);
      }
    }
    return Array.from(handles);
  }

  private entityLookupValues(content: any): string[] {
    const values = new Set<string>();
    const add = (value: any, mode: 'full' | 'handles' = 'full') => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (mode === 'full') {
        const normalized = this.normalizeEntityLookup(trimmed);
        if (normalized) values.add(normalized);
        for (const variant of this.entityLookupVariants(trimmed)) values.add(variant);
      }
      // ENG-2 index diet: extracted content handles stay plain — variant
      // fabrication is reserved for named fields ('full' mode above). See
      // addGraphLookupHandles for the measured rationale.
      for (const handle of this.extractLookupHandles(trimmed)) {
        const normalized = this.normalizeEntityLookup(handle);
        if (normalized) values.add(normalized);
      }
    };
    const addMany = (value: any, mode: 'full' | 'handles' = 'full') => {
      if (!Array.isArray(value)) return;
      for (const item of value) add(item, mode);
    };
    const addMetadata = (metadata: any) => {
      if (!metadata || typeof metadata !== 'object') return;
      addMany(metadata.aliases);
      addMany(metadata.appliesTo);
      add(metadata.canonicalFact, 'handles');
      add(metadata.status, 'handles');
      for (const value of Object.values(metadata)) {
        if (typeof value === 'string') add(value, 'handles');
        if (Array.isArray(value)) addMany(value, 'handles');
      }
    };

    add(content?.name);
    add(content?.entityName);
    add(content?.from);
    add(content?.to);
    if (Array.isArray(content?.aliases)) {
      for (const alias of content.aliases) add(alias);
    }
    addMany(content?.appliesTo);
    addMany(content?.tags);
    addMany(content?.observations, 'handles');
    addMany(content?.contents, 'handles');
    addMany(content?.agentBootstrap, 'handles');
    addMetadata(content?.metadata);

    return Array.from(values);
  }

  private entityNameAndAliasLookupValues(content: any): string[] {
    const values = new Set<string>();
    const add = (value: any) => {
      if (typeof value !== 'string' || !value.trim()) return;
      for (const variant of this.entityQueryVariants(value)) values.add(variant);
    };

    add(content?.name);
    if (Array.isArray(content?.aliases)) {
      for (const alias of content.aliases) add(alias);
    }
    return Array.from(values);
  }

  private rowLookupKinds(row: any): Set<string> {
    return new Set(String(row?.lookup_key_kinds || '')
      .split(',')
      .map((kind) => kind.trim())
      .filter(Boolean));
  }

  private entityNameLookupValuesForQuery(entityName: string, tenantId: string): Set<string> {
    const values = new Set<string>();
    const queryVariants = new Set(this.entityQueryVariants(entityName));
    const indexed = this.findRowsByLookupIndexValues(queryVariants, tenantId, ['entity']);
    const rows = indexed.usedIndex
      ? indexed.rows.filter((row: any) => {
          const kinds = this.rowLookupKinds(row);
          return kinds.has('canonical_name') || kinds.has('alias');
        })
      : this.findEntitiesByNameOrAlias(entityName, tenantId);

    for (const row of rows) {
      try {
        const content = JSON.parse(row.content || '{}');
        for (const value of this.entityQueryVariants(content.name)) {
          values.add(value);
        }
      } catch {}
    }
    return values;
  }

  /**
   * Resolve exact entity rows by canonical name or aliases.
   * This intentionally avoids semantic search and only scans entity rows.
   */
  /**
   * ENG-4 narrow surface (2a): EXACT canonical-name/alias entity candidates
   * within one tenant, using the proven lookup machinery only — no
   * substring, no semantic. Implements the eng4 resolver's EntityDirectory.
   */
  resolveEntityCandidatesExact(
    entityName: string,
    tenantId: string
  ): Array<{ id: string; name: string; matchedBy: 'canonical_name' | 'alias' }> {
    const queryVariants = new Set(this.entityQueryVariants(entityName));
    if (queryVariants.size === 0) return [];
    const candidates: Array<{ id: string; name: string; matchedBy: 'canonical_name' | 'alias' }> = [];
    for (const row of this.findEntitiesByNameOrAlias(entityName, tenantId)) {
      try {
        const content = JSON.parse(row.content || '{}');
        // The indexed lookup path matches rows on ANY key_kind (derived
        // handles, embedded observation/bootstrap handles, metadata), so
        // candidacy is re-verified against the entity PAYLOAD: only the
        // canonical name or a registered alias qualifies — the same filter
        // the unindexed fallback applies.
        const canonicalVariants = new Set(this.entityQueryVariants(content?.name || ''));
        const isCanonical = [...queryVariants].some((v) => canonicalVariants.has(v));
        const isNameOrAlias = isCanonical ||
          this.entityNameAndAliasLookupValues(content).some((v) => queryVariants.has(v));
        if (!isNameOrAlias) continue;
        candidates.push({
          id: String(row.id),
          name: String(content?.name ?? ''),
          matchedBy: isCanonical ? 'canonical_name' : 'alias',
        });
      } catch {
        /* unparseable row: never a candidate */
      }
    }
    return candidates;
  }

  /**
   * ENG-4 narrow surface (2a): tenant-scoped mailbox identity for an ASSERTED
   * agent id. Authorship/acks/views must never use the broader status family,
   * where display names and metadata aliases are intentionally presentation
   * inputs. The raw asserted id remains audit-only (approved contract @
   * 89fc422).
   */
  resolveCanonicalAgent(agentId: string, tenantId: string = 'default'): { canonical: string; aliases: string[] } {
    return this.resolveMailboxIdentity(agentId, tenantId);
  }

  /**
   * ENG-4 narrow surface (2c): charter/creation prose for a resolved entity
   * UUID — the resume bundle's `definition` field. NEVER current state (A4):
   * explicit description/definition fields win, else the FOUNDING (first)
   * observation string; eng4 working state never flows through here.
   */
  getEntityDefinition(entityId: string, tenantId: string): string | null {
    const row = this.db.prepare(
      `SELECT content FROM shared_memory WHERE id = ? AND tenant_id = ? AND memory_type = 'entity'`
    ).get(entityId, tenantId) as { content: string } | undefined;
    if (!row) return null;
    try {
      const content = JSON.parse(row.content || '{}');
      if (this.isConfidentialMessageSearchItem('entity', content)) return null;
      if (typeof content?.description === 'string' && content.description.trim()) return content.description;
      if (typeof content?.definition === 'string' && content.definition.trim()) return content.definition;
      const founding = Array.isArray(content?.observations)
        ? content.observations.find((o: unknown) => typeof o === 'string' && (o as string).trim())
        : undefined;
      return founding ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Rehydration capsules for an entity (resume resultVersion=2): every
   * observation whose metadata.kind === 'capsule' that is NOT superseded by
   * any observation on the entity, newest first. Supersession is computed
   * over ALL of the entity's observations (bounded window), so a non-capsule
   * observation that supersedes a capsule still retires it — but an unrelated
   * newer append never hides one (data-audit HIGH 1, 2026-09-03).
   */
  getCapsuleObservations(
    entityId: string,
    tenantId: string
  ): { capsules: Array<{ observationId: string; entityId: string; recordedAt: string; author: string; canonicalFact: string | null; contents: string[] }>; candidatesConsidered: number } {
    const entityRow = this.db.prepare(
      `SELECT content FROM shared_memory WHERE id = ? AND tenant_id = ? AND memory_type = 'entity'`
    ).get(entityId, tenantId) as { content: string } | undefined;
    if (!entityRow) return { capsules: [], candidatesConsidered: 0 };
    let entityName: string | null = null;
    try {
      const content = JSON.parse(entityRow.content || '{}');
      if (this.isConfidentialMessageSearchItem('entity', content)) return { capsules: [], candidatesConsidered: 0 };
      entityName = typeof content?.name === 'string' ? content.name : null;
    } catch {
      return { capsules: [], candidatesConsidered: 0 };
    }
    if (!entityName) return { capsules: [], candidatesConsidered: 0 };
    const canonicalKey = this.normalizeEntityLookup(entityName);

    const rows = this.db.prepare(`
      SELECT sm.id, sm.content, sm.created_by, sm.created_at
      FROM graph_lookup_keys glk
      JOIN shared_memory sm
        ON sm.id = glk.memory_id AND sm.tenant_id = glk.tenant_id
      WHERE glk.tenant_id = ?
        AND glk.lookup_key = ?
        AND glk.memory_type = 'observation'
        AND glk.key_kind = 'entity_name'
        AND sm.memory_type = 'observation'
      ORDER BY sm.created_at DESC, sm.rowid DESC
      LIMIT 500
    `).all(tenantId, canonicalKey) as Array<{ id: string; content: string; created_by: string; created_at: string }>;

    const parsed = rows.map((row) => {
      let content: any;
      try { content = JSON.parse(row.content); } catch { content = { raw: row.content }; }
      return { row, content };
    }).filter(({ row }) => !this.isConfidentialGraphRow('observation', row.content, tenantId));

    const supersededIds = new Set<string>();
    for (const { content } of parsed) {
      const supersedes = Array.isArray(content?.metadata?.supersedes)
        ? content.metadata.supersedes
        : Array.isArray(content?.supersedes) ? content.supersedes : [];
      for (const id of supersedes) if (typeof id === 'string' && id.trim()) supersededIds.add(id.trim());
    }

    const capsules = parsed
      .filter(({ row, content }) => content?.metadata?.kind === 'capsule' && !supersededIds.has(row.id))
      .map(({ row, content }) => ({
        observationId: String(row.id),
        entityId,
        recordedAt: String(content?.timestamp || row.created_at),
        author: String(content?.addedBy || row.created_by || ''),
        canonicalFact: typeof content?.metadata?.canonicalFact === 'string' ? content.metadata.canonicalFact : null,
        contents: Array.isArray(content?.contents) ? content.contents.filter((c: unknown) => typeof c === 'string') : [],
      }));
    return { capsules, candidatesConsidered: parsed.length };
  }

  findEntitiesByNameOrAlias(entityName: string, tenantId: string): any[] {
    const queryVariants = new Set(this.entityQueryVariants(entityName));
    if (queryVariants.size === 0) return [];

    const indexed = this.findRowsByLookupIndexValues(queryVariants, tenantId, ['entity']);
    if (indexed.usedIndex) {
      return indexed.rows.filter((row: any) => {
        try {
          return !this.isConfidentialMessageSearchItem('entity', JSON.parse(row.content || '{}'));
        } catch {
          return false;
        }
      });
    }

    const rows = this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id
       FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'entity'`
    ).all(tenantId) as any[];

    return rows.filter((row: any) => {
      try {
        const content = JSON.parse(row.content || '{}');
        if (this.isConfidentialMessageSearchItem('entity', content)) return false;
        return this.entityNameAndAliasLookupValues(content).some((value) => queryVariants.has(value));
      } catch {
        return false;
      }
    });
  }

  /**
   * Resolve observation rows by canonical entity name or aliases.
   * Used by exact searches so agent "read entity X and observations" workflows
   * do not need to invoke semantic/vector search when deterministic rows exist.
   */
  findObservationsByEntityOrAlias(entityName: string, tenantId: string): any[] {
    const queryVariants = new Set(this.entityQueryVariants(entityName));
    if (queryVariants.size === 0) return [];
    const matchedEntityValues = this.entityNameLookupValuesForQuery(entityName, tenantId);
    const indexedLookupValues = new Set([...queryVariants, ...matchedEntityValues]);

    const indexed = this.findRowsByLookupIndexValues(indexedLookupValues, tenantId, ['observation']);
    if (indexed.usedIndex) {
      return indexed.rows.filter((row: any) =>
        !this.isConfidentialGraphRow('observation', row.content, tenantId)
      );
    }

    const rows = this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id
       FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'observation'`
    ).all(tenantId) as any[];

    return rows.filter((row: any) => {
      try {
        const content = JSON.parse(row.content || '{}');
        if (this.isConfidentialGraphRow('observation', content, tenantId)) return false;
        const values = this.entityLookupValues(content);
        const entityValues = this.entityLookupValues({ entityName: content.entityName });
        return values.some((value) => queryVariants.has(value)) ||
          entityValues.some((value) => matchedEntityValues.has(value));
      } catch {
        return false;
      }
    });
  }

  private relatedContextEntityLookupKeys(
    entityName: string,
    tenantId: string,
    expectedEntityId?: string,
  ): { entityId: string | null; lookupKeys: string[]; truncated: boolean } {
    const ids = expectedEntityId
      ? [expectedEntityId]
      : [...new Set(
          this.resolveEntityCandidatesExact(entityName, tenantId)
            .map((candidate) => candidate.id),
        )];
    if (ids.length !== 1) return { entityId: null, lookupKeys: [], truncated: false };
    const row = this.db.prepare(
      `SELECT content FROM shared_memory
       WHERE tenant_id = ? AND id = ? AND memory_type = 'entity' AND json_valid(content)
       LIMIT 1`,
    ).get(tenantId, ids[0]) as { content: string } | undefined;
    if (!row) return { entityId: null, lookupKeys: [], truncated: false };
    try {
      const content = JSON.parse(row.content || '{}');
      if (this.isConfidentialMessageSearchItem('entity', content)) {
        return { entityId: null, lookupKeys: [], truncated: false };
      }
      const canonical = this.entityQueryVariants(content?.name || '').sort();
      const aliases = (Array.isArray(content?.aliases) ? content.aliases : [])
        .flatMap((alias: unknown) => typeof alias === 'string' ? this.entityQueryVariants(alias) : [])
        .sort();
      const allLookupKeys = [...new Set([...canonical, ...aliases])];
      // The write-time entity identity index retains at most 64 keys. Querying
      // beyond that boundary could find an observation but could not prove its
      // alias maps uniquely back to this entity. Stop at the same bound and
      // report the omitted identity space as explicit degradation.
      const maxQueryKeys = MemoryManager.MAX_LOOKUP_KEYS_PER_MEMORY;
      return {
        entityId: ids[0],
        lookupKeys: allLookupKeys.slice(0, maxQueryKeys),
        truncated: allLookupKeys.length > maxQueryKeys,
      };
    } catch {
      return { entityId: null, lookupKeys: [], truncated: false };
    }
  }

  /** Bounded, deterministic observation rows for discovery currentness. */
  findRelatedContextObservations(
    entityName: string,
    tenantId: string,
    limit: number = 100,
    expectedEntityId?: string,
  ): { rows: any[]; truncated: boolean; degradedReason?: string; degradedReasons?: string[] } {
    const cap = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 100));
    const { entityId, lookupKeys, truncated: lookupKeysTruncated } =
      this.relatedContextEntityLookupKeys(entityName, tenantId, expectedEntityId);
    if (lookupKeys.length === 0) return { rows: [], truncated: false };
    if (!this.graphLookupIndexHasRows(tenantId)) {
      return { rows: [], truncated: true, degradedReason: 'graph_lookup_index_unavailable' };
    }
    const placeholders = lookupKeys.map(() => '?').join(',');
    const rawLimit = Math.min(200, Math.max(cap + 1, cap * 2));
    const rawRows = this.db.prepare(
      `SELECT sm.id, sm.content, sm.created_by, sm.created_at, sm.rowid AS storage_rowid
       FROM graph_lookup_keys gl
       JOIN shared_memory sm
         ON sm.id = gl.memory_id
        AND sm.tenant_id = gl.tenant_id
        AND sm.memory_type = gl.memory_type
       WHERE gl.tenant_id = ?
         AND gl.lookup_key IN (${placeholders})
         AND gl.memory_type = 'observation'
         AND gl.key_kind = 'entity_name'
         AND sm.memory_type = 'observation'
       GROUP BY sm.id
       ORDER BY sm.created_at DESC, sm.rowid DESC, sm.id ASC
       LIMIT ?`,
    ).all(tenantId, ...lookupKeys, rawLimit) as any[];
    let identityFiltered = false;
    const visible = rawRows.filter((row) => {
      if (this.isConfidentialGraphRow('observation', row.content, tenantId)) return false;
      try {
        const payload = JSON.parse(row.content || '{}');
        if (typeof payload.entityName !== 'string' || !payload.entityName.trim()) {
          identityFiltered = true;
          return false;
        }
        const resolvedIds = [...new Set(
          this.resolveEntityCandidatesExact(payload.entityName, tenantId)
            .map((candidate) => candidate.id),
        )];
        if (resolvedIds.length !== 1 || resolvedIds[0] !== entityId) {
          identityFiltered = true;
          return false;
        }
        return true;
      } catch {
        identityFiltered = true;
        return false;
      }
    });
    const degradedReasons = [
      ...(identityFiltered ? ['observation_identity_ambiguous_or_mismatched'] : []),
      ...(lookupKeysTruncated ? ['entity_alias_lookup_limit_reached'] : []),
    ];
    return {
      rows: visible.slice(0, cap),
      truncated: visible.length > cap || rawRows.length === rawLimit,
      ...(degradedReasons.length > 0 ? {
        degradedReason: degradedReasons[0],
        degradedReasons,
      } : {}),
    };
  }

  /** Bounded, deterministic relation rows for discovery graph traversal. */
  findRelatedContextRelations(
    entityName: string,
    tenantId: string,
    limit: number = 200,
    expectedEntityId?: string,
  ): { rows: any[]; truncated: boolean; degradedReason?: string; degradedReasons?: string[] } {
    const cap = Math.max(1, Math.min(Math.floor(Number(limit) || 200), 200));
    const { lookupKeys, truncated: lookupKeysTruncated } =
      this.relatedContextEntityLookupKeys(entityName, tenantId, expectedEntityId);
    if (lookupKeys.length === 0) return { rows: [], truncated: false };
    if (!this.graphLookupIndexHasRows(tenantId)) {
      return { rows: [], truncated: true, degradedReason: 'graph_lookup_index_unavailable' };
    }
    const placeholders = lookupKeys.map(() => '?').join(',');
    const rawLimit = Math.min(400, Math.max(cap + 1, cap * 2));
    const rawRows = this.db.prepare(
      `SELECT sm.id, sm.content, sm.created_by, sm.created_at
       FROM graph_lookup_keys gl
       JOIN shared_memory sm
         ON sm.id = gl.memory_id
        AND sm.tenant_id = gl.tenant_id
        AND sm.memory_type = gl.memory_type
       WHERE gl.tenant_id = ?
         AND gl.lookup_key IN (${placeholders})
         AND gl.memory_type = 'relation'
         AND gl.key_kind IN ('relation_from', 'relation_to')
         AND sm.memory_type = 'relation'
       GROUP BY sm.id
       ORDER BY sm.id ASC
       LIMIT ?`,
    ).all(tenantId, ...lookupKeys, rawLimit) as any[];
    const visible = rawRows.filter((row) =>
      !this.isConfidentialGraphRow('relation', row.content, tenantId)
    );
    return {
      rows: visible.slice(0, cap),
      truncated: visible.length > cap || rawRows.length === rawLimit,
      ...(lookupKeysTruncated ? {
        degradedReason: 'entity_alias_lookup_limit_reached',
        degradedReasons: ['entity_alias_lookup_limit_reached'],
      } : {}),
    };
  }

  /**
   * Resolve relation rows by canonical entity name or aliases.
   */
  findRelationsByEntityOrAlias(entityName: string, tenantId: string): any[] {
    const queryVariants = new Set(this.entityQueryVariants(entityName));
    if (queryVariants.size === 0) return [];
    const matchedEntityValues = this.entityNameLookupValuesForQuery(entityName, tenantId);
    const indexedLookupValues = new Set([...queryVariants, ...matchedEntityValues]);

    const indexed = this.findRowsByLookupIndexValues(indexedLookupValues, tenantId, ['relation']);
    if (indexed.usedIndex) {
      return indexed.rows.filter((row: any) =>
        !this.isConfidentialGraphRow('relation', row.content, tenantId)
      );
    }

    const rows = this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id
       FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'relation'`
    ).all(tenantId) as any[];

    return rows.filter((row: any) => {
      try {
        const content = JSON.parse(row.content || '{}');
        if (this.isConfidentialGraphRow('relation', content, tenantId)) return false;
        const values = [
          ...this.entityLookupValues(content),
          ...this.entityLookupValues({ entityName: content.from }),
          ...this.entityLookupValues({ entityName: content.to }),
        ];
        return values.some((value) => queryVariants.has(value) || matchedEntityValues.has(value));
      } catch {
        return false;
      }
    });
  }

  /**
   * Find entity rows by name (case-insensitive, tenant-scoped).
   * Codex finding #4: LOWER(json_extract()) for case-insensitive matching.
   */
  findEntitiesByName(entityName: string, tenantId: string): any[] {
    return this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'entity'
       AND json_valid(content)
       AND LOWER(json_extract(content, '$.name')) = LOWER(?)`
    ).all(tenantId, entityName) as any[];
  }

  /**
   * Find observation rows for an entity (case-insensitive, tenant-scoped).
   */
  findObservationsByEntity(entityName: string, tenantId: string): any[] {
    const rows = this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'observation'
       AND json_valid(content)
       AND LOWER(json_extract(content, '$.entityName')) = LOWER(?)`
    ).all(tenantId, entityName) as any[];
    return rows.filter((row: any) =>
      !this.isConfidentialGraphRow('observation', row.content, tenantId)
    );
  }

  /**
   * Fetch raw observation mutation candidates. Read helpers intentionally
   * hide private children; mutation handlers instead need to see them so an
   * explicitly targeted private row causes the whole operation to fail closed
   * rather than being silently omitted from a partial delete.
   */
  findObservationRowsForMutation(entityName: string, tenantId: string): any[] {
    return this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'observation'
       AND json_valid(content)
       AND LOWER(json_extract(content, '$.entityName')) = LOWER(?)`
    ).all(tenantId, entityName) as any[];
  }

  /**
   * Find relation rows involving an entity (case-insensitive, tenant-scoped).
   */
  findRelationsByEntity(entityName: string, tenantId: string): any[] {
    const rows = this.db.prepare(
      `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'relation'
       AND json_valid(content)
       AND (LOWER(json_extract(content, '$.from')) = LOWER(?)
            OR LOWER(json_extract(content, '$.to')) = LOWER(?))`
    ).all(tenantId, entityName, entityName) as any[];
    return rows.filter((row: any) =>
      !this.isConfidentialGraphRow('relation', row.content, tenantId)
    );
  }

  /**
   * Phase B: Check if a member owns all target rows (row-level provenance enforcement).
   * Returns { allowed: true } if all rows are owned by the member, or { allowed: false, reason }
   * if any row is not owned, is legacy (no provenance), or is system-owned.
   */
  checkMemberOwnership(targetRows: any[], context: RequestContext): { allowed: boolean; reason?: string } {
    const userId = context.userId;
    if (!userId) return { allowed: false, reason: 'No userId in context for member ownership check' };

    for (const row of targetRows) {
      // Legacy rows without provenance → admin-only (safe default)
      if (!row.owner_actor_type || !row.owner_actor_id) {
        return { allowed: false, reason: 'Legacy row without provenance requires admin role' };
      }
      // System-owned rows → admin-only
      if (row.owner_actor_type === 'system') {
        return { allowed: false, reason: 'System-owned row requires admin role' };
      }
      // Row owned by a different actor type or different user → rejected
      if (row.owner_actor_type !== 'jwt' || row.owner_actor_id !== userId) {
        return { allowed: false, reason: `Row owned by ${row.owner_actor_type}:${row.owner_actor_id}, not by jwt:${userId}` };
      }
    }
    return { allowed: true };
  }

  /**
   * Fetch a single observation row by ID (for ownership check before update).
   */
  getObservationRow(obsId: string, tenantId: string): any | null {
    return this.db.prepare(
      "SELECT id, content, created_by, owner_actor_type, owner_actor_id FROM shared_memory WHERE id = ? AND tenant_id = ? AND memory_type = 'observation'"
    ).get(obsId, tenantId) as any || null;
  }

  /**
   * Find observations by containsAny substrings (case-insensitive, tenant-scoped).
   * Codex finding #7: escapes % and _ in patterns.
   */
  findObservationsByContainsAny(entityName: string, containsAny: string[], tenantId: string): any[] {
    if (containsAny.length === 0) return [];

    const escapedPatterns = containsAny.map(s => `%${MemoryManager.escapeLikePattern(s)}%`);
    const likeConditions = escapedPatterns.map(() => `LOWER(content) LIKE LOWER(?) ESCAPE '\\'`).join(' OR ');

    const sql = `SELECT id, content, created_by, created_at, owner_actor_type, owner_actor_id FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'observation'
       AND json_valid(content)
       AND LOWER(json_extract(content, '$.entityName')) = LOWER(?)
       AND (${likeConditions})`;

    return this.db.prepare(sql).all(tenantId, entityName, ...escapedPatterns) as any[];
  }

  /**
   * Delete graph rows from SQLite in a transaction, then attempt vector cleanup.
   * Failures are tombstoned for retry.
   */
  async deleteGraphRows(ids: string[], tenantId: string): Promise<{
    deleted: number;
    vectorCleanup: number;
    vectorFailures: number;
  }> {
    if (ids.length === 0) {
      return { deleted: 0, vectorCleanup: 0, vectorFailures: 0 };
    }

    // This is the common sink for generic graph mutation handlers. Inspect the
    // original, full rows before deleting anything so a filtered private
    // entity/observation/relation cannot be mutated by ID. Migration tooling
    // that deliberately removes legacy private residue uses its own audited
    // transaction rather than this public graph-mutation path.
    const guardPlaceholders = ids.map(() => '?').join(',');
    const targetRows = this.db.prepare(
      `SELECT id, memory_type, content FROM shared_memory
       WHERE tenant_id = ? AND id IN (${guardPlaceholders})`
    ).all(tenantId, ...ids) as Array<{ id: string; memory_type: string; content: string }>;
    if (targetRows.some((row) =>
      this.isConfidentialGraphRow(row.memory_type, row.content, tenantId)
    )) {
      throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
    }

    // SQLite transaction delete
    const placeholders = ids.map(() => '?').join(',');
    const txn = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id IN (${placeholders})`
      ).run(tenantId, ...ids);
      return this.db.prepare(
        `DELETE FROM shared_memory WHERE tenant_id = ? AND id IN (${placeholders})`
      ).run(tenantId, ...ids);
    });
    const result = txn();

    // Vector cleanup (best-effort with tombstone on failure)
    let vectorCleanup = 0;
    let vectorFailures = 0;

    if (this.vectorClient) {
      for (const id of ids) {
        try {
          await this.vectorClient.deleteMemory(id);
          vectorCleanup++;
        } catch (err: any) {
          vectorFailures++;
          // Insert tombstone for retry
          try {
            this.db.prepare(
              `INSERT OR IGNORE INTO failed_weaviate_deletes (id, weaviate_id, tenant_id, last_error)
               VALUES (?, ?, ?, ?)`
            ).run(uuidv4(), id, tenantId, err?.message || 'unknown');
          } catch { /* tombstone write failure is truly non-fatal */ }
        }
      }
    }

    // Fire-and-forget: drain any pending tombstones while we're at it
    if (vectorFailures > 0) {
      void this.retryFailedVectorDeletes(25).catch(() => {});
    }

    return {
      deleted: result.changes,
      vectorCleanup,
      vectorFailures
    };
  }

  /**
   * Update observation content in SQLite and re-embed in vector index.
   */
  async updateObservationContent(
    obsId: string,
    newContent: string,
    contentIndex: number | undefined,
    tenantId: string
  ): Promise<{ updated: boolean; vectorReindexed: boolean }> {
    // Fetch current row (constrained to observations only)
    const row = this.db.prepare(
      "SELECT id, content, created_by, owner_actor_type, owner_actor_id FROM shared_memory WHERE id = ? AND tenant_id = ? AND memory_type = 'observation'"
    ).get(obsId, tenantId) as any;
    if (!row) throw new Error(`Observation ${obsId} not found`);

    let updatedContentObj: any;
    try {
      updatedContentObj = JSON.parse(row.content);
    } catch {
      throw new Error(`Failed to parse observation content for ${obsId}`);
    }

    if (this.isConfidentialGraphRow('observation', updatedContentObj, tenantId)) {
      throw new Error('message_detail graph rows are private mailbox data and cannot be mutated generically');
    }

    // Replace at contentIndex within contents array, or replace entire content field
    if (contentIndex !== undefined && Array.isArray(updatedContentObj.contents)) {
      if (contentIndex < 0 || contentIndex >= updatedContentObj.contents.length) {
        throw new Error(`contentIndex ${contentIndex} out of range [0, ${updatedContentObj.contents.length - 1}]`);
      }
      updatedContentObj.contents[contentIndex] = newContent;
    } else if (Array.isArray(updatedContentObj.contents) && updatedContentObj.contents.length > 0) {
      // Replace first content element if no index specified
      updatedContentObj.contents[0] = newContent;
    } else {
      // Fallback: set a contents array
      updatedContentObj.contents = [newContent];
    }

    // Update SQLite (tenant + type guard, verify exactly 1 row)
    const upd = this.db.prepare(
      "UPDATE shared_memory SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND memory_type = 'observation'"
    ).run(JSON.stringify(updatedContentObj), obsId, tenantId);
    if (upd.changes !== 1) throw new Error(`Observation ${obsId} not found`);
    this.refreshGraphLookupIndexForMemory(obsId, tenantId, 'observation', updatedContentObj);

    // Vector backend: delete + reinsert for re-embedding.
    let vectorReindexed = false;
    if (this.vectorClient) {
      try {
        await this.vectorClient.deleteMemory(obsId);
        await this.vectorClient.storeMemory({
          id: obsId,
          agentId: row.created_by,
          tenantId,
          type: 'observation' as any,
          content: JSON.stringify(updatedContentObj),
          timestamp: Date.now(),
          tags: [],
          priority: 5,
          relationships: [],
          metadata: {},
        });
        vectorReindexed = true;
      } catch (err: any) {
        // Tombstone for failed vector operation.
        try {
          this.db.prepare(
            `INSERT OR IGNORE INTO failed_weaviate_deletes (id, weaviate_id, tenant_id, last_error)
             VALUES (?, ?, ?, ?)`
          ).run(uuidv4(), obsId, tenantId, err?.message || 'unknown');
        } catch { /* non-fatal */ }
        // Fire-and-forget: drain pending tombstones
        void this.retryFailedVectorDeletes(25).catch(() => {});
      }
    }

    return {
      updated: true,
      vectorReindexed
    };
  }

  /**
   * Enhanced audit log for graph mutations (codex finding #6).
   * Logs tenant_id, actor_type, actor_id, target count, and reason.
   */
  auditMutationOp(
    operation: string,
    context: RequestContext,
    entityName: string,
    targetIds: string[],
    reason?: string
  ): void {
    try {
      const id = uuidv4();
      const hash = MemoryManager.contentHash(targetIds.join(','));
      const actorId = context.userId || context.apiKeyId || 'system';
      const agentId = context.agentPrincipal?.agentId || actorId;
      this.db.prepare(
        `INSERT INTO neural_audit_log (id, operation, agent_id, entity_name, content_hash, flagged, flag_reason, tenant_id, actor_type, actor_id, target_count, reason)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
      ).run(
        id,
        operation,
        agentId,
        entityName,
        hash,
        context.tenantId,
        context.authType,
        actorId,
        targetIds.length,
        reason || null
      );
    } catch (e: any) {
      console.error(`⚠️ Mutation audit log write failed (non-fatal): ${e.message}`);
    }
  }

  /**
   * Retry failed vector deletes from the tombstone queue.
   * Processes oldest-first, removes on success, bumps retry_count on failure.
   */
  async retryFailedVectorDeletes(limit = 100): Promise<{ attempted: number; succeeded: number; failed: number }> {
    if (!this.vectorClient) return { attempted: 0, succeeded: 0, failed: 0 };

    const rows = this.db.prepare(
      `SELECT id, weaviate_id, tenant_id, retry_count
       FROM failed_weaviate_deletes
       ORDER BY failed_at ASC
       LIMIT ?`
    ).all(limit) as any[];

    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.vectorClient.deleteMemory(row.weaviate_id);
        this.db.prepare('DELETE FROM failed_weaviate_deletes WHERE id = ?').run(row.id);
        succeeded++;
      } catch (err: any) {
        failed++;
        this.db.prepare(
          `UPDATE failed_weaviate_deletes
           SET retry_count = retry_count + 1,
               last_error = ?,
               failed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(err?.message || 'unknown', row.id);
      }
    }
    return { attempted: rows.length, succeeded, failed };
  }

  // ─── Data Management Methods ───────────────────────────────────

  /**
   * Find entities by name prefix (case-insensitive, tenant-scoped).
   */
  findEntitiesByPrefix(prefix: string, tenantId: string): any[] {
    return this.db.prepare(
      `SELECT id, content, created_by, tags, created_at, updated_at, owner_actor_type, owner_actor_id
       FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'entity'
       AND json_valid(content)
       AND LOWER(json_extract(content, '$.name')) LIKE LOWER(? || '%')
       ORDER BY created_at ASC`
    ).all(tenantId, prefix) as any[];
  }

  /**
   * List distinct entity name prefixes (first segment before '-') for autocomplete.
   */
  listEntityPrefixes(tenantId: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT SUBSTR(json_extract(content, '$.name'), 1,
        INSTR(json_extract(content, '$.name'), '-') - 1) as prefix
       FROM shared_memory WHERE tenant_id = ? AND memory_type = 'entity'
       AND json_valid(content)
       AND json_extract(content, '$.name') LIKE '%-%'
       ORDER BY prefix ASC`
    ).all(tenantId) as any[];
    return rows.map((r: any) => r.prefix).filter((p: string) => p && p.length > 0);
  }

  /**
   * Export entities + observations + relations matching a prefix or name list.
   */
  exportEntities(options: {
    tenantId: string;
    namePrefix?: string;
    entityNames?: string[];
  }): any {
    const { tenantId, namePrefix, entityNames: explicitNames } = options;

    // Find matching entities
    let entities: any[];
    if (namePrefix) {
      entities = this.findEntitiesByPrefix(namePrefix, tenantId);
    } else if (explicitNames && explicitNames.length > 0) {
      entities = explicitNames.flatMap(name => this.findEntitiesByName(name, tenantId));
    } else {
      throw new Error('Must provide namePrefix or entityNames');
    }

    // Data-management exports are portable shared-graph backups, not mailbox
    // backups. Historical message_detail entities contain direct-message
    // bodies and must never cross this generic boundary.
    entities = entities.filter((row) =>
      !this.isConfidentialGraphRow('entity', row.content, tenantId)
    );

    // Extract entity names from results
    const entityNameSet = new Set<string>();
    for (const e of entities) {
      try {
        const content = JSON.parse(e.content);
        if (content.name) entityNameSet.add(content.name);
      } catch {}
    }

    // Collect observations
    const observations: any[] = [];
    for (const name of entityNameSet) {
      observations.push(...this.findObservationsByEntity(name, tenantId));
    }
    const publicObservations = observations.filter((row) =>
      !this.isConfidentialGraphRow('observation', row.content, tenantId)
    );

    // Collect relations (deduplicate by id)
    const relationMap = new Map<string, any>();
    for (const name of entityNameSet) {
      for (const rel of this.findRelationsByEntity(name, tenantId)) {
        if (!this.isConfidentialGraphRow('relation', rel.content, tenantId)) {
          relationMap.set(rel.id, rel);
        }
      }
    }
    const relations = Array.from(relationMap.values());

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: 'neural-ai-collaboration',
      filter: { namePrefix: namePrefix || null, entityNames: explicitNames || null, tenantId },
      counts: { entities: entities.length, observations: publicObservations.length, relations: relations.length },
      entities,
      observations: publicObservations,
      relations,
    };
  }

  /**
   * Import entities from a backup payload. INSERT OR IGNORE for idempotency.
   */
  async importEntities(backup: any, tenantId: string, opts: { atomic?: boolean } = {}): Promise<{
    inserted: { entities: number; observations: number; relations: number };
    skipped: { entities: number; observations: number; relations: number };
    errors: string[];
  }> {
    if (backup.schemaVersion !== 1) {
      throw new Error(`Unsupported schema version: ${backup.schemaVersion}`);
    }

    const result = {
      inserted: { entities: 0, observations: 0, relations: 0 },
      skipped: { entities: 0, observations: 0, relations: 0 },
      errors: [] as string[],
    };

    // Import validation must see the current database, even if an operator or
    // maintenance job changed entity rows without going through store().
    this.confidentialEntityReferenceCache.delete(tenantId);

    const privateReferences = new Set(this.getConfidentialEntityReferences(tenantId));
    const parseRowContent = (row: any, memoryType: string): Record<string, any> => {
      if (!row || typeof row.content !== 'string') {
        throw new Error(`${memoryType} content must be a JSON string`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        throw new Error(`${memoryType} content must be valid JSON`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${memoryType} content must be a JSON object`);
      }
      return parsed as Record<string, any>;
    };
    const addPrivateEntityReferences = (row: any, content: Record<string, any>) => {
      if (typeof row?.id === 'string' && row.id) {
        privateReferences.add(`id:${row.id}`);
      }
      const names = [
        content.name,
        ...(Array.isArray(content.aliases) ? content.aliases : []),
      ];
      for (const name of names) {
        if (typeof name !== 'string') continue;
        for (const variant of this.entityQueryVariants(name)) {
          privateReferences.add(`name:${variant}`);
        }
      }
    };
    const isPrivateReference = (value: unknown): boolean => {
      if (typeof value !== 'string' || !value.trim()) return false;
      if (this.isConfidentialEntityReference(value, tenantId)) return true;
      if (privateReferences.has(`id:${value}`)) return true;
      return this.entityQueryVariants(value)
        .some((variant) => privateReferences.has(`name:${variant}`));
    };

    // Pre-scan the entire payload so observations cannot evade the boundary by
    // preceding a private entity, or by referring to a private entity that is
    // itself rejected rather than inserted.
    for (const row of (backup.entities || [])) {
      try {
        const content = parseRowContent(row, 'entity');
        if (this.isConfidentialMessageSearchItem('entity', content)) {
          addPrivateEntityReferences(row, content);
        }
      } catch {
        // The row-level importer below reports malformed content consistently.
      }
    }

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags, created_at, updated_at, owner_actor_type, owner_actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteLookupStmt = this.db.prepare(
      'DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?'
    );
    const insertLookupStmt = this.db.prepare(`
      INSERT INTO graph_lookup_keys (tenant_id, lookup_key, memory_type, memory_id, key_kind, weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, lookup_key, memory_type, memory_id) DO UPDATE SET
        key_kind = excluded.key_kind,
        weight = excluded.weight,
        updated_at = CURRENT_TIMESTAMP
    `);
    const insertedEntityRows: any[] = [];

    const importRows = (rows: any[], memoryType: string, countKey: 'entities' | 'observations' | 'relations') => {
      for (const row of rows) {
        let content: Record<string, any>;
        let info: any;
        try {
          content = parseRowContent(row, memoryType);
          if (
            memoryType === 'entity'
            && this.isConfidentialMessageSearchItem('entity', content)
          ) {
            throw new Error('message_detail is reserved for private mailbox compatibility');
          }
          if (
            memoryType === 'observation'
            && (
              this.isConfidentialMessageSearchItem('observation', content)
              || isPrivateReference(content.metadata?.entityId)
              || isPrivateReference(content.entityName)
            )
          ) {
            throw new Error('observation references a private message_detail entity');
          }
          if (
            memoryType === 'relation'
            && (isPrivateReference(content.from) || isPrivateReference(content.to))
          ) {
            throw new Error('relation references a private message_detail entity');
          }

          info = insertStmt.run(
            row.id,
            tenantId,
            memoryType,
            row.content,
            row.created_by || 'import',
            row.tags || '[]',
            row.created_at || new Date().toISOString(),
            row.updated_at || new Date().toISOString(),
            row.owner_actor_type || null,
            row.owner_actor_id || null
          );
          if (info.changes > 0) {
            result.inserted[countKey]++;
          } else {
            result.skipped[countKey]++;
          }
        } catch (err: any) {
          result.errors.push(`${memoryType} ${row.id}: ${err.message}`);
          // Atomic mode (used by trash restore): re-throw so the surrounding
          // db.transaction rolls back ALL inserts — never a partial restore.
          if (opts.atomic) throw err;
          continue;
        }

        if (info.changes > 0) {
          // Keep deterministic graph reads in sync with imported SQLite rows.
          // This runs inside the same transaction as the row insert so an
          // indexing failure cannot leave a committed but undiscoverable row.
          this.replaceGraphLookupIndexForMemory(
            row.id,
            tenantId,
            memoryType as GraphMemoryType,
            content,
            deleteLookupStmt,
            insertLookupStmt
          );
          if (memoryType === 'entity') insertedEntityRows.push(row);
        }
      }
    };

    // Run in transaction
    const txn = this.db.transaction(() => {
      importRows(backup.entities || [], 'entity', 'entities');
      importRows(backup.observations || [], 'observation', 'observations');
      importRows(backup.relations || [], 'relation', 'relations');
    });
    try {
      txn();
    } finally {
      // Imported entities can change which ID/name/alias references are
      // confidential. Force the next classifier to rebuild from committed DB
      // state; on rollback this also discards the pre-import snapshot.
      this.confidentialEntityReferenceCache.delete(tenantId);
    }

    // Vector re-indexing for inserted entities (best-effort)
    if (this.vectorClient && insertedEntityRows.length > 0) {
      for (const entity of insertedEntityRows) {
        try {
          await this.vectorClient.storeMemory({
            id: entity.id,
            agentId: entity.created_by || 'import',
            tenantId,
            type: 'entity' as any,
            content: entity.content,
            timestamp: Date.now(),
            tags: [],
            priority: 5,
            relationships: [],
          });
        } catch {}
      }
    }

    return result;
  }

  /**
   * Create a full database snapshot (backup).
   */
  /**
   * Return the default backup directory and auto-discovered external drives.
   */
  getBackupLocations(): Array<{
    id: string; path: string; label: string; writable: boolean;
    freeBytes?: number; totalBytes?: number;
  }> {
    type LocationEntry = {
      id: string; path: string; label: string; writable: boolean;
      freeBytes?: number; totalBytes?: number;
    };
    const locations: LocationEntry[] = [];
    const seen = new Set<string>();

    // Default: alongside the DB
    const defaultDir = path.join(path.dirname(this.dbPath), 'backups');
    locations.push({
      id: 'default',
      path: defaultDir,
      label: 'Internal (Docker volume)',
      writable: this.isDirWritable(defaultDir),
      ...this.getDiskSpace(defaultDir),
    });
    seen.add(path.resolve(defaultDir));

    // Auto-discover drives from mounted host paths
    if (process.env.BACKUP_AUTODISCOVER === 'true') {
      this.discoverDrives('/host-drives', seen, locations);  // WSL2: /mnt/c, /mnt/d, USB /mnt/e...
      this.discoverDrives('/host-media', seen, locations);    // Linux: /media/user/usb-name
    }

    // Legacy: explicit BACKUP_DIR env
    if (process.env.BACKUP_DIR) {
      const resolved = path.resolve(process.env.BACKUP_DIR);
      if (!seen.has(resolved) && fs.existsSync(resolved)) {
        seen.add(resolved);
        locations.push({
          id: Buffer.from(resolved).toString('base64url'),
          path: resolved,
          label: 'External (BACKUP_DIR)',
          writable: this.isDirWritable(resolved),
          ...this.getDiskSpace(resolved),
        });
      }
    }

    return locations;
  }

  /**
   * Scan a host mount point for drives/volumes and add them as backup locations.
   */
  private discoverDrives(
    hostMountRoot: string,
    seen: Set<string>,
    locations: Array<{ id: string; path: string; label: string; writable: boolean; freeBytes?: number; totalBytes?: number }>
  ): void {
    if (!fs.existsSync(hostMountRoot)) return;

    // Skip known non-drive dirs in WSL2
    const skipDirs = new Set(['wsl', 'wslg', 'wslCrashLogs']);

    try {
      const entries = fs.readdirSync(hostMountRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (skipDirs.has(entry.name)) continue;

        const drivePath = path.join(hostMountRoot, entry.name);
        const resolved = path.resolve(drivePath);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        // Check if it's a real filesystem (has some content, not empty mount)
        try {
          const contents = fs.readdirSync(drivePath);
          if (contents.length === 0) continue; // empty mount = not a real drive
        } catch { continue; }

        // Build a friendly label
        const space = this.getDiskSpace(drivePath);
        const driveLetter = entry.name.toUpperCase();
        const sizeLabel = space.totalBytes
          ? ` (${this.humanSize(space.freeBytes || 0)} free / ${this.humanSize(space.totalBytes)})`
          : '';

        // Use neural-backups subfolder on each drive
        const backupPath = path.join(drivePath, 'neural-backups');
        const writable = this.isDirWritable(backupPath);

        locations.push({
          id: Buffer.from(backupPath).toString('base64url'),
          path: backupPath,
          label: `Drive ${driveLetter}:${sizeLabel}`,
          writable,
          ...this.getDiskSpace(backupPath),
        });
      }
    } catch {}
  }

  private isDirWritable(dir: string): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getDiskSpace(dir: string): { freeBytes?: number; totalBytes?: number } {
    try {
      // Node 18.15+ has fs.statfsSync
      if (typeof (fs as any).statfsSync === 'function') {
        const stat = (fs as any).statfsSync(dir);
        return {
          freeBytes: stat.bavail * stat.bsize,
          totalBytes: stat.blocks * stat.bsize,
        };
      }
    } catch {}
    return {};
  }

  private humanSize(bytes: number): string {
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private resolveBackupDir(locationId?: string, folder?: string): string {
    let base: string;
    if (!locationId || locationId === 'default') {
      base = path.join(path.dirname(this.dbPath), 'backups');
    } else {
      const locations = this.getBackupLocations();
      const loc = locations.find(l => l.id === locationId);
      if (!loc) throw new Error(`Unknown backup location: ${locationId}`);
      if (!loc.writable) throw new Error(`Backup location not writable: ${loc.path}`);
      base = loc.path;
    }
    if (folder) {
      const safe = folder.replace(/[^a-zA-Z0-9_\-/ ]/g, '_');
      return path.join(base, safe);
    }
    return base;
  }

  /**
   * List folders within a backup location.
   */
  listBackupFolders(locationId?: string): string[] {
    const base = this.resolveBackupDir(locationId);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  /**
   * Create a named folder within a backup location.
   */
  createBackupFolder(folderName: string, locationId?: string): { path: string; created: boolean } {
    const base = this.resolveBackupDir(locationId);
    const safe = folderName.replace(/[^a-zA-Z0-9_\-/ ]/g, '_');
    const fullPath = path.join(base, safe);
    const existed = fs.existsSync(fullPath);
    fs.mkdirSync(fullPath, { recursive: true });
    return { path: fullPath, created: !existed };
  }

  /**
   * Move a snapshot to a different location/folder. Copies file + updates manifests.
   */
  async moveSnapshot(snapshotId: string, targetLocationId: string, targetFolder?: string): Promise<{
    moved: boolean;
    newLocation: string;
    filename: string;
  }> {
    const snapshots = this.listSnapshots();
    const snapshot = snapshots.find(s => s.snapshotId === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const sourceDir = snapshot.location || path.join(path.dirname(this.dbPath), 'backups');
    const sourcePath = path.join(sourceDir, snapshot.filename);
    if (!fs.existsSync(sourcePath)) throw new Error(`Snapshot file missing: ${snapshot.filename}`);

    const targetDir = this.resolveBackupDir(targetLocationId, targetFolder);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, snapshot.filename);

    // Don't move to the same place
    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      return { moved: false, newLocation: targetDir, filename: snapshot.filename };
    }

    // Copy file
    fs.copyFileSync(sourcePath, targetPath);

    // Add to target manifest
    const targetManifestPath = path.join(targetDir, 'manifest.json');
    let targetManifest: any[] = [];
    try {
      if (fs.existsSync(targetManifestPath)) {
        targetManifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf-8'));
      }
    } catch {}
    targetManifest.push({ ...snapshot, location: targetDir });
    fs.writeFileSync(targetManifestPath, JSON.stringify(targetManifest, null, 2));

    // Remove from source manifest
    const sourceManifestPath = path.join(sourceDir, 'manifest.json');
    try {
      if (fs.existsSync(sourceManifestPath)) {
        let sourceManifest: any[] = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf-8'));
        sourceManifest = sourceManifest.filter((e: any) => e.snapshotId !== snapshotId);
        fs.writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest, null, 2));
      }
    } catch {}

    // Remove source file
    fs.unlinkSync(sourcePath);

    return { moved: true, newLocation: targetDir, filename: snapshot.filename };
  }

  /**
   * Delete a snapshot file and remove from manifest.
   */
  deleteSnapshot(snapshotId: string): { deleted: boolean; filename: string } {
    const snapshots = this.listSnapshots();
    const snapshot = snapshots.find(s => s.snapshotId === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const dir = snapshot.location || path.join(path.dirname(this.dbPath), 'backups');
    const filePath = path.join(dir, snapshot.filename);

    // Remove file
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Update manifest
    const manifestPath = path.join(dir, 'manifest.json');
    try {
      if (fs.existsSync(manifestPath)) {
        let manifest: any[] = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifest = manifest.filter((e: any) => e.snapshotId !== snapshotId);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
    } catch {}

    return { deleted: true, filename: snapshot.filename };
  }

  async createSnapshot(label?: string, locationId?: string, folder?: string): Promise<{
    snapshotId: string;
    filename: string;
    sizeBytes: number;
    createdAt: string;
    label: string;
    location: string;
  }> {
    const backupDir = this.resolveBackupDir(locationId, folder);
    fs.mkdirSync(backupDir, { recursive: true });

    const snapshotId = uuidv4();
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-');
    const safeLabel = (label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `neural-${dateStr}-${safeLabel}.db`;
    const targetPath = path.join(backupDir, filename);

    // Use better-sqlite3 built-in backup
    await this.db.backup(targetPath);

    const stats = fs.statSync(targetPath);
    const createdAt = now.toISOString();

    // Update manifest
    const manifestPath = path.join(backupDir, 'manifest.json');
    let manifest: any[] = [];
    try {
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      }
    } catch {}

    const entry = { snapshotId, filename, sizeBytes: stats.size, createdAt, label: safeLabel, location: backupDir };
    manifest.push(entry);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return entry;
  }

  /**
   * List available snapshots from manifest.
   */
  private readManifest(dir: string): any[] {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  listSnapshots(filterLocationId?: string): Array<{
    snapshotId: string;
    filename: string;
    sizeBytes: number;
    createdAt: string;
    label: string;
    location: string;
    locationId: string;
    locationLabel: string;
    folder?: string;
  }> {
    const allSnapshots: any[] = [];
    const locations = this.getBackupLocations();

    for (const loc of locations) {
      if (filterLocationId && loc.id !== filterLocationId) continue;

      // Scan root of location
      const dirsToScan = [{ dir: loc.path, folder: undefined as string | undefined }];

      // Scan subfolders
      if (fs.existsSync(loc.path)) {
        try {
          const subdirs = fs.readdirSync(loc.path, { withFileTypes: true })
            .filter(d => d.isDirectory());
          for (const sub of subdirs) {
            dirsToScan.push({ dir: path.join(loc.path, sub.name), folder: sub.name });
          }
        } catch {}
      }

      for (const { dir, folder } of dirsToScan) {
        const manifest = this.readManifest(dir);
        for (const entry of manifest) {
          const filePath = path.join(dir, entry.filename);
          if (fs.existsSync(filePath)) {
            allSnapshots.push({
              ...entry,
              location: entry.location || dir,
              locationId: loc.id,
              locationLabel: loc.label,
              folder: folder || entry.folder || undefined,
            });
          }
        }
      }
    }

    return allSnapshots.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Restore database from a snapshot. Returns pre-restore backup info.
   */
  async restoreSnapshot(snapshotId: string): Promise<{
    restoredFrom: string;
    preRestoreBackup: string;
  }> {
    const snapshots = this.listSnapshots();
    const snapshot = snapshots.find(s => s.snapshotId === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const snapshotDir = snapshot.location || path.join(path.dirname(this.dbPath), 'backups');
    const snapshotPath = path.join(snapshotDir, snapshot.filename);

    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Snapshot file missing: ${snapshot.filename}`);
    }

    // Validate snapshot integrity
    const testDb = new Database(snapshotPath, { readonly: true });
    try {
      const result = testDb.pragma('integrity_check') as any[];
      if (!result || result[0]?.integrity_check !== 'ok') {
        throw new Error('Snapshot failed integrity check');
      }
    } finally {
      testDb.close();
    }

    // Create pre-restore safety backup
    const preRestoreBackup = await this.createSnapshot('pre-restore');

    // A snapshot replaces every tenant's entity set. Drop both the old cache
    // before the file swap and any references populated during reinitialization
    // after it, so no request can classify observations using the wrong DB.
    this.confidentialEntityReferenceCache.clear();
    try {
      // All cache branches are served directly by getAgentMemory(),
      // getSharedMemory(), and legacy context builders. Clear the entire
      // object before swapping the database so rows created after the snapshot
      // cannot survive solely in individual/shared/task caches.
      this.resetServedMemoryCaches();

      // Close current DB
      this.db.close();

      // Copy snapshot over live DB
      fs.copyFileSync(snapshotPath, this.dbPath);

      // Reopen — the FK pragma is PER CONNECTION, so the eng4 apply (pragma +
      // idempotent DDL) must run again on this fresh handle.
      this.db = new Database(this.dbPath);
      this.initializeDatabase();
      applyEng4Schema(this.db);
      this.loadMemoryFromDatabase();
      this.initializeAdvancedSystems();
    } finally {
      this.confidentialEntityReferenceCache.clear();
    }

    return {
      restoredFrom: snapshot.filename,
      preRestoreBackup: preRestoreBackup.filename,
    };
  }

  /**
   * Retire (delete) entities and their observations/relations.
   */
  async retireEntities(entityNames: string[], tenantId: string): Promise<{
    entitiesDeleted: number;
    observationsDeleted: number;
    relationsDeleted: number;
    totalRowsDeleted: number;
  }> {
    const allIds: string[] = [];
    let entityCount = 0;
    let observationCount = 0;
    let relationCount = 0;
    const relationIdSet = new Set<string>();

    for (const name of entityNames) {
      const entities = this.findEntitiesByName(name, tenantId);
      entityCount += entities.length;
      allIds.push(...entities.map(e => e.id));

      const observations = this.findObservationsByEntity(name, tenantId);
      observationCount += observations.length;
      allIds.push(...observations.map(o => o.id));

      const relations = this.findRelationsByEntity(name, tenantId);
      for (const rel of relations) {
        if (!relationIdSet.has(rel.id)) {
          relationIdSet.add(rel.id);
          relationCount++;
          allIds.push(rel.id);
        }
      }
    }

    const deleteResult = await this.deleteGraphRows(allIds, tenantId);

    return {
      entitiesDeleted: entityCount,
      observationsDeleted: observationCount,
      relationsDeleted: relationCount,
      totalRowsDeleted: deleteResult.deleted,
    };
  }

  /**
   * Retire entities into the durable server-side Trash (Phase 2b). ATOMIC: writes
   * the logical backup into data_trash AND verifies that write BEFORE hard-deleting
   * the live rows — if the trash write fails, the whole transaction rolls back, so
   * there is never a delete without a persisted backup. Returns the trashId so the
   * caller can restore by id.
   */
  async retireEntitiesToTrash(
    entityNames: string[],
    tenantId: string,
    reason?: string
  ): Promise<{ trashId: string; counts: { entities: number; observations: number; relations: number }; deleted: number }> {
    const backup = this.exportEntities({ tenantId, entityNames });
    if (!backup.counts || backup.counts.entities === 0) {
      throw new Error('No matching entities to retire');
    }

    const ids: string[] = [
      ...(backup.entities || []),
      ...(backup.observations || []),
      ...(backup.relations || []),
    ].map((r: any) => r.id).filter(Boolean);

    const trashId = uuidv4();
    const insertTrash = this.db.prepare(
      `INSERT INTO data_trash (trash_id, tenant_id, reason, entity_names, counts, backup)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const delLookup = this.db.prepare(`DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?`);
    const delRow = this.db.prepare(`DELETE FROM shared_memory WHERE id = ? AND tenant_id = ?`);

    // Atomic: verified trash write THEN the deletes — both commit, or neither.
    const txn = this.db.transaction(() => {
      const info = insertTrash.run(
        trashId,
        tenantId,
        reason || null,
        JSON.stringify(entityNames),
        JSON.stringify(backup.counts),
        JSON.stringify(backup)
      );
      if (info.changes !== 1) {
        throw new Error('Trash write failed — aborting retire (no delete)');
      }
      let deleted = 0;
      for (const id of ids) {
        delLookup.run(tenantId, id);
        deleted += delRow.run(id, tenantId).changes;
      }
      return deleted;
    });
    const deleted = txn();

    // Best-effort vector cleanup (post-commit; safe to fail — the rows are already trashed).
    if (this.vectorClient) {
      for (const id of ids) {
        try { await this.vectorClient.deleteMemory(id); } catch { /* non-fatal */ }
      }
    }

    return { trashId, counts: backup.counts, deleted };
  }

  /** List trash entries (metadata + counts only; never the full backup payload). */
  listTrash(tenantId: string): Array<{ trashId: string; retiredAt: string; reason: string | null; entityNames: string[]; counts: any; restoredAt: string | null }> {
    const rows = this.db.prepare(
      `SELECT trash_id, retired_at, reason, entity_names, counts, restored_at
         FROM data_trash WHERE tenant_id = ? ORDER BY retired_at DESC`
    ).all(tenantId) as any[];
    return rows.map((r) => ({
      trashId: r.trash_id,
      retiredAt: r.retired_at,
      reason: r.reason ?? null,
      entityNames: JSON.parse(r.entity_names),
      counts: JSON.parse(r.counts),
      restoredAt: r.restored_at ?? null,
    }));
  }

  /** Restore a trashed set by trashId (re-import the stored backup), then drop the entry. */
  async restoreFromTrash(trashId: string, tenantId: string): Promise<{ trashId: string; restored: any }> {
    const row = this.db.prepare(
      `SELECT backup FROM data_trash WHERE trash_id = ? AND tenant_id = ?`
    ).get(trashId, tenantId) as any;
    if (!row) throw new Error(`Trash entry not found: ${trashId}`);
    const backup = JSON.parse(row.backup);
    // ATOMIC restore: importEntities rolls back ALL inserts if ANY row fails, so a
    // partial restore is impossible — either everything restores (and we consume the
    // trash entry below) or nothing does (and the live store + trash are unchanged,
    // the error propagates, and the endpoint writes no success audit).
    const restored = await this.importEntities(backup, tenantId, { atomic: true });
    this.db.prepare(`DELETE FROM data_trash WHERE trash_id = ? AND tenant_id = ?`).run(trashId, tenantId);
    return { trashId, restored };
  }

  /** Permanently purge a trash entry (its backup is gone for good). */
  purgeTrash(trashId: string, tenantId: string): { trashId: string; purged: number } {
    const info = this.db.prepare(
      `DELETE FROM data_trash WHERE trash_id = ? AND tenant_id = ?`
    ).run(trashId, tenantId);
    return { trashId, purged: info.changes };
  }

  // ===== ENG-2 compaction ==================================================
  // Four reclaim classes, each with an analyze (read-only, powers dry-run)
  // and where applicable an execute. Deletes never shrink the file (freelist
  // pages only) — a final offline VACUUM is required and is intentionally NOT
  // implemented here (operator-gated, run with the container stopped per the
  // migration-003 precedent).

  compactDbStats(): { dbBytes: number; pageCount: number; freelistCount: number; quickCheck: string } {
    const pageSize = (this.db.prepare('SELECT * FROM pragma_page_size()').get() as any)['page_size']
      ?? Object.values(this.db.prepare('SELECT * FROM pragma_page_size()').get() as any)[0];
    const pageCount = Object.values(this.db.prepare('SELECT * FROM pragma_page_count()').get() as any)[0] as number;
    const freelistCount = Object.values(this.db.prepare('SELECT * FROM pragma_freelist_count()').get() as any)[0] as number;
    const quickCheck = Object.values(this.db.prepare('PRAGMA quick_check(1)').get() as any)[0] as string;
    return { dbBytes: pageCount * (pageSize as number), pageCount, freelistCount, quickCheck };
  }

  /**
   * Class A — index diet. Compares the lookup index as stored against what
   * the current extraction policy would produce, plus a spot-check that
   * known-good keys survive. Read-only; the execute step is
   * rebuildGraphLookupIndex() (transactional).
   */
  compactAnalyzeIndexDiet(spotCheckKeys: string[] = []): {
    currentRows: number;
    prospectiveRows: number;
    reductionRows: number;
    memoriesScanned: number;
    spotCheck: Array<{ key: string; currentRows: number; prospectiveRows: number }>;
  } {
    const currentRows = Object.values(
      this.db.prepare('SELECT COUNT(*) AS c FROM graph_lookup_keys').get() as any
    )[0] as number;

    const spotKeys = spotCheckKeys.map((k) => this.normalizeEntityLookup(k)).filter(Boolean);
    const currentSpot = new Map<string, number>();
    for (const key of spotKeys) {
      currentSpot.set(key, Object.values(this.db.prepare(
        'SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE lookup_key = ?'
      ).get(key) as any)[0] as number);
    }

    const rows = this.db.prepare(`
      SELECT id, memory_type, content FROM shared_memory
      WHERE memory_type IN ('entity', 'observation', 'relation')
    `).iterate() as IterableIterator<{ id: string; memory_type: string; content: string }>;

    let prospectiveRows = 0;
    let memoriesScanned = 0;
    const prospectiveSpot = new Map<string, number>(spotKeys.map((k) => [k, 0]));
    for (const row of rows) {
      if (!this.isGraphMemoryType(row.memory_type)) continue;
      memoriesScanned++;
      let content: any;
      try { content = JSON.parse(row.content || '{}'); } catch { content = {}; }
      const entries = this.graphLookupEntriesForContent(content, row.memory_type);
      prospectiveRows += entries.length;
      for (const entry of entries) {
        if (prospectiveSpot.has(entry.lookupKey)) {
          prospectiveSpot.set(entry.lookupKey, (prospectiveSpot.get(entry.lookupKey) || 0) + 1);
        }
      }
    }

    return {
      currentRows,
      prospectiveRows,
      reductionRows: currentRows - prospectiveRows,
      memoriesScanned,
      spotCheck: spotKeys.map((key) => ({
        key,
        currentRows: currentSpot.get(key) || 0,
        prospectiveRows: prospectiveSpot.get(key) || 0,
      })),
    };
  }

  /** Rows currently indexed under a lookup key (post-rebuild spot-check). */
  countLookupKeyRows(key: string): number {
    return Object.values(this.db.prepare(
      'SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE lookup_key = ?'
    ).get(this.normalizeEntityLookup(key)) as any)[0] as number;
  }

  /**
   * Class B — superseded-observation reclaim. Marked-only: a row qualifies
   * ONLY when another observation's supersedes array names its id AND the
   * superseder is not older (anti-anomaly guard) AND the row is not what
   * get_current_observation resolves for its entity (never reclaim current).
   * Rows with a malformed (non-array) supersedes are reported, never touched.
   */
  compactAnalyzeSuperseded(tenantId: string = 'default'): {
    candidates: Array<{ id: string; entityName: string; createdAt: string; bytes: number }>;
    candidateBytes: number;
    guardSkippedCurrent: string[];
    malformedSupersedes: Array<{ id: string; entityName: string }>;
  } {
    // Two steps, both O(N): one json_each scan builds the
    // (superseded_id → newest marker created_at) map, then the marked rows
    // are fetched by indexed PK lookups. Single-statement formulations of
    // this (correlated EXISTS, and a CTE join that SQLite flattens back into
    // a nested loop) are O(N²) at live scale and — better-sqlite3 being
    // synchronous — blocked the whole server for minutes (2026-07-06 20:16Z
    // incident; the CTE variant still measured 300s+ on a live snapshot).
    const markerRows = this.db.prepare(`
      SELECT je.value AS superseded_id, MAX(m.created_at) AS by_created
      FROM shared_memory m,
           json_each(CASE WHEN json_valid(m.content) THEN m.content ELSE '{}' END,
                     '$.metadata.supersedes') je
      WHERE m.memory_type = 'observation' AND m.tenant_id = ?
        AND json_valid(m.content)
        AND json_type(m.content, '$.metadata.supersedes') = 'array'
      GROUP BY je.value
    `).all(tenantId) as Array<{ superseded_id: string; by_created: string }>;
    const markedBy = new Map<string, string>();
    for (const row of markerRows) {
      if (typeof row.superseded_id === 'string' && row.superseded_id.trim()) {
        markedBy.set(row.superseded_id.trim(), row.by_created);
      }
    }

    const fetchRow = this.db.prepare(`
      SELECT id, created_at, LENGTH(content) AS bytes,
             COALESCE(json_extract(content, '$.entityName'), '') AS entity_name
      FROM shared_memory
      WHERE id = ? AND tenant_id = ? AND memory_type = 'observation'
        AND json_valid(content)
    `);
    const rawCandidates: Array<{ id: string; created_at: string; bytes: number; entity_name: string }> = [];
    for (const [supersededId, byCreated] of markedBy) {
      const row = fetchRow.get(supersededId, tenantId) as any;
      // Anti-anomaly guard: the marker must not be older than the marked row.
      if (row && byCreated >= row.created_at) rawCandidates.push(row);
    }

    // Never-reclaim-current guard: resolve each affected entity's current
    // observation and exclude it from the candidate set.
    const guardSkippedCurrent: string[] = [];
    const currentIds = new Set<string>();
    const entityNames = Array.from(new Set(rawCandidates.map((c) => c.entity_name).filter(Boolean)));
    for (const entityName of entityNames) {
      const current = this.getCurrentObservation(entityName, tenantId).current;
      if (current?.id) currentIds.add(current.id);
    }
    const candidates = rawCandidates.filter((c) => {
      if (currentIds.has(c.id)) {
        guardSkippedCurrent.push(c.id);
        return false;
      }
      return true;
    });

    const malformedSupersedes = (this.db.prepare(`
      SELECT id, COALESCE(json_extract(content, '$.entityName'), '') AS entity_name
      FROM shared_memory
      WHERE memory_type = 'observation' AND tenant_id = ?
        AND json_valid(content)
        AND json_extract(content, '$.metadata.supersedes') IS NOT NULL
        AND json_type(content, '$.metadata.supersedes') <> 'array'
    `).all(tenantId) as Array<{ id: string; entity_name: string }>)
      .map((r) => ({ id: r.id, entityName: r.entity_name }));

    return {
      candidates: candidates.map((c) => ({
        id: c.id, entityName: c.entity_name, createdAt: c.created_at, bytes: c.bytes,
      })),
      candidateBytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
      guardSkippedCurrent,
      malformedSupersedes,
    };
  }

  /**
   * Class B execute — retire the analyzed candidates to data_trash
   * (restorable), mirroring retireEntitiesToTrash's verified-backup-then-
   * delete transaction, then best-effort vector cleanup.
   */
  async compactExecuteSuperseded(tenantId: string = 'default', reason?: string): Promise<{
    trashId: string | null;
    reclaimedRows: number;
    reclaimedBytes: number;
    guardSkippedCurrent: string[];
    malformedSupersedes: Array<{ id: string; entityName: string }>;
  }> {
    const analysis = this.compactAnalyzeSuperseded(tenantId);
    if (analysis.candidates.length === 0) {
      return {
        trashId: null, reclaimedRows: 0, reclaimedBytes: 0,
        guardSkippedCurrent: analysis.guardSkippedCurrent,
        malformedSupersedes: analysis.malformedSupersedes,
      };
    }

    const ids = analysis.candidates.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM shared_memory WHERE tenant_id = ? AND id IN (${placeholders})`
    ).all(tenantId, ...ids) as any[];

    const backup = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: 'neural-ai-collaboration/compact_memory',
      filter: { tenantId, reclaimClass: 'superseded' },
      entities: [] as any[],
      observations: rows,
      relations: [] as any[],
      counts: { entities: 0, observations: rows.length, relations: 0 },
    };

    const trashId = uuidv4();
    const insertTrash = this.db.prepare(
      `INSERT INTO data_trash (trash_id, tenant_id, reason, entity_names, counts, backup)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const delLookup = this.db.prepare('DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?');
    const delRow = this.db.prepare('DELETE FROM shared_memory WHERE id = ? AND tenant_id = ?');

    const entityNames = Array.from(new Set(analysis.candidates.map((c) => c.entityName).filter(Boolean)));
    const txn = this.db.transaction(() => {
      const info = insertTrash.run(
        trashId, tenantId,
        reason || 'compact_memory: superseded-observation reclaim',
        JSON.stringify(entityNames),
        JSON.stringify(backup.counts),
        JSON.stringify(backup)
      );
      if (info.changes !== 1) {
        throw new Error('Trash write failed — aborting compaction (no delete)');
      }
      let deleted = 0;
      for (const id of ids) {
        delLookup.run(tenantId, id);
        deleted += delRow.run(id, tenantId).changes;
      }
      return deleted;
    });
    const reclaimedRows = txn();

    if (this.vectorClient) {
      for (const id of ids) {
        try { await this.vectorClient.deleteMemory(id); } catch { /* non-fatal */ }
      }
    }
    this.auditLog('compact_superseded', 'compact_memory', JSON.stringify({ trashId, reclaimedRows }), tenantId);

    return {
      trashId, reclaimedRows,
      reclaimedBytes: analysis.candidateBytes,
      guardSkippedCurrent: analysis.guardSkippedCurrent,
      malformedSupersedes: analysis.malformedSupersedes,
    };
  }

  /** Class C — vector rows whose source memory no longer exists. */
  compactAnalyzeVecOrphans(): { orphanRows: number } {
    if (!this.tableExists('neural_vec_index')) return { orphanRows: 0 };
    const orphanRows = Object.values(this.db.prepare(`
      SELECT COUNT(*) AS c FROM neural_vec_index v
      WHERE NOT EXISTS (SELECT 1 FROM shared_memory sm WHERE sm.id = v.memory_id)
    `).get() as any)[0] as number;
    return { orphanRows };
  }

  async compactExecuteVecOrphans(): Promise<{ reclaimedRows: number; errors: number }> {
    if (!this.tableExists('neural_vec_index')) return { reclaimedRows: 0, errors: 0 };
    const orphans = this.db.prepare(`
      SELECT memory_id FROM neural_vec_index v
      WHERE NOT EXISTS (SELECT 1 FROM shared_memory sm WHERE sm.id = v.memory_id)
    `).all() as Array<{ memory_id: string }>;

    let reclaimedRows = 0;
    let errors = 0;
    for (const { memory_id } of orphans) {
      try {
        if (this.vectorClient) {
          await this.vectorClient.deleteMemory(memory_id);
        } else {
          const row = this.db.prepare('SELECT vector_rowid FROM neural_vec_index WHERE memory_id = ?').get(memory_id) as any;
          if (row?.vector_rowid != null && this.tableExists('shared_memory_vec')) {
            this.db.prepare('DELETE FROM shared_memory_vec WHERE rowid = ?').run(row.vector_rowid);
          }
          this.db.prepare('DELETE FROM neural_vec_index WHERE memory_id = ?').run(memory_id);
        }
        reclaimedRows++;
      } catch {
        errors++;
      }
    }
    this.auditLog('compact_vec_orphans', 'compact_memory', JSON.stringify({ reclaimedRows, errors }), 'default');
    return { reclaimedRows, errors };
  }

  /** Class D — read messages older than the cutoff get the archived flag. */
  compactAnalyzeMessageArchive(tenantId: string = 'default', olderThanDays: number = 14): { candidates: number; cutoffDays: number } {
    const candidates = Object.values(this.db.prepare(`
      SELECT COUNT(*) AS c FROM ai_messages
      WHERE tenant_id = ? AND read_at IS NOT NULL AND archived_at IS NULL
        AND created_at < datetime('now', ?)
    `).get(tenantId, `-${Math.max(1, olderThanDays)} days`) as any)[0] as number;
    return { candidates, cutoffDays: olderThanDays };
  }

  compactExecuteMessageArchive(tenantId: string = 'default', olderThanDays: number = 14): { archivedRows: number; cutoffDays: number } {
    const info = this.db.prepare(`
      UPDATE ai_messages SET archived_at = datetime('now')
      WHERE tenant_id = ? AND read_at IS NOT NULL AND archived_at IS NULL
        AND created_at < datetime('now', ?)
    `).run(tenantId, `-${Math.max(1, olderThanDays)} days`);
    this.auditLog('compact_message_archive', 'compact_memory', JSON.stringify({ archivedRows: info.changes }), tenantId);
    return { archivedRows: info.changes, cutoffDays: olderThanDays };
  }
}
