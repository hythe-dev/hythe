/**
 * Recall robustness: the broad/semantic fallback in search_entities must not
 * hang. When memoryManager.search() is slow (cold embedding model, huge result
 * set), the handler should degrade to the exact rows it already has and set
 * semanticDegraded:true, rather than blocking past the MCP request timeout.
 *
 * In-process via supertest so we can stub memoryManager.search() to be slow —
 * deterministic, no reliance on real timing or a live server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

const API_KEY = 'test-search-timeout-key-' + 'a'.repeat(32);

describe('search_entities broad-fallback timeout', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let server: NeuralMCPServer;
  let app: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.API_KEY = API_KEY;
    process.env.SEARCH_SEMANTIC_TIMEOUT_MS = '50'; // small so the test is fast
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-search-timeout-'));
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
    app = server.getExpressApp();
  });

  afterEach(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  async function search(query: string, searchType = 'hybrid') {
    const res = await supertest(app)
      .post('/mcp')
      .set('X-API-Key', API_KEY)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_entities', arguments: { query, searchType, limit: 3 } } })
      .expect(200);
    return JSON.parse(res.body.result.content[0].text);
  }

  it('degrades to exact results when the broad search exceeds the timeout', async () => {
    // Stub the broad search to hang well past the 50ms timeout.
    const mm: any = server.getMemoryManager();
    mm.search = () => new Promise(() => {}); // never resolves

    const started = Date.now();
    const out = await search('nonexistent-query-zzz-9988', 'hybrid');
    const elapsed = Date.now() - started;

    expect(out.semanticDegraded).toBe(true);   // degrade path fired
    expect(out.exactAnchored).toBe(false);      // no exact rows for this query
    expect(elapsed).toBeLessThan(2000);         // returned promptly, did not hang
  });

  it('does not degrade when exact matches anchor the search (broad path skipped)', async () => {
    // Seed an entity so exact search anchors and the broad fallback is skipped.
    await supertest(app).post('/mcp').set('X-API-Key', API_KEY).send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_entities', arguments: { entities: [
        { name: 'timeout-probe-entity', entityType: 'test', observations: ['anchor'] },
      ] } },
    }).expect(200);

    // Even if the broad search would hang, exact anchoring means it's never called.
    const mm: any = server.getMemoryManager();
    mm.search = () => new Promise(() => {});

    const out = await search('timeout-probe-entity', 'exact');
    expect(out.exactAnchored).toBe(true);
    expect(out.semanticDegraded).toBe(false);
    expect(out.totalMatches).toBeGreaterThanOrEqual(1);
  });
});
