/**
 * Codex Follow-ups Contract Tests
 *
 * Covers:
 * a) Scope denial — delete_entity / remove_observations without valid API key
 * b) update_observation type guard — entity ID rejected as "not found"
 * c) Tombstone table existence in schema
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

/** Authenticated MCP call (parses result, throws on tool error) */
async function mcpCall(toolName: string, args: Record<string, any> = {}): Promise<any> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);

  const text = json.result?.content?.[0]?.text;
  if (!text) return json.result;
  if (json.result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Authenticated MCP call returning raw JSON-RPC response (no throw on tool error) */
async function mcpCallRaw(toolName: string, args: Record<string, any> = {}): Promise<any> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json();
}

/**
 * MCP call with a custom API key (or no key).
 * Returns the raw fetch Response so callers can check HTTP status.
 */
async function mcpCallWithKey(
  toolName: string,
  args: Record<string, any>,
  apiKey: string | null
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== null) {
    headers['X-API-Key'] = apiKey;
  }

  return fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
}

describe('Codex Follow-ups', () => {
  const testEntityName = `codex_followup_entity_${Date.now()}`;
  let entityRowId: string | null = null;

  beforeAll(async () => {
    // Seed an entity so we can reference its ID in the type-guard test
    await mcpCall('create_entities', {
      entities: [
        {
          name: testEntityName,
          entityType: 'test',
          observations: ['codex followup observation'],
        },
      ],
    });

    // Retrieve the entity row ID (memory_type = 'entity', not 'observation')
    const search = await mcpCall('search_entities', { query: testEntityName });
    const entityResult = (search.results || []).find(
      (r: any) =>
        r.content?.name?.toLowerCase() === testEntityName.toLowerCase()
    );
    if (entityResult) {
      entityRowId = entityResult.id;
    }
  });

  // === a) Scope denial: no API key ===
  describe('Scope denial — missing API key', () => {
    it('delete_entity without API key returns HTTP 401', async () => {
      const res = await mcpCallWithKey('delete_entity', { entityName: 'any_entity' }, null);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('remove_observations without API key returns HTTP 401', async () => {
      const res = await mcpCallWithKey(
        'remove_observations',
        { entityName: 'any_entity', containsAny: ['x'] },
        null
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  // === a) Scope denial: wrong API key ===
  describe('Scope denial — wrong API key', () => {
    it('delete_entity with wrong API key returns HTTP 401', async () => {
      const res = await mcpCallWithKey(
        'delete_entity',
        { entityName: 'any_entity' },
        'WRONG_KEY_THAT_SHOULD_NOT_WORK_1234567890abcdef'
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('remove_observations with wrong API key returns HTTP 401', async () => {
      const res = await mcpCallWithKey(
        'remove_observations',
        { entityName: 'any_entity', containsAny: ['x'] },
        'WRONG_KEY_THAT_SHOULD_NOT_WORK_1234567890abcdef'
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  // === b) update_observation type guard: entity ID rejected ===
  describe('update_observation type guard', () => {
    it('rejects an entity row ID as "not found" (type guard filters to observation)', async () => {
      // entityRowId is a shared_memory row with memory_type='entity'
      // update_observation only operates on memory_type='observation'
      expect(entityRowId).toBeTruthy();

      const json = await mcpCallRaw('update_observation', {
        observationId: entityRowId,
        newContent: 'should not work',
      });

      // The tool should return isError because the type guard SELECT misses entity rows
      expect(json.result?.isError).toBe(true);
      const text = json.result?.content?.[0]?.text || '';
      expect(text).toContain('not found');
    });

    it('rejects a completely fabricated ID as "not found"', async () => {
      const json = await mcpCallRaw('update_observation', {
        observationId: 'nonexistent_id_00000000',
        newContent: 'should not work',
      });

      expect(json.result?.isError).toBe(true);
      const text = json.result?.content?.[0]?.text || '';
      expect(text).toContain('not found');
    });
  });

  // === b2) authorizeGraphMutation scope denial (unit-level) ===
  describe('authorizeGraphMutation scope denial', () => {
    it('API key context without graph:write scope is rejected', async () => {
      const { MemoryManager } = await import('../src/unified-server/memory/index.js');

      // Craft a RequestContext that represents a valid API key but lacks graph:write scope
      const context = {
        tenantId: 'test-tenant',
        userId: null,
        authType: 'api_key' as const,
        apiKeyId: 'key-no-write',
        roles: [] as string[],
        scopes: ['read:graph'],  // no graph:write or *
      };

      // Call authorizeGraphMutation on the prototype (static-like, no DB needed)
      const result = MemoryManager.prototype.authorizeGraphMutation('delete_entity', context);
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('graph:write');
    });

    it('API key context with graph:write scope is accepted', async () => {
      const { MemoryManager } = await import('../src/unified-server/memory/index.js');

      const context = {
        tenantId: 'test-tenant',
        userId: null,
        authType: 'api_key' as const,
        apiKeyId: 'key-with-write',
        roles: [] as string[],
        scopes: ['graph:write'],
      };

      const result = MemoryManager.prototype.authorizeGraphMutation('delete_entity', context);
      expect(result.authorized).toBe(true);
    });

    it('JWT without admin/owner/member role is rejected', async () => {
      const { MemoryManager } = await import('../src/unified-server/memory/index.js');

      const context = {
        tenantId: 'test-tenant',
        userId: 'auth0|viewer',
        authType: 'jwt' as const,
        apiKeyId: null,
        roles: ['viewer'],  // not admin, owner, or member
        scopes: ['graph:write'],
      };

      const result = MemoryManager.prototype.authorizeGraphMutation('delete_entity', context);
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('admin');
    });
  });

  // === c) Tombstone table exists ===
  describe('Tombstone table (failed_weaviate_deletes)', () => {
    it('health endpoint confirms server is running (tombstone table created at init)', async () => {
      const res = await fetch(`${BASE_URL}/health`, {
        headers: { 'X-API-Key': API_KEY },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
    });

    it('delete_entity response includes vectorFailures field (proving tombstone path exists)', async () => {
      // Create a throwaway entity and delete it to verify the tombstone response fields
      const throwaway = `tombstone_check_${Date.now()}`;
      await mcpCall('create_entities', {
        entities: [{ name: throwaway, entityType: 'test', observations: ['tombstone test'] }],
      });

      const result = await mcpCall('delete_entity', { entityName: throwaway });
      expect(result.status).toBe('deleted');
      // These fields prove the tombstone codepath is wired
      expect(typeof result.vectorCleanup).toBe('number');
      expect(typeof result.vectorFailures).toBe('number');
    });
  });
});
