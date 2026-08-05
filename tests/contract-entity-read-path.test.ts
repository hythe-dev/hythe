/**
 * Read-path fix contract: get_entity_detail must present entity state
 * correctly. An entity's embedded observations[] is a creation-time
 * definition snapshot; each entity result carries a resolved
 * `currentObservation` (newest non-superseded observation) and the
 * snapshot is flagged embeddedObservationsAreDefinitionSnapshot.
 */
import { describe, expect, it } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

async function mcpRaw(toolName: string, args: Record<string, any> = {}): Promise<{
  parsed: any;
  text: string;
}> {
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
  if (typeof text !== 'string') throw new Error(`Missing tool text: ${JSON.stringify(json.result)}`);
  if (json.result?.isError) throw new Error(`Tool error: ${text}`);
  return { parsed: JSON.parse(text), text };
}

describe('entity read path: definition snapshot vs current state', () => {
  const tag = Date.now();
  const entityName = `test_readpath_${tag}`;

  it('attaches the resolved current observation and flags the embedded snapshot', async () => {
    const created = await mcpRaw('create_entities', {
      entities: [{
        name: entityName,
        entityType: 'test-fixture',
        observations: ['DEFINITION — creation-time snapshot line'],
      }],
    });
    const entityId = created.parsed.entities?.[0]?.id;
    expect(entityId).toBeTruthy();

    // Two observations: the first is then superseded by the second, so the
    // resolved current must be the superseding one — NOT the newest-by-luck
    // and NOT the embedded snapshot.
    const first = await mcpRaw('add_observations', {
      observations: [{
        entityName,
        contents: ['STATE v1 — will be superseded'],
      }],
    });
    const firstId = first.parsed.observations?.[0]?.id;
    expect(firstId).toBeTruthy();

    const second = await mcpRaw('add_observations', {
      observations: [{
        entityName,
        contents: ['STATE v2 — current'],
        metadata: { supersedes: [firstId], supersedeMode: 'replace-current' },
      }],
    });
    const secondId = second.parsed.observations?.[0]?.id;
    expect(secondId).toBeTruthy();

    const detail = await mcpRaw('get_entity_detail', { entity: entityName });
    const entity = detail.parsed.entities?.find((row: any) => row.id === entityId)
      ?? detail.parsed.entities?.[0];
    expect(entity).toBeTruthy();

    // The embedded snapshot survives untouched (non-destructive) but is labeled.
    expect(entity.embeddedObservationsAreDefinitionSnapshot).toBe(true);
    expect(entity.content?.observations?.length).toBeGreaterThan(0);

    // The resolved current observation rides along and resolves supersession.
    expect(entity.currentObservation).toBeTruthy();
    expect(entity.currentObservation.id).toBe(secondId);
    expect(entity.currentObservation.contents).toEqual(['STATE v2 — current']);
  });

  it('returns currentObservation: null for an entity with no observation rows', async () => {
    // create_entities materializes inline observations into rows, so an
    // entity created with an empty observations array is the no-rows case.
    const bareName = `test_readpath_bare_${tag}`;
    const created = await mcpRaw('create_entities', {
      entities: [{ name: bareName, entityType: 'test-fixture', observations: [] }],
    });
    expect(created.parsed.entities?.[0]?.id).toBeTruthy();

    const detail = await mcpRaw('get_entity_detail', { entity: bareName });
    const entity = detail.parsed.entities?.[0];
    expect(entity).toBeTruthy();
    expect(entity.currentObservation).toBeNull();
    expect(entity.embeddedObservationsAreDefinitionSnapshot).toBeUndefined();
  });
});
