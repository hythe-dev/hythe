/**
 * Task 1300: search_entities Dedup Contract Tests
 *
 * Verifies that search_entities deduplicates results by (entity_name, tenant_id).
 * Highest relevance score wins; source provenance is preserved.
 */
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

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

describe('search_entities Dedup (Task 1300)', () => {
  const dedupEntityName = `dedup_test_${Date.now()}`;

  it('creates duplicate entities with the same name', async () => {
    // Create two entities with the same name (simulates duplicates from multiple writes)
    const created1 = await mcpCall('create_entities', {
      entities: [
        {
          name: dedupEntityName,
          entityType: 'test_dedup',
          observations: ['first observation for dedup test'],
        },
      ],
    });
    expect(created1.created).toBe(1);

    const created2 = await mcpCall('create_entities', {
      entities: [
        {
          name: dedupEntityName,
          entityType: 'test_dedup',
          observations: ['second observation for dedup test'],
        },
      ],
    });
    expect(created2.created).toBe(1);
  });

  it('search returns deduplicated results — one entry per entity name', async () => {
    const searched = await mcpCall('search_entities', {
      query: dedupEntityName,
      searchType: 'exact',
      limit: 50,
    });

    // Find all results that match our entity name
    const matching = searched.results.filter((r: any) => {
      const name = r.content?.name;
      return name && name.toLowerCase() === dedupEntityName.toLowerCase();
    });

    // After dedup, there should be exactly 1 result for this entity name
    expect(matching.length).toBe(1);
  });

  it('dedup preserves source provenance', async () => {
    const searched = await mcpCall('search_entities', {
      query: dedupEntityName,
      searchType: 'exact',
      limit: 50,
    });

    const matching = searched.results.filter((r: any) => {
      const name = r.content?.name;
      return name && name.toLowerCase() === dedupEntityName.toLowerCase();
    });

    // The surviving result should have a sources array
    expect(matching.length).toBe(1);
    expect(matching[0].sources).toBeDefined();
    expect(Array.isArray(matching[0].sources)).toBe(true);
    expect(matching[0].sources.length).toBeGreaterThanOrEqual(1);
  });

  it('response includes dedup metadata when dedup occurred', async () => {
    const searched = await mcpCall('search_entities', {
      query: dedupEntityName,
      searchType: 'exact',
      limit: 50,
    });

    // When dedup actually removed duplicates, the response should include metadata
    expect(searched.deduplicated).toBeDefined();
    expect(typeof searched.preDeduplicationCount).toBe('number');
    expect(searched.totalResults).toBeLessThanOrEqual(searched.preDeduplicationCount);
  });

  it('highest score wins during dedup', async () => {
    const searched = await mcpCall('search_entities', {
      query: dedupEntityName,
      searchType: 'exact',
      limit: 50,
    });

    const matching = searched.results.filter((r: any) => {
      const name = r.content?.name;
      return name && name.toLowerCase() === dedupEntityName.toLowerCase();
    });

    // The surviving entry should be the highest-scoring representation. An
    // exact entity-name match scores 1.1 (exactEntityMatch tier); a plain name
    // match is 1.0. Assert the dedup kept a top-tier match (>= 1.0), not a
    // brittle exact 1.0 that predates the exactEntityMatch scoring tier.
    expect(matching.length).toBe(1);
    expect(matching[0].searchScore).toBeGreaterThanOrEqual(1.0);
  });
});
