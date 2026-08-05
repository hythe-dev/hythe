/**
 * get_individual_memory must always return a valid MCP response.
 *
 * Regression: getAgentMemory returns undefined for an agent with no snapshot;
 * JSON.stringify(undefined) === undefined (not a string), which produced
 * content[0] = { type:'text', text: undefined } and failed MCP content-schema
 * validation (Zod: path content.0.text "expected string"). The handler must
 * return a well-formed empty-state payload instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

const API_KEY = 'test-getmem-key-' + 'a'.repeat(32);

describe('get_individual_memory MCP response', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let server: NeuralMCPServer;
  let app: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.API_KEY = API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-getmem-'));
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
    app = server.getExpressApp();
  });

  afterEach(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  async function call(args: Record<string, any>) {
    const res = await supertest(app)
      .post('/mcp')
      .set('X-API-Key', API_KEY)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_individual_memory', arguments: args } })
      .expect(200);
    return res.body;
  }

  it('returns a valid string content block for an agent with no memory (empty state)', async () => {
    const body = await call({ agentId: 'agent-with-no-memory-xyz' });
    // No JSON-RPC error, and content[0].text is a string (the bug produced undefined here).
    expect(body.error).toBeUndefined();
    const block = body.result?.content?.[0];
    expect(block?.type).toBe('text');
    expect(typeof block?.text).toBe('string');
    const parsed = JSON.parse(block.text);
    expect(parsed.found).toBe(false);
    expect(parsed.agentId).toBe('agent-with-no-memory-xyz');
  });

  it('returns valid content after the agent has recorded a learning', async () => {
    await supertest(app).post('/mcp').set('X-API-Key', API_KEY).send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'record_learning', arguments: {
        agentId: 'agent-with-memory', context: 'testing', lesson: 'guard undefined returns', confidence: 0.9 } },
    }).expect(200);

    const body = await call({ agentId: 'agent-with-memory' });
    expect(body.error).toBeUndefined();
    const block = body.result?.content?.[0];
    expect(block?.type).toBe('text');
    expect(typeof block?.text).toBe('string');
    expect(() => JSON.parse(block.text)).not.toThrow();
  });
});
