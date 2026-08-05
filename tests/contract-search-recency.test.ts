import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

describe('Scoped recency search', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('advertises recency, entity scope, and memory type filters', async () => {
    const search = UnifiedToolSchemas.search_entities;
    expect(search.inputSchema.properties.sortBy.enum).toContain('recency');
    expect(search.inputSchema.properties.canonicalEntityKey).toBeDefined();
    expect(search.inputSchema.properties.memoryTypes).toBeDefined();
  });

  it('filters to one entity before paginating and orders newest first', async () => {
    const suffix = Date.now();
    const scopedEntity = `recency-scope-${suffix}`;
    const otherEntity = `recency-other-${suffix}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        { name: scopedEntity, entityType: 'test', observations: [] },
        { name: otherEntity, entityType: 'test', observations: [] },
      ],
    });
    const scoped = await mcpCall(server, 'add_observations', {
      observations: [
        { entityName: scopedEntity, contents: ['shared state old'] },
        { entityName: scopedEntity, contents: ['shared state current'] },
      ],
    });
    const outside = await mcpCall(server, 'add_observations', {
      observations: [{ entityName: otherEntity, contents: ['shared state outside'] }],
    });

    const [oldId, currentId] = scoped.observations.map((observation: any) => observation.id);
    const outsideId = outside.observations[0].id;
    const db = server.getMemoryManager().getDb();
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-01-01 00:00:00', oldId);
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-02-01 00:00:00', currentId);
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-03-01 00:00:00', outsideId);

    const page = await mcpCall(server, 'search_entities', {
      query: 'shared state',
      canonicalEntityKey: scopedEntity,
      memoryTypes: ['observation'],
      sortBy: 'recency',
      compact: false,
      limit: 1,
    });

    expect(page.sortBy).toBe('recency');
    expect(page.canonicalEntityKey).toBe(scopedEntity);
    expect(page.totalMatches).toBe(2);
    expect(page.returnedResults).toBe(1);
    expect(page.nextOffset).toBe(1);
    expect(page.results[0].id).toBe(currentId);
    expect(page.results[0].canonicalEntityName).toBe(scopedEntity);
    expect(page.results[0].id).not.toBe(outsideId);

    const secondPage = await mcpCall(server, 'search_entities', {
      query: 'shared state',
      canonicalEntityKey: scopedEntity,
      memoryTypes: ['observation'],
      sortBy: 'recency',
      compact: false,
      limit: 1,
      offset: 1,
    });
    expect(secondPage.results[0].id).toBe(oldId);
  });

  it('normalizes spaces and punctuation in canonical entity scopes', async () => {
    const suffix = Date.now();
    const scopedEntity = `Canonical Scope.Project ${suffix}`;
    const canonicalKey = `canonical-scope-project-${suffix}`;

    await mcpCall(server, 'create_entities', {
      entities: [{ name: scopedEntity, entityType: 'test', observations: [] }],
    });
    const added = await mcpCall(server, 'add_observations', {
      observations: [{ entityName: scopedEntity, contents: ['normalized scope result'] }],
    });

    const page = await mcpCall(server, 'search_entities', {
      query: 'normalized scope result',
      canonicalEntityKey: `  Canonical Scope/Project ${suffix}  `,
      memoryTypes: ['observation'],
      compact: false,
      limit: 10,
    });

    expect(page.canonicalEntityKey).toBe(canonicalKey);
    expect(page.totalMatches).toBe(1);
    expect(page.results[0].id).toBe(added.observations[0].id);
    expect(page.results[0].canonicalEntityName).toBe(scopedEntity);
  });
});
