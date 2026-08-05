import type Database from 'better-sqlite3';
import { createRequire } from 'module';
import { MemoryItem, MemoryType } from './types';

type SearchOptions = {
  query: string;
  agentId?: string;
  tenantId?: string;
  limit?: number;
  filters?: Record<string, unknown>;
};

type IndexRow = {
  memory_id: string;
  agent_id: string;
  tenant_id: string;
  memory_type: string;
  content: string;
  timestamp_ms: number;
  tags_json: string | null;
  priority: number | null;
  relationships_json: string | null;
  embedding_json: string | null;
  distance?: number;
};

type EmbeddingRecord = {
  vector_rowid: number | null;
};

/**
 * Embedded vector-memory backend.
 * Uses sqlite-vec when available, with graceful lexical/JS fallback modes.
 */
export class SqliteVecClient {
  private readonly db: Database.Database;
  private readonly vectorTableName: string;
  private readonly indexTableName: string;
  private readonly dimensions: number;
  private readonly embeddingModel: string;
  private readonly embeddingCacheDir?: string;
  private readonly fallbackCandidateLimit: number;

  private initialized = false;
  private extensionLoaded = false;
  private extensionLoadError: string | null = null;
  private pipelinePromise: Promise<any | null> | null = null;
  private transformerUnavailable = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.vectorTableName = this.sanitizeIdentifier(process.env.SQLITE_VEC_TABLE, 'shared_memory_vec');
    this.indexTableName = this.sanitizeIdentifier(process.env.SQLITE_VEC_INDEX_TABLE, 'neural_vec_index');
    this.dimensions = this.parsePositiveInt(process.env.SQLITE_VEC_DIMENSIONS, 384);
    this.embeddingModel = process.env.SQLITE_VEC_MODEL || process.env.TRANSFORMERS_MODEL || 'Xenova/all-MiniLM-L6-v2';
    this.embeddingCacheDir = process.env.SQLITE_VEC_CACHE_DIR || process.env.TRANSFORMERS_CACHE_DIR;
    this.fallbackCandidateLimit = this.parsePositiveInt(process.env.SQLITE_VEC_FALLBACK_CANDIDATES, 300);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.ensureIndexSchema();
    this.extensionLoaded = this.tryLoadSqliteVecExtension();

    if (this.extensionLoaded) {
      try {
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vectorTableName} USING vec0(
             embedding float[${this.dimensions}]
           )`
        );
      } catch (error: any) {
        this.extensionLoaded = false;
        this.extensionLoadError = error?.message || 'vec0 table creation failed';
        console.warn(`⚠️ sqlite-vec vec0 unavailable, fallback mode enabled: ${this.extensionLoadError}`);
      }
    } else {
      console.warn('⚠️ sqlite-vec extension unavailable, fallback mode enabled');
    }

    this.initialized = true;
    console.log(`✅ sqlite-vec client initialized (${this.extensionLoaded ? 'vec0' : 'fallback'} mode)`);

    // Warm the embedding model in the background. The transformer pipeline is
    // loaded lazily on the first createEmbedding() call (dynamic import + model
    // load), which can take several seconds — long enough for the FIRST semantic
    // search to exceed the MCP request timeout (observed in live diagnostics).
    // Kicking it off here (non-blocking) means the model is usually warm before
    // any user query arrives, so semantic recall stops intermittently timing out.
    void this.warmEmbeddingModel();
  }

  /** Pre-load the embedding pipeline so the first semantic query isn't a cold start. */
  async warmEmbeddingModel(): Promise<void> {
    if (this.transformerUnavailable) return;
    const startedAt = Date.now();
    try {
      const pipeline = await this.getEmbeddingPipeline();
      if (pipeline) {
        await this.createEmbedding('warmup'); // resident weights, not just an import
        console.log(`✅ embedding model warmed in ${Date.now() - startedAt}ms`);
      }
    } catch (error: any) {
      console.warn(`⚠️ embedding model warmup failed (non-fatal): ${error?.message || error}`);
    }
  }

  async storeMemory(memory: MemoryItem): Promise<string> {
    if (!this.initialized) await this.initialize();

    const tenantId = memory.tenantId || 'default';
    const content = memory.content || '';
    const tags = JSON.stringify(memory.tags || []);
    const relationships = JSON.stringify(memory.relationships || []);
    const priority = Number.isFinite(memory.priority) ? memory.priority : 5;
    const timestamp = Number.isFinite(memory.timestamp) ? memory.timestamp : Date.now();
    const embedding = await this.createEmbedding(content);
    // Store the JSON embedding copy ONLY in fallback mode. When the vec0
    // extension is loaded, the binary vector in the vec0 table is the search
    // path (searchWithVectors ranks by vec distance and never reads
    // embedding_json), so persisting the JSON too is pure redundancy — it was
    // ~71MB of the live DB. searchWithFallback is the only consumer of
    // embedding_json, and it only runs when the extension is absent.
    const embeddingJson = (!this.extensionLoaded && embedding) ? JSON.stringify(embedding) : null;

    const existing = this.db.prepare(
      `SELECT vector_rowid FROM ${this.indexTableName} WHERE memory_id = ?`
    ).get(memory.id) as EmbeddingRecord | undefined;

    let vectorRowId: number | null = null;
    if (this.extensionLoaded && embedding) {
      vectorRowId = this.insertVector(embedding);
    }

    this.db.prepare(
      `INSERT INTO ${this.indexTableName} (
         memory_id, agent_id, tenant_id, memory_type, content, timestamp_ms,
         tags_json, priority, relationships_json, vector_rowid, embedding_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(memory_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         tenant_id = excluded.tenant_id,
         memory_type = excluded.memory_type,
         content = excluded.content,
         timestamp_ms = excluded.timestamp_ms,
         tags_json = excluded.tags_json,
         priority = excluded.priority,
         relationships_json = excluded.relationships_json,
         vector_rowid = excluded.vector_rowid,
         embedding_json = excluded.embedding_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      memory.id,
      memory.agentId,
      tenantId,
      memory.type,
      content,
      timestamp,
      tags,
      priority,
      relationships,
      vectorRowId,
      embeddingJson
    );

    // Remove previous vector row after successful upsert (best effort).
    if (this.extensionLoaded && existing?.vector_rowid && existing.vector_rowid !== vectorRowId) {
      try {
        this.db.prepare(`DELETE FROM ${this.vectorTableName} WHERE rowid = ?`).run(existing.vector_rowid);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to clean old sqlite-vec row for ${memory.id}:`, cleanupError);
      }
    }

    return memory.id;
  }

  async searchMemories(
    queryOrOptions: string | SearchOptions,
    agentId?: string,
    memoryType?: MemoryType,
    limit: number = 10,
    tenantId?: string
  ): Promise<MemoryItem[]> {
    if (!this.initialized) await this.initialize();

    const parsed = this.parseSearchOptions(queryOrOptions, agentId, memoryType, limit, tenantId);
    const queryEmbedding = await this.createEmbedding(parsed.query);

    if (this.extensionLoaded && queryEmbedding) {
      try {
        const vectorRows = this.searchWithVectors(parsed, queryEmbedding);
        if (vectorRows.length > 0) return vectorRows.map((row) => this.rowToMemoryItem(row));
      } catch (vectorError: any) {
        console.warn(`⚠️ sqlite-vec search failed, using fallback: ${vectorError?.message || vectorError}`);
      }
    }

    const fallbackRows = this.searchWithFallback(parsed, queryEmbedding);
    return fallbackRows.map((row) => this.rowToMemoryItem(row));
  }

  async calculateSimilarity(memory1: MemoryItem, memory2: MemoryItem): Promise<number> {
    const v1 = await this.createEmbedding(memory1.content || '');
    const v2 = await this.createEmbedding(memory2.content || '');
    if (!v1 || !v2) return 0;
    return this.cosineSimilarity(v1, v2);
  }

  async getAgentMemories(agentId: string, limit: number = 50, tenantId: string = 'default'): Promise<MemoryItem[]> {
    if (!this.initialized) await this.initialize();
    const rows = this.db.prepare(
      `SELECT memory_id, agent_id, tenant_id, memory_type, content, timestamp_ms, tags_json, priority, relationships_json, embedding_json
       FROM ${this.indexTableName}
       WHERE agent_id = ? AND tenant_id = ?
       ORDER BY timestamp_ms DESC
       LIMIT ?`
    ).all(agentId, tenantId, limit) as IndexRow[];
    return rows.map((row) => this.rowToMemoryItem(row));
  }

  async updateMemory(id: string, updates: Partial<MemoryItem>): Promise<void> {
    if (!this.initialized) await this.initialize();

    const existing = this.db.prepare(
      `SELECT memory_id, agent_id, tenant_id, memory_type, content, timestamp_ms, tags_json, priority, relationships_json
       FROM ${this.indexTableName} WHERE memory_id = ?`
    ).get(id) as IndexRow | undefined;

    if (!existing) throw new Error(`Memory ${id} not found in sqlite-vec index`);

    const merged: MemoryItem = {
      id,
      agentId: updates.agentId || existing.agent_id,
      tenantId: updates.tenantId || existing.tenant_id,
      type: (updates.type as MemoryType) || (existing.memory_type as MemoryType),
      content: updates.content ?? existing.content,
      timestamp: updates.timestamp ?? existing.timestamp_ms,
      tags: updates.tags || this.parseStringArray(existing.tags_json),
      priority: updates.priority ?? (existing.priority || 5),
      relationships: updates.relationships || this.parseStringArray(existing.relationships_json),
      metadata: updates.metadata
    };

    await this.storeMemory(merged);
  }

  async deleteMemory(id: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    const existing = this.db.prepare(
      `SELECT vector_rowid FROM ${this.indexTableName} WHERE memory_id = ?`
    ).get(id) as EmbeddingRecord | undefined;

    if (this.extensionLoaded && existing?.vector_rowid) {
      try {
        this.db.prepare(`DELETE FROM ${this.vectorTableName} WHERE rowid = ?`).run(existing.vector_rowid);
      } catch (error: any) {
        throw new Error(`sqlite-vec delete failed for ${id}: ${error?.message || error}`);
      }
    }

    this.db.prepare(`DELETE FROM ${this.indexTableName} WHERE memory_id = ?`).run(id);
  }

  async getMemoryStats(): Promise<{ total: number; byType: Record<string, number> }> {
    if (!this.initialized) await this.initialize();

    const byTypeRows = this.db.prepare(
      `SELECT memory_type, COUNT(*) as cnt
       FROM ${this.indexTableName}
       GROUP BY memory_type`
    ).all() as Array<{ memory_type: string; cnt: number }>;

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM ${this.indexTableName}`
    ).get() as { cnt: number };

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.memory_type] = row.cnt;
    }

    return { total: totalRow?.cnt || 0, byType };
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1 as ok').get();
      this.db.prepare(`SELECT COUNT(*) as cnt FROM ${this.indexTableName}`).get();
      if (this.extensionLoaded) {
        this.db.prepare(`SELECT rowid FROM ${this.vectorTableName} LIMIT 1`).all();
      }
      return true;
    } catch (error) {
      console.error('❌ sqlite-vec health check failed:', error);
      return false;
    }
  }

  async getStatistics(): Promise<{ totalMemories: number; indexedVectors: number; backend: string; [key: string]: any }> {
    if (!this.initialized) await this.initialize();

    const row = this.db.prepare(
      `SELECT
         COUNT(*) as total_memories,
         SUM(CASE WHEN vector_rowid IS NOT NULL THEN 1 ELSE 0 END) as indexed_vectors
       FROM ${this.indexTableName}`
    ).get() as { total_memories: number; indexed_vectors: number };

    return {
      totalMemories: row?.total_memories || 0,
      indexedVectors: row?.indexed_vectors || 0,
      backend: 'sqlite-vec',
      mode: this.extensionLoaded ? 'vec0' : 'fallback',
      dimensions: this.dimensions,
      embeddingModel: this.embeddingModel,
      extensionLoaded: this.extensionLoaded,
      extensionLoadError: this.extensionLoadError,
      transformersAvailable: !this.transformerUnavailable
    };
  }

  async cleanup(): Promise<void> {
    // No-op for embedded sqlite-vec; kept for interface parity.
    console.log('🧹 sqlite-vec cleanup completed');
  }

  private parseSearchOptions(
    queryOrOptions: string | SearchOptions,
    agentId?: string,
    memoryType?: MemoryType,
    limit: number = 10,
    tenantId?: string
  ): { query: string; agentId?: string; memoryType?: string; tenantId: string; limit: number } {
    if (typeof queryOrOptions === 'string') {
      return {
        query: queryOrOptions,
        agentId,
        memoryType,
        tenantId: tenantId || 'default',
        limit: Math.max(1, limit)
      };
    }

    const optionFilters = queryOrOptions.filters || {};
    const filteredType = typeof optionFilters.memoryType === 'string' ? optionFilters.memoryType : undefined;

    return {
      query: queryOrOptions.query,
      agentId: queryOrOptions.agentId || agentId,
      memoryType: filteredType || memoryType,
      tenantId: queryOrOptions.tenantId || tenantId || 'default',
      limit: Math.max(1, queryOrOptions.limit || limit)
    };
  }

  private searchWithVectors(
    options: { query: string; agentId?: string; memoryType?: string; tenantId: string; limit: number },
    queryEmbedding: number[]
  ): IndexRow[] {
    // vec0 KNN requires the `k = ?` constraint inside the MATCH query itself
    // (a trailing LIMIT throws "A LIMIT or 'k = ?' constraint is required").
    // Do the KNN as a standalone CTE against the vec0 table, then JOIN back to
    // the index table for tenant/type/agent filtering. Because filters apply
    // AFTER knn, over-fetch k so post-filtering still returns enough rows.
    const overfetch = Math.min(500, Math.max(options.limit * 5, 50));
    let sql = `
      WITH knn AS (
        SELECT rowid, distance
        FROM ${this.vectorTableName}
        WHERE embedding MATCH ? AND k = ?
      )
      SELECT
        m.memory_id, m.agent_id, m.tenant_id, m.memory_type, m.content, m.timestamp_ms,
        m.tags_json, m.priority, m.relationships_json, m.embedding_json, knn.distance
      FROM knn
      JOIN ${this.indexTableName} m ON m.vector_rowid = knn.rowid
      WHERE m.tenant_id = ?
    `;

    const params: Array<string | number> = [JSON.stringify(queryEmbedding), overfetch, options.tenantId];

    if (options.agentId) {
      sql += ' AND m.agent_id = ?';
      params.push(options.agentId);
    }

    if (options.memoryType) {
      sql += ' AND m.memory_type = ?';
      params.push(options.memoryType);
    }

    sql += ' ORDER BY knn.distance ASC LIMIT ?';
    params.push(options.limit);

    return this.db.prepare(sql).all(...params) as IndexRow[];
  }

  private searchWithFallback(
    options: { query: string; agentId?: string; memoryType?: string; tenantId: string; limit: number },
    queryEmbedding: number[] | null
  ): IndexRow[] {
    let sql = `
      SELECT
        memory_id, agent_id, tenant_id, memory_type, content, timestamp_ms,
        tags_json, priority, relationships_json, embedding_json
      FROM ${this.indexTableName}
      WHERE tenant_id = ? AND LOWER(content) LIKE LOWER(?)
    `;

    const params: Array<string | number> = [options.tenantId, `%${options.query}%`];

    if (options.agentId) {
      sql += ' AND agent_id = ?';
      params.push(options.agentId);
    }

    if (options.memoryType) {
      sql += ' AND memory_type = ?';
      params.push(options.memoryType);
    }

    const candidateLimit = Math.max(options.limit * 4, this.fallbackCandidateLimit);
    sql += ' ORDER BY timestamp_ms DESC LIMIT ?';
    params.push(candidateLimit);

    let rows = this.db.prepare(sql).all(...params) as IndexRow[];

    // If phrase-match fallback misses, pull a broader candidate set and rank in-process.
    if (rows.length === 0 && queryEmbedding) {
      let broadSql = `
        SELECT
          memory_id, agent_id, tenant_id, memory_type, content, timestamp_ms,
          tags_json, priority, relationships_json, embedding_json
        FROM ${this.indexTableName}
        WHERE tenant_id = ?
      `;
      const broadParams: Array<string | number> = [options.tenantId];
      if (options.agentId) {
        broadSql += ' AND agent_id = ?';
        broadParams.push(options.agentId);
      }
      if (options.memoryType) {
        broadSql += ' AND memory_type = ?';
        broadParams.push(options.memoryType);
      }
      broadSql += ' ORDER BY timestamp_ms DESC LIMIT ?';
      broadParams.push(candidateLimit);
      rows = this.db.prepare(broadSql).all(...broadParams) as IndexRow[];
    }

    if (rows.length <= options.limit) return rows;

    const scored = rows.map((row) => {
      const lexicalScore = this.lexicalScore(options.query, row.content);
      const embeddingScore = this.embeddingScore(queryEmbedding, row.embedding_json);
      const score = embeddingScore > 0 ? (0.75 * embeddingScore + 0.25 * lexicalScore) : lexicalScore;
      return { row, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit).map((entry) => entry.row);
  }

  private rowToMemoryItem(row: IndexRow): MemoryItem {
    return {
      id: row.memory_id,
      agentId: row.agent_id,
      tenantId: row.tenant_id || 'default',
      type: row.memory_type as MemoryType,
      content: row.content,
      timestamp: Number(row.timestamp_ms) || Date.now(),
      tags: this.parseStringArray(row.tags_json),
      priority: Number.isFinite(row.priority) ? Number(row.priority) : 5,
      relationships: this.parseStringArray(row.relationships_json),
      metadata: row.distance !== undefined ? { distance: row.distance } : undefined
    };
  }

  private parseStringArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }

  private async createEmbedding(text: string): Promise<number[] | null> {
    const normalized = (text || '').trim();
    if (!normalized) return null;

    const pipeline = await this.getEmbeddingPipeline();
    if (pipeline) {
      try {
        const result = await pipeline(normalized, { pooling: 'mean', normalize: true });
        const vector = this.extractVector(result);
        if (vector && vector.length > 0) {
          return this.ensureDimensions(vector);
        }
      } catch (error: any) {
        console.warn(`⚠️ Transformer embedding failed, using hash fallback: ${error?.message || error}`);
      }
    }

    return this.hashEmbedding(normalized);
  }

  private async getEmbeddingPipeline(): Promise<any | null> {
    if (this.transformerUnavailable) return null;
    if (this.pipelinePromise) return this.pipelinePromise;

    this.pipelinePromise = (async () => {
      const module = await this.dynamicImportTransformers();
      if (!module) {
        this.transformerUnavailable = true;
        return null;
      }

      const env = module.env || module.default?.env;
      if (env) {
        if (this.embeddingCacheDir) env.cacheDir = this.embeddingCacheDir;
        if (process.env.SQLITE_VEC_ALLOW_REMOTE_MODELS === 'false') env.allowRemoteModels = false;
      }

      const pipelineFactory = module.pipeline || module.default?.pipeline;
      if (typeof pipelineFactory !== 'function') {
        this.transformerUnavailable = true;
        console.warn('⚠️ Transformers module loaded but no pipeline() export found');
        return null;
      }

      try {
        return await pipelineFactory('feature-extraction', this.embeddingModel);
      } catch (error: any) {
        this.transformerUnavailable = true;
        console.warn(`⚠️ Failed to initialize transformer model "${this.embeddingModel}": ${error?.message || error}`);
        return null;
      }
    })();

    return this.pipelinePromise;
  }

  private async dynamicImportTransformers(): Promise<any | null> {
    const importer = new Function('m', 'return import(m);') as (moduleName: string) => Promise<any>;
    const candidates = ['@xenova/transformers', '@huggingface/transformers'];

    for (const candidate of candidates) {
      try {
        return await importer(candidate);
      } catch {
        // Keep trying candidates.
      }
    }

    console.warn('⚠️ No transformers runtime found (@xenova/transformers or @huggingface/transformers)');
    return null;
  }

  private extractVector(result: any): number[] | null {
    if (!result) return null;

    if (Array.isArray(result)) {
      if (result.length === 0) return null;
      if (Array.isArray(result[0])) {
        return (result[0] as number[]).map((v) => Number(v) || 0);
      }
      return result.map((v) => Number(v) || 0);
    }

    if (result.data && typeof result.data.length === 'number') {
      return Array.from(result.data as ArrayLike<number>).map((v) => Number(v) || 0);
    }

    if (typeof result.tolist === 'function') {
      const listed = result.tolist();
      if (Array.isArray(listed) && listed.length > 0) {
        if (Array.isArray(listed[0])) return (listed[0] as number[]).map((v) => Number(v) || 0);
        return listed.map((v: number) => Number(v) || 0);
      }
    }

    return null;
  }

  private ensureDimensions(vector: number[]): number[] {
    if (vector.length === this.dimensions) return vector;
    if (vector.length > this.dimensions) return vector.slice(0, this.dimensions);
    return vector.concat(new Array(this.dimensions - vector.length).fill(0));
  }

  private hashEmbedding(text: string): number[] {
    const output = new Array(this.dimensions).fill(0) as number[];
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % this.dimensions;
      output[idx] += 1;
    }

    const norm = Math.sqrt(output.reduce((sum, value) => sum + (value * value), 0));
    if (norm === 0) return output;
    return output.map((value) => value / norm);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private lexicalScore(query: string, content: string): number {
    const q = query.toLowerCase().trim();
    const c = (content || '').toLowerCase();
    if (!q || !c) return 0;
    if (c.includes(q)) return 1;

    const qTokens = new Set(q.split(/\s+/).filter(Boolean));
    const cTokens = new Set(c.split(/\s+/).filter(Boolean));
    if (qTokens.size === 0 || cTokens.size === 0) return 0;

    let overlap = 0;
    for (const token of qTokens) {
      if (cTokens.has(token)) overlap++;
    }
    return overlap / qTokens.size;
  }

  private embeddingScore(queryEmbedding: number[] | null, embeddingJson: string | null): number {
    if (!queryEmbedding || !embeddingJson) return 0;
    try {
      const parsed = JSON.parse(embeddingJson);
      if (!Array.isArray(parsed)) return 0;
      const embedding = parsed.map((v: number) => Number(v) || 0);
      const aligned = this.ensureDimensions(embedding);
      return this.cosineSimilarity(queryEmbedding, aligned);
    } catch {
      return 0;
    }
  }

  private insertVector(embedding: number[]): number {
    const result = this.db.prepare(
      `INSERT INTO ${this.vectorTableName} (embedding) VALUES (?)`
    ).run(JSON.stringify(embedding));
    return Number(result.lastInsertRowid);
  }

  private ensureIndexSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.indexTableName} (
         memory_id TEXT PRIMARY KEY,
         agent_id TEXT NOT NULL,
         tenant_id TEXT NOT NULL DEFAULT 'default',
         memory_type TEXT NOT NULL,
         content TEXT NOT NULL,
         timestamp_ms INTEGER NOT NULL,
         tags_json TEXT,
         priority INTEGER DEFAULT 5,
         relationships_json TEXT,
         vector_rowid INTEGER,
         embedding_json TEXT,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`
    );

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.indexTableName}_tenant ON ${this.indexTableName}(tenant_id, timestamp_ms DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.indexTableName}_agent ON ${this.indexTableName}(agent_id, tenant_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.indexTableName}_type ON ${this.indexTableName}(memory_type, tenant_id)`);
  }

  private tryLoadSqliteVecExtension(): boolean {
    const require = createRequire(import.meta.url);
    let sqliteVecModule: any = null;

    try {
      sqliteVecModule = require('sqlite-vec');
    } catch (error: any) {
      this.extensionLoadError = error?.message || 'sqlite-vec module not installed';
      return false;
    }

    // Preferred API: sqliteVec.load(db)
    try {
      if (typeof sqliteVecModule.load === 'function') {
        sqliteVecModule.load(this.db);
        return true;
      }
      if (typeof sqliteVecModule.default?.load === 'function') {
        sqliteVecModule.default.load(this.db);
        return true;
      }
    } catch (loadError: any) {
      this.extensionLoadError = loadError?.message || 'sqlite-vec load(db) failed';
    }

    const candidates: string[] = [];
    if (typeof sqliteVecModule.getLoadablePath === 'function') {
      try {
        const path = sqliteVecModule.getLoadablePath();
        if (path) candidates.push(path);
      } catch { /* ignore */ }
    }
    if (typeof sqliteVecModule.default?.getLoadablePath === 'function') {
      try {
        const path = sqliteVecModule.default.getLoadablePath();
        if (path) candidates.push(path);
      } catch { /* ignore */ }
    }
    if (typeof sqliteVecModule.path === 'string') candidates.push(sqliteVecModule.path);
    if (typeof sqliteVecModule.loadablePath === 'string') candidates.push(sqliteVecModule.loadablePath);

    // Deduplicate and try each candidate path
    const tryPaths: string[] = [];
    for (const candidate of candidates) {
      // better-sqlite3 loadExtension auto-appends platform suffix (.so/.dylib/.dll),
      // so strip it to avoid double extension (vec0.so.so). Case-insensitive for Windows.
      const stripped = candidate.replace(/\.(so|dylib|dll)$/i, '');
      if (!tryPaths.includes(stripped)) tryPaths.push(stripped);
      if (!tryPaths.includes(candidate)) tryPaths.push(candidate);
    }

    for (const tryPath of tryPaths) {
      try {
        this.db.loadExtension(tryPath);
        return true;
      } catch (error: any) {
        this.extensionLoadError = error?.message || `sqlite-vec loadExtension failed (${tryPath})`;
      }
    }

    return false;
  }

  private sanitizeIdentifier(value: string | undefined, fallback: string): string {
    if (!value) return fallback;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return fallback;
    // SQLite reserves sqlite_* object names for internal use.
    if (value.toLowerCase().startsWith('sqlite_')) return fallback;
    return value;
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
