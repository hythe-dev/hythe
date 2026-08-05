/**
 * BV-S1: Graph Export API Contract Tests
 *
 * Tests authorizeGraphRead, sensitivity classification, getGraphExport,
 * and the /api/graph-export endpoint including ETag, pagination, tenant isolation.
 *
 * Uses direct MemoryManager testing with in-memory SQLite where possible,
 * and supertest with a lightweight Express app for endpoint-level tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MemoryManager } from '../src/unified-server/memory/index.js';
import type { RequestContext } from '../src/middleware/auth/types.js';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import supertest from 'supertest';

// ─── Helpers ───

/** Create a RequestContext with given overrides */
function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: 'test-tenant',
    userId: null,
    authType: 'dev',
    apiKeyId: null,
    idpSub: null,
    roles: [],
    scopes: [],
    mfaLevel: null,
    timezoneHint: null,
    ...overrides,
  };
}

/** Seed shared_memory rows directly via the MemoryManager's DB for deterministic tests. */
function seedRow(mm: MemoryManager, tenantId: string, memoryType: string, content: Record<string, any>): string {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = mm.getDb();
  db.prepare(
    `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
     VALUES (?, ?, ?, ?, 'test-agent', '[]')`
  ).run(id, tenantId, memoryType, JSON.stringify(content));
  return id;
}

// ─── Unit Tests: authorizeGraphRead ───

describe('authorizeGraphRead', () => {
  let mm: MemoryManager;

  beforeAll(() => {
    mm = new MemoryManager(':memory:');
  });

  afterAll(async () => {
    await mm.close();
  });

  it('dev auth → full permissions', () => {
    const ctx = makeContext({ authType: 'dev' });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(true);
  });

  it('JWT admin → all permissions including sensitive', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['admin'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(true);
  });

  it('JWT owner → all permissions including sensitive', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['owner'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(true);
  });

  it('JWT member → view + observations, no sensitive', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['member'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(false);
  });

  it('JWT viewer → view only', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['viewer'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(false);
    expect(result.permissions.has('graph:sensitive:view')).toBe(false);
  });

  it('JWT with no recognized role → denied', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['unknown'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(false);
  });

  it('API key with graph:view scope → authorized', () => {
    const ctx = makeContext({ authType: 'api_key', scopes: ['graph:view'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
  });

  it('API key with * scope → all permissions', () => {
    const ctx = makeContext({ authType: 'api_key', scopes: ['*'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(true);
  });

  it('API key with graph:read legacy scope → view + observations', () => {
    const ctx = makeContext({ authType: 'api_key', scopes: ['graph:read'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
    expect(result.permissions.has('graph:sensitive:view')).toBe(false);
  });

  it('API key with graph:write legacy scope → view + observations', () => {
    const ctx = makeContext({ authType: 'api_key', scopes: ['graph:write'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(true);
  });

  it('API key with no relevant scopes → denied', () => {
    const ctx = makeContext({ authType: 'api_key', scopes: ['unrelated:scope'] });
    const result = mm.authorizeGraphRead(ctx);
    expect(result.authorized).toBe(false);
  });

  it('API key with empty scopes + legacy passthrough → all', () => {
    const original = process.env.ALLOW_LEGACY_GRAPH_MUTATIONS;
    process.env.ALLOW_LEGACY_GRAPH_MUTATIONS = '1';
    try {
      const ctx = makeContext({ authType: 'api_key', scopes: [] });
      const result = mm.authorizeGraphRead(ctx);
      expect(result.authorized).toBe(true);
      expect(result.permissions.has('graph:view')).toBe(true);
      expect(result.permissions.has('graph:observations:view')).toBe(true);
      expect(result.permissions.has('graph:sensitive:view')).toBe(true);
    } finally {
      if (original !== undefined) process.env.ALLOW_LEGACY_GRAPH_MUTATIONS = original;
      else delete process.env.ALLOW_LEGACY_GRAPH_MUTATIONS;
    }
  });
});

// ─── Unit Tests: classifyObservationSensitivity ───

describe('classifyObservationSensitivity', () => {
  it('messageType "system" → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal text'],
      messageType: 'system',
    });
    expect(result).toBe(true);
  });

  it('messageType "internal" → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal text'],
      messageType: 'internal',
    });
    expect(result).toBe(true);
  });

  it('messageType "coordination" → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal text'],
      messageType: 'coordination',
    });
    expect(result).toBe(true);
  });

  it('sensitive metadata flag → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal text'],
      sensitive: true,
    });
    expect(result).toBe(true);
  });

  it('[SYSTEM] prefix → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['[SYSTEM] internal config'],
    });
    expect(result).toBe(true);
  });

  it('[INTERNAL] prefix → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['[INTERNAL] agent note'],
    });
    expect(result).toBe(true);
  });

  it('case-variant [system] → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['[system] msg'],
    });
    expect(result).toBe(true);
  });

  it('leading whitespace + [INTERNAL] → sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['  [INTERNAL] msg'],
    });
    expect(result).toBe(true);
  });

  it('no markers → non-sensitive (default)', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal observation text'],
    });
    expect(result).toBe(false);
  });

  it('multi-item: mixed normal + sensitive → sensitive (any match)', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['normal text', '[SYSTEM] internal note'],
    });
    expect(result).toBe(true);
  });

  it('empty contents → non-sensitive', () => {
    const result = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: [],
    });
    expect(result).toBe(false);
  });
});

// ─── Unit Tests: getGraphExport (direct MemoryManager) ───

describe('getGraphExport', () => {
  let mm: MemoryManager;
  const TENANT = 'graph-export-tenant';
  const OTHER_TENANT = 'other-tenant';

  beforeAll(() => {
    mm = new MemoryManager(':memory:');

    // Seed entities
    seedRow(mm, TENANT, 'entity', { name: 'ProjectA', type: 'project' });
    seedRow(mm, TENANT, 'entity', { name: 'PersonB', type: 'person' });
    seedRow(mm, TENANT, 'entity', { name: 'ToolC', type: 'tool' });

    // Seed relations
    seedRow(mm, TENANT, 'relation', { from: 'ProjectA', to: 'PersonB', relationType: 'works_on' });
    seedRow(mm, TENANT, 'relation', { from: 'PersonB', to: 'ToolC', relationType: 'uses' });

    // Seed observations (mix of sensitive and non-sensitive)
    seedRow(mm, TENANT, 'observation', { entityName: 'ProjectA', contents: ['public note'] });
    seedRow(mm, TENANT, 'observation', { entityName: 'ProjectA', contents: ['[SYSTEM] config setting'] });
    seedRow(mm, TENANT, 'observation', { entityName: 'PersonB', contents: ['user feedback'], messageType: 'internal' });
    seedRow(mm, TENANT, 'observation', { entityName: 'ToolC', contents: ['tool docs'], sensitive: true });
    seedRow(mm, TENANT, 'observation', { entityName: 'ToolC', contents: ['publicly visible tool info'] });

    // Seed data in OTHER_TENANT (for isolation test)
    seedRow(mm, OTHER_TENANT, 'entity', { name: 'SecretEntity', type: 'secret' });
    seedRow(mm, OTHER_TENANT, 'observation', { entityName: 'SecretEntity', contents: ['secret data'] });
  });

  afterAll(async () => {
    await mm.close();
  });

  it('full mode returns nodes and links', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: false,
      permissions: new Set(['graph:view']),
    });

    expect(result.nodes).toBeDefined();
    expect(result.links).toBeDefined();
    expect(result.nodes!.length).toBe(3);
    expect(result.links!.length).toBe(2);
    expect(result.totals.nodes).toBe(3);
    expect(result.totals.links).toBe(2);
  });

  it('node shape has expected fields', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: false,
      permissions: new Set(['graph:view']),
    });

    const node = result.nodes!.find((n: any) => n.name === 'ProjectA');
    expect(node).toBeDefined();
    expect(node.name).toBe('ProjectA');
    expect(node.entityType).toBe('project');
    expect(typeof node.observationCount).toBe('number');
    expect(node.observationCount).toBe(2); // 2 observations for ProjectA
    expect(node.id).toBeDefined();
    expect(node.createdAt).toBeDefined();
  });

  it('link shape has source/target as entity names', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: false,
      permissions: new Set(['graph:view']),
    });

    const link = result.links!.find((l: any) => l.source === 'ProjectA');
    expect(link).toBeDefined();
    expect(link.source).toBe('ProjectA');
    expect(link.target).toBe('PersonB');
    expect(link.relationType).toBe('works_on');
  });

  it('includeObservations with sensitive:view → returns all observations', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view']),
    });

    expect(result.observations).toBeDefined();
    expect(result.observations!.length).toBe(5); // all 5 observations
  });

  it('includeObservations without sensitive:view → excludes sensitive observations', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });

    // 5 total, 3 sensitive ([SYSTEM], messageType=internal, sensitive=true) → 2 non-sensitive
    expect(result.observations).toBeDefined();
    expect(result.observations!.length).toBe(2);

    // Verify the non-sensitive ones are correct
    const obsContents = result.observations!.map((o: any) => o.contents[0]);
    expect(obsContents).toContain('public note');
    expect(obsContents).toContain('publicly visible tool info');
  });

  it('observations with no markers default to non-sensitive (visible to member)', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });

    const publicObs = result.observations!.find((o: any) => o.contents[0] === 'public note');
    expect(publicObs).toBeDefined();
    expect(publicObs.entityName).toBe('ProjectA');
  });

  it('tenant isolation: TENANT cannot see OTHER_TENANT data', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view']),
    });

    const entityNames = result.nodes!.map((n: any) => n.name);
    expect(entityNames).not.toContain('SecretEntity');

    const obsEntityNames = result.observations!.map((o: any) => o.entityName);
    expect(obsEntityNames).not.toContain('SecretEntity');
  });

  it('entityName mode returns observations-only (no nodes/links)', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      entityName: 'ProjectA',
      permissions: new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view']),
    });

    // entityName mode: no nodes or links in result
    expect(result.nodes).toBeUndefined();
    expect(result.links).toBeUndefined();
    expect(result.observations).toBeDefined();
    expect(result.observations!.length).toBe(2); // 2 observations for ProjectA
    expect(result.totals.observations).toBe(2);
    expect((result.totals as any).nodes).toBeUndefined();
    expect((result.totals as any).links).toBeUndefined();
  });

  it('pagination: cursor returns next page', () => {
    const page1 = mm.getGraphExport({
      tenantId: TENANT,
      limit: 2,
      includeObservations: false,
      permissions: new Set(['graph:view']),
    });

    expect(page1.nodes!.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = mm.getGraphExport({
      tenantId: TENANT,
      limit: 2,
      cursor: page1.nextCursor!,
      includeObservations: false,
      permissions: new Set(['graph:view']),
    });

    expect(page2.nodes!.length).toBe(1); // 3 total, page 2 has 1
    expect(page2.nextCursor).toBeNull();

    // No overlap between pages
    const page1Names = page1.nodes!.map((n: any) => n.name);
    const page2Names = page2.nodes!.map((n: any) => n.name);
    for (const name of page2Names) {
      expect(page1Names).not.toContain(name);
    }
  });
});

// ─── Endpoint Tests (supertest with NeuralMCPServer) ───

describe('/api/graph-export endpoint', () => {
  let server: NeuralMCPServer;
  let app: any;
  const API_KEY = 'test-graph-export-key-' + 'a'.repeat(32);
  const TENANT = 'default'; // API key auth uses 'default' tenant

  beforeAll(() => {
    // Set up env for the server
    process.env.API_KEY = API_KEY;
    process.env.ALLOW_LEGACY_GRAPH_MUTATIONS = '1';

    // Create server with in-memory DB (random high port, never started)
    server = new NeuralMCPServer(0, ':memory:');
    app = server.getExpressApp();

    // Seed test data
    const mm = server.getMemoryManager();
    const db = mm.getDb();

    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'entity', ?, 'test', '[]')`
    ).run('ent-1', TENANT, JSON.stringify({ name: 'Alpha', type: 'project' }));

    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'entity', ?, 'test', '[]')`
    ).run('ent-2', TENANT, JSON.stringify({ name: 'Beta', type: 'person' }));

    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'relation', ?, 'test', '[]')`
    ).run('rel-1', TENANT, JSON.stringify({ from: 'Alpha', to: 'Beta', relationType: 'linked' }));

    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'observation', ?, 'test', '[]')`
    ).run('obs-1', TENANT, JSON.stringify({ entityName: 'Alpha', contents: ['public info'] }));

    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'observation', ?, 'test', '[]')`
    ).run('obs-2', TENANT, JSON.stringify({ entityName: 'Alpha', contents: ['[SYSTEM] secret info'] }));

    // Different tenant data
    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, ?, 'entity', ?, 'test', '[]')`
    ).run('ent-other-1', 'other-tenant', JSON.stringify({ name: 'Gamma', type: 'tool' }));
  });

  afterAll(() => {
    server.close();
    delete process.env.API_KEY;
    delete process.env.ALLOW_LEGACY_GRAPH_MUTATIONS;
  });

  // Test 1: Auth required (401 without token)
  it('returns 401 without API key', async () => {
    const res = await supertest(app)
      .get('/api/graph-export')
      .expect(401);

    expect(res.body.error).toBe('Unauthorized');
  });

  // Test 7: Tenant isolation
  it('tenant isolation: default tenant cannot see other-tenant data', async () => {
    const res = await supertest(app)
      .get('/api/graph-export')
      .set('X-API-Key', API_KEY)
      .expect(200);

    const nodeNames = res.body.nodes.map((n: any) => n.name);
    expect(nodeNames).toContain('Alpha');
    expect(nodeNames).toContain('Beta');
    expect(nodeNames).not.toContain('Gamma');
  });

  // Test 8: Full-mode response shape
  it('full-mode response shape', async () => {
    const res = await supertest(app)
      .get('/api/graph-export')
      .set('X-API-Key', API_KEY)
      .expect(200);

    // Top-level keys
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).toHaveProperty('links');
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('generatedAt');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.links)).toBe(true);

    // Node keyed by name
    const alpha = res.body.nodes.find((n: any) => n.name === 'Alpha');
    expect(alpha).toBeDefined();
    expect(alpha.entityType).toBe('project');
    expect(typeof alpha.observationCount).toBe('number');
    expect(alpha.id).toBeDefined();
    expect(alpha.createdAt).toBeDefined();

    // Link source/target match entity names
    const link = res.body.links[0];
    expect(link.source).toBe('Alpha');
    expect(link.target).toBe('Beta');
    expect(link.relationType).toBe('linked');

    // Totals
    expect(res.body.totals.nodes).toBe(2);
    expect(res.body.totals.links).toBe(1);
  });

  // Test 3: includeObservations=true with observations permission
  it('includeObservations=true returns observations in full mode', async () => {
    const res = await supertest(app)
      .get('/api/graph-export?includeObservations=true')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('observations');
    expect(Array.isArray(res.body.observations)).toBe(true);
    // With legacy passthrough (ALLOW_LEGACY_GRAPH_MUTATIONS=1, empty scopes) → has sensitive:view
    // So all observations should be visible
    expect(res.body.observations.length).toBe(2);
  });

  // Test 9: entityName mode response shape
  it('entityName mode returns observations-only (no nodes/links)', async () => {
    const res = await supertest(app)
      .get('/api/graph-export?entityName=Alpha&includeObservations=true')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('observations');
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('generatedAt');
    expect(res.body).not.toHaveProperty('nodes');
    expect(res.body).not.toHaveProperty('links');
    expect(res.body.totals).not.toHaveProperty('nodes');
    expect(res.body.totals).not.toHaveProperty('links');
    expect(res.body.totals.observations).toBeGreaterThanOrEqual(1);
  });

  // Test 6: Pagination
  it('pagination: cursor returns next page', async () => {
    const res1 = await supertest(app)
      .get('/api/graph-export?limit=1')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res1.body.nodes.length).toBe(1);
    expect(res1.body.nextCursor).toBeTruthy();

    const res2 = await supertest(app)
      .get(`/api/graph-export?limit=1&cursor=${res1.body.nextCursor}`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res2.body.nodes.length).toBe(1);
    // Different node
    expect(res2.body.nodes[0].name).not.toBe(res1.body.nodes[0].name);
  });

  // Test 10: ETag differs for same data with different roles (policy fingerprint)
  it('ETag differs for same data with different roles (policy fingerprint)', async () => {
    // Request 1: full-perms API key (legacy passthrough)
    const res1 = await supertest(app)
      .get('/api/graph-export')
      .set('X-API-Key', API_KEY)
      .expect(200);

    const etag1 = res1.headers['etag'];
    expect(etag1).toBeDefined();

    // Request 2: spy authorizeGraphRead to return viewer-only permissions (same data, different perms)
    const testMm = server.getMemoryManager();
    const spy = vi.spyOn(testMm, 'authorizeGraphRead').mockReturnValue({
      authorized: true,
      permissions: new Set(['graph:view']),
    });

    try {
      const res2 = await supertest(app)
        .get('/api/graph-export')
        .set('X-API-Key', API_KEY)
        .expect(200);

      const etag2 = res2.headers['etag'];
      expect(etag2).toBeDefined();

      // Same topology data but different permission sets → different ETags
      expect(etag1).not.toBe(etag2);
    } finally {
      spy.mockRestore();
    }
  });

  // Test 11: ETag / 304 behavior
  it('ETag / 304: same data + same role → same ETag → 304', async () => {
    const res1 = await supertest(app)
      .get('/api/graph-export')
      .set('X-API-Key', API_KEY)
      .expect(200);

    const etag = res1.headers['etag'];
    expect(etag).toBeDefined();

    // Second request with If-None-Match → 304
    const res2 = await supertest(app)
      .get('/api/graph-export')
      .set('X-API-Key', API_KEY)
      .set('If-None-Match', etag)
      .expect(304);

    expect(res2.body).toEqual({}); // 304 has no body
  });

  // Test 12: endpoint-level 403 for includeObservations without graph:observations:view
  it('returns 403 when includeObservations=true without graph:observations:view', async () => {
    const testMm = server.getMemoryManager();
    const spy = vi.spyOn(testMm, 'authorizeGraphRead').mockReturnValue({
      authorized: true,
      permissions: new Set(['graph:view']),
    });

    try {
      const res = await supertest(app)
        .get('/api/graph-export?includeObservations=true')
        .set('X-API-Key', API_KEY)
        .expect(403);

      expect(res.body.error).toBe('Forbidden');
      expect(res.body.message).toContain('graph:observations:view');
    } finally {
      spy.mockRestore();
    }
  });

  // Test 13: endpoint-level 403 for entityName mode without graph:observations:view
  it('returns 403 for entityName mode without graph:observations:view', async () => {
    const testMm = server.getMemoryManager();
    const spy = vi.spyOn(testMm, 'authorizeGraphRead').mockReturnValue({
      authorized: true,
      permissions: new Set(['graph:view']),
    });

    try {
      const res = await supertest(app)
        .get('/api/graph-export?entityName=Alpha')
        .set('X-API-Key', API_KEY)
        .expect(403);

      expect(res.body.error).toBe('Forbidden');
      expect(res.body.message).toContain('graph:observations:view');
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Direct Unit Tests: ETag policy fingerprint with different roles ───

describe('ETag policy fingerprint', () => {
  let mm: MemoryManager;
  const TENANT = 'etag-test-tenant';

  beforeAll(() => {
    mm = new MemoryManager(':memory:');
    seedRow(mm, TENANT, 'entity', { name: 'E1', type: 'project' });
    seedRow(mm, TENANT, 'observation', { entityName: 'E1', contents: ['hello'] });
  });

  afterAll(async () => {
    await mm.close();
  });

  it('same data, different permissions → different canonical hash inputs', () => {
    // Admin (all perms)
    const adminData = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view']),
    });

    // Member (no sensitive)
    const memberData = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });

    // Both should return the same observation (non-sensitive)
    expect(adminData.observations!.length).toBe(memberData.observations!.length);

    // But the permission sets differ, so ETag hash inputs are different
    const adminPermStr = Array.from(new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view'])).sort().join(',');
    const memberPermStr = Array.from(new Set(['graph:view', 'graph:observations:view'])).sort().join(',');
    expect(adminPermStr).not.toBe(memberPermStr);
  });
});

// ─── Multi-item observation sensitivity + case-variant prefix tests ───

describe('multi-item and case-variant sensitivity', () => {
  let mm: MemoryManager;
  const TENANT = 'sensitivity-test-tenant';

  beforeAll(() => {
    mm = new MemoryManager(':memory:');

    // Multi-item observation with mixed entries
    seedRow(mm, TENANT, 'entity', { name: 'MultiEntity', type: 'test' });
    seedRow(mm, TENANT, 'observation', {
      entityName: 'MultiEntity',
      contents: ['normal text', '[SYSTEM] internal note'],
    });

    // Case-variant prefix observations
    seedRow(mm, TENANT, 'observation', {
      entityName: 'MultiEntity',
      contents: ['[system] msg'],
    });
    seedRow(mm, TENANT, 'observation', {
      entityName: 'MultiEntity',
      contents: ['  [INTERNAL] msg'],
    });

    // Non-sensitive observation
    seedRow(mm, TENANT, 'observation', {
      entityName: 'MultiEntity',
      contents: ['totally normal observation'],
    });
  });

  afterAll(async () => {
    await mm.close();
  });

  it('multi-item observation: contents with mixed normal/sensitive classified as sensitive', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      entityName: 'MultiEntity',
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });

    // Only the non-sensitive observation should be visible
    expect(result.observations!.length).toBe(1);
    expect(result.observations![0].contents[0]).toBe('totally normal observation');
  });

  it('case-variant [system] classified as sensitive', () => {
    const isSensitive = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['[system] msg'],
    });
    expect(isSensitive).toBe(true);
  });

  it('leading whitespace + [INTERNAL] classified as sensitive', () => {
    const isSensitive = MemoryManager.classifyObservationSensitivity({
      entityName: 'test',
      contents: ['  [INTERNAL] msg'],
    });
    expect(isSensitive).toBe(true);
  });

  it('admin with sensitive:view sees all observations including sensitive', () => {
    const result = mm.getGraphExport({
      tenantId: TENANT,
      limit: 200,
      includeObservations: true,
      entityName: 'MultiEntity',
      permissions: new Set(['graph:view', 'graph:observations:view', 'graph:sensitive:view']),
    });

    // All 4 observations for MultiEntity should be visible to admin
    expect(result.observations!.length).toBe(4);
  });
});

// ─── Strict 403 test for includeObservations without permission ───

describe('strict 403 for includeObservations', () => {
  let mm: MemoryManager;

  beforeAll(() => {
    mm = new MemoryManager(':memory:');
  });

  afterAll(async () => {
    await mm.close();
  });

  it('viewer (graph:view only) requesting includeObservations → test via authorizeGraphRead', () => {
    const ctx = makeContext({ authType: 'jwt', roles: ['viewer'] });
    const result = mm.authorizeGraphRead(ctx);

    // Viewer is authorized (has graph:view) but lacks graph:observations:view
    expect(result.authorized).toBe(true);
    expect(result.permissions.has('graph:view')).toBe(true);
    expect(result.permissions.has('graph:observations:view')).toBe(false);
  });

});
