import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

/**
 * Authorization contract for the /api/data management surface.
 *
 * Scope: the feature gate only — these endpoints must be disabled unless
 * ENABLE_DATA_MANAGEMENT=1, and gated by data:read/data:write scope (or the
 * local single-key operator) once enabled. The broader data-management feature
 * behaviour (backup folders, import indexing, snapshots, retire) is exercised
 * elsewhere; this file pins the security gate.
 */
describe('/api/data management gates', () => {
  const API_KEY = 'test-data-management-key-' + 'a'.repeat(32);
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let server: NeuralMCPServer;
  let app: any;

  function boot(enabled = false) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-data-api-'));
    process.env.API_KEY = API_KEY;
    delete process.env.ENABLE_ADMIN_ENDPOINTS;
    if (enabled) {
      process.env.ENABLE_DATA_MANAGEMENT = '1';
    } else {
      delete process.env.ENABLE_DATA_MANAGEMENT;
    }
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
    app = server.getExpressApp();
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('requires authentication before evaluating the data-management feature gate', async () => {
    boot(false);

    const res = await supertest(app)
      .get('/api/data/entity-prefixes')
      .expect(401);

    expect(res.body.code).toBe('API_KEY_MISSING');
  });

  it('keeps data-management endpoints disabled by default', async () => {
    boot(false);

    const res = await supertest(app)
      .get('/api/data/entity-prefixes')
      .set('X-API-Key', API_KEY)
      .expect(403);

    expect(res.body.code).toBe('DATA_MANAGEMENT_DISABLED');
  });

  it('does not enable data-management endpoints from ENABLE_ADMIN_ENDPOINTS alone', async () => {
    boot(false);
    process.env.ENABLE_ADMIN_ENDPOINTS = '1';

    const res = await supertest(app)
      .get('/api/data/entity-prefixes')
      .set('X-API-Key', API_KEY)
      .expect(403);

    expect(res.body.code).toBe('DATA_MANAGEMENT_DISABLED');
  });

  it('keeps mutating endpoints disabled by default too (not just reads)', async () => {
    boot(false);

    const res = await supertest(app)
      .post('/api/data/snapshots')
      .set('X-API-Key', API_KEY)
      .send({ label: 'should-be-blocked' })
      .expect(403);

    expect(res.body.code).toBe('DATA_MANAGEMENT_DISABLED');
  });

  it('allows the explicit local admin surface when ENABLE_DATA_MANAGEMENT=1', async () => {
    boot(true);
    const db = server.getMemoryManager().getDb();
    db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, 'default', 'entity', ?, 'test', '[]')`
    ).run('dm-ent-1', JSON.stringify({ name: 'Alpha-Project', type: 'project' }));

    const res = await supertest(app)
      .get('/api/data/entity-prefixes')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.body.prefixes).toContain('Alpha');
  });
});
