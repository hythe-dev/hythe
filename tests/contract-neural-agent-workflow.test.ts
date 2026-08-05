import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('Neural agent workflow metadata', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('resolves entity aliases and preserves agent bootstrap metadata', async () => {
    const ts = Date.now();
    const entityName = `workflow-project-${ts}-llc`;
    const alias = `workflow-project-${ts}`;

    const created = await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          aliases: [alias],
          agentBootstrap: ['Read latest observations before taking next action.'],
          metadata: { owner: 'contract-test' },
          observations: ['Initial project context.'],
        },
      ],
    });

    expect(created.created).toBe(1);
    expect(created.entities[0].aliases).toContain(alias);
    expect(created.entities[0].agentBootstrap).toContain('Read latest observations before taking next action.');
    expect(created.entities[0].metadata.owner).toBe('contract-test');

    const searched = await mcpCall(server, 'search_entities', {
      query: alias,
      searchType: 'exact',
      limit: 10,
      compact: false,
    });

    expect(searched.exactEntityMatches).toBeGreaterThanOrEqual(1);
    expect(searched.exactOnly).toBe(true);
    expect(searched.results[0].content.name).toBe(entityName);
    expect(searched.results[0].searchScore).toBe(1.1);
  });

  it('stores structured correction metadata on observations', async () => {
    const ts = Date.now();
    const entityName = `workflow-corrections-${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: ['Old project fact.'],
        },
      ],
    });

    const added = await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: ['Current project fact.'],
          kind: 'correction',
          canonicalFact: 'Current project fact.',
          supersedes: ['old-project-fact'],
          appliesTo: [entityName],
          severity: 'high',
        },
      ],
    });

    const metadata = added.observations[0].metadata;
    expect(metadata.kind).toBe('correction');
    expect(metadata.canonicalFact).toBe('Current project fact.');
    expect(metadata.supersedes).toContain('old-project-fact');
    expect(metadata.appliesTo).toContain(entityName);
    expect(metadata.severity).toBe('high');
    expect(metadata.source).toBe('add_observations');
    expect(metadata.canonicalEntityKey).toBe(entityName.toLowerCase());
    expect(metadata.contentHash).toBe(createHash('sha256').update('Current project fact.').digest('hex'));

    const db = server.getMemoryManager().getDb();
    const row = db.prepare(
      "SELECT content FROM shared_memory WHERE id = ? AND memory_type = 'observation'"
    ).get(added.observations[0].id) as any;
    const persisted = JSON.parse(row.content);
    expect(persisted.metadata).toMatchObject({
      kind: 'correction',
      canonicalFact: 'Current project fact.',
      source: 'add_observations',
      canonicalEntityKey: entityName.toLowerCase(),
      contentHash: createHash('sha256').update('Current project fact.').digest('hex'),
    });

    const searched = await mcpCall(server, 'search_entities', {
      query: entityName,
      searchType: 'exact',
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });

    const structuredResult = searched.results.find((result: any) => result.structuredObservation?.kind === 'correction');
    expect(searched.exactOnly).toBe(true);
    expect(searched.exactObservationMatches).toBeGreaterThanOrEqual(1);
    expect(structuredResult).toBeTruthy();
    expect(structuredResult.structuredObservation.canonicalFact).toBe('Current project fact.');
  });

  it('derives exact lookup keys from names and handle-like observations', async () => {
    const ts = Date.now();
    const entityName = `Acme Voice Launch ${ts}`;
    const handle = `hb-voice-v${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [`Initial launch handle is ${handle}.`],
        },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: [`Latest handoff is tracked under ${handle}.`],
          kind: 'handoff',
          canonicalFact: `Latest handoff is tracked under ${handle}.`,
        },
      ],
    });

    const byDerivedName = await mcpCall(server, 'search_entities', {
      query: 'acme-voice',
      searchType: 'exact',
      limit: 10,
      compact: false,
    });
    expect(byDerivedName.exactOnly).toBe(true);
    expect(byDerivedName.exactEntityMatches).toBeGreaterThanOrEqual(1);
    expect(byDerivedName.results.some((result: any) => result.content?.name === entityName)).toBe(true);

    const byHandle = await mcpCall(server, 'search_entities', {
      query: handle,
      searchType: 'exact',
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });
    const handoff = byHandle.results.find((result: any) => result.structuredObservation?.kind === 'handoff');
    expect(byHandle.exactOnly).toBe(true);
    expect(byHandle.exactObservationMatches).toBeGreaterThanOrEqual(1);
    expect(handoff).toBeTruthy();
    expect(handoff.structuredObservation.canonicalFact).toContain(handle);
  });

  it('materializes inline entity observations as queryable observation rows', async () => {
    const ts = Date.now();
    const entityName = `Inline Observation Project ${ts}`;
    const handle = `inline-observation-handle-${ts}`;

    const created = await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [`Inline observation includes ${handle}.`],
        },
      ],
    });

    expect(created.entities[0].materializedInlineObservations).toHaveLength(1);
    expect(created.entities[0].materializedInlineObservations[0].metadata.source).toBe('create_entities_inline');
    expect(created.entities[0].materializedInlineObservations[0].contents[0]).toContain(handle);

    const searched = await mcpCall(server, 'search_entities', {
      query: handle,
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });

    expect(searched.exactAnchored).toBe(true);
    expect(searched.exactObservationMatches).toBeGreaterThanOrEqual(1);
    expect(searched.results.some((result: any) =>
      result.memoryType === 'observation' &&
      result.content?.metadata?.source === 'create_entities_inline' &&
      Array.isArray(result.content?.contents) &&
      result.content.contents[0].includes(handle)
    )).toBe(true);
  });

  it('removes redundant inline entity lookup keys when materialized observation exists', async () => {
    const ts = Date.now();
    const entityName = `Inline Representation Dedupe ${ts}`;
    const handle = `ird-handle-${ts}`;

    const created = await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [`Inline entity text carries ${handle}.`],
        },
      ],
    });

    const entityId = created.entities[0].id;
    const materializedObservationId = created.entities[0].materializedInlineObservations[0].id;
    const db = server.getMemoryManager().getDb();
    const entityLookupKinds = (db.prepare(
      `SELECT key_kind
       FROM graph_lookup_keys
       WHERE tenant_id = ? AND memory_id = ?
       ORDER BY key_kind ASC`
    ).all('default', entityId) as any[]).map((row) => row.key_kind);
    expect(entityLookupKinds).toContain('canonical_name');
    expect(entityLookupKinds).not.toContain('embedded_observation_handle');

    const entityHandleLookup = (db.prepare(
      `SELECT COUNT(*) as cnt
       FROM graph_lookup_keys
       WHERE tenant_id = ?
         AND memory_id = ?
         AND lookup_key = ?`
    ).get('default', entityId, handle) as any)?.cnt || 0;
    expect(entityHandleLookup).toBe(0);

    const materializedHandleLookup = (db.prepare(
      `SELECT COUNT(*) as cnt
       FROM graph_lookup_keys
       WHERE tenant_id = ?
         AND memory_id = ?
         AND lookup_key = ?
         AND key_kind = 'observation_handle'`
    ).get('default', materializedObservationId, handle) as any)?.cnt || 0;
    expect(materializedHandleLookup).toBeGreaterThanOrEqual(1);

    const searched = await mcpCall(server, 'search_entities', {
      query: handle,
      limit: 1,
      compact: false,
    });

    expect(searched.exactAnchored).toBe(true);
    expect(searched.exactEntityMatches).toBe(0);
    expect(searched.exactObservationMatches).toBe(1);
    expect(searched.preRepresentationDeduplicationCount).toBe(1);
    expect(searched.redundantRepresentationCount).toBe(0);
    expect(searched.returnedResults).toBe(1);
    expect(searched.totalResults).toBe(1);
    expect(searched.results[0].memoryType).toBe('observation');
    expect(searched.results[0].content.metadata.source).toBe('create_entities_inline');
    expect(searched.results[0].content.contents[0]).toContain(handle);

    const redundant = await mcpCall(server, 'search_entities', {
      query: handle,
      includeRedundantRepresentations: true,
      limit: 10,
      compact: false,
    });

    const entityResult = redundant.results.find((result: any) => result.memoryType === 'entity');
    expect(redundant.redundantRepresentationCount).toBe(0);
    expect(entityResult).toBeFalsy();
  });

  it('keeps entity name matches even when materialized inline observations also match', async () => {
    const ts = Date.now();
    const entityName = `Inline Name Facet ${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [`Observation belongs to ${entityName}.`],
        },
      ],
    });

    const searched = await mcpCall(server, 'search_entities', {
      query: entityName,
      limit: 10,
      compact: false,
    });

    const entityResult = searched.results.find((result: any) => result.memoryType === 'entity');
    const observationResult = searched.results.find((result: any) => result.memoryType === 'observation');

    expect(entityResult).toBeTruthy();
    expect(observationResult).toBeTruthy();
    expect(entityResult.matchedLookupKinds).toContain('canonical_name');
    expect(entityResult.matchOrigins).toContain('name');
    expect(searched.redundantRepresentationCount).toBe(0);
  });

  it('does not bridge inline observation handles to unrelated observation rows', async () => {
    const ts = Date.now();
    const entityName = `Inline Observation Bridge Guard ${ts}`;
    const handle = `inline-bridge-guard-${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [`Inline-only handle ${handle}.`],
        },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: ['Unrelated later observation for the same entity.'],
          kind: 'handoff',
        },
      ],
    });

    const searched = await mcpCall(server, 'search_entities', {
      query: handle,
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });

    expect(searched.exactAnchored).toBe(true);
    expect(searched.exactObservationMatches).toBe(1);
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0].content.contents[0]).toContain(handle);
  });

  it('preserves repeated inline observations within the same create request', async () => {
    const ts = Date.now();
    const entityName = `Repeated Inline Observation Project ${ts}`;
    const repeated = `Repeated inline observation ${ts}.`;

    const created = await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: [repeated, repeated],
        },
      ],
    });

    expect(created.entities[0].materializedInlineObservations).toHaveLength(2);
    const inlineKeys = created.entities[0].materializedInlineObservations.map((obs: any) => obs.metadata.inlineKey);
    expect(new Set(inlineKeys).size).toBe(2);
  });

  it('uses an indexed lookup bridge for aliases, observations, and relations', async () => {
    const ts = Date.now();
    const entityName = `Indexed Canonical Project ${ts}`;
    const alias = `agent-next-action-${ts}`;
    const related = `Indexed Related Project ${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          aliases: [alias],
          observations: ['Canonical project seed.'],
        },
        {
          name: related,
          entityType: 'project',
          observations: ['Related project seed.'],
        },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: ['Latest indexed handoff for the canonical project.'],
          kind: 'handoff',
        },
      ],
    });
    await mcpCall(server, 'create_relations', {
      relations: [
        {
          from: entityName,
          to: related,
          relationType: 'depends_on',
        },
      ],
    });

    const db = server.getMemoryManager().getDb();
    const lookupCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM graph_lookup_keys WHERE tenant_id = ? AND lookup_key = ?'
    ).get('default', alias) as any)?.cnt || 0;
    expect(lookupCount).toBeGreaterThanOrEqual(1);

    const searched = await mcpCall(server, 'search_entities', {
      query: alias,
      searchType: 'exact',
      limit: 20,
      compact: false,
    });

    expect(searched.exactOnly).toBe(true);
    expect(searched.exactEntityMatches).toBeGreaterThanOrEqual(1);
    expect(searched.exactObservationMatches).toBeGreaterThanOrEqual(1);
    expect(searched.exactRelationMatches).toBeGreaterThanOrEqual(1);
    expect(searched.results.some((result: any) => result.content?.entityName === entityName)).toBe(true);
    expect(searched.results.some((result: any) => result.content?.from === entityName)).toBe(true);
  });

  it('anchors default hybrid search on indexed exact matches without fallback search', async () => {
    const ts = Date.now();
    const entityName = `Hybrid Anchor Project ${ts}`;
    const alias = `hybrid-anchor-${ts}`;
    const handle = `hybrid-anchor-handle-${ts}`;
    const related = `Hybrid Anchor Related ${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          aliases: [alias],
          observations: ['Hybrid anchor seed.'],
        },
        {
          name: related,
          entityType: 'project',
          observations: ['Hybrid anchor related seed.'],
        },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: [`Hybrid default lookup handle ${handle}.`],
          kind: 'handoff',
        },
      ],
    });
    await mcpCall(server, 'create_relations', {
      relations: [
        {
          from: entityName,
          to: related,
          relationType: 'supports',
        },
      ],
    });

    const manager = server.getMemoryManager() as any;
    const originalSearch = manager.search.bind(manager);
    manager.search = async () => {
      throw new Error('fallback search should not run when exact graph matches anchor default search');
    };

    try {
      const searched = await mcpCall(server, 'search_entities', {
        query: alias,
        limit: 20,
        compact: false,
      });

      expect(searched.searchType).toBe('hybrid');
      expect(searched.exactOnly).toBe(false);
      expect(searched.exactAnchored).toBe(true);
      expect(searched.semanticSkipped).toBe('exact_matches');
      expect(searched.exactEntityMatches).toBeGreaterThanOrEqual(1);
      expect(searched.exactObservationMatches).toBeGreaterThanOrEqual(1);
      expect(searched.exactRelationMatches).toBeGreaterThanOrEqual(1);
      expect(searched.results.some((result: any) => result.content?.name === entityName)).toBe(true);
      expect(searched.results.some((result: any) => result.content?.entityName === entityName)).toBe(true);
      expect(searched.results.some((result: any) => result.content?.from === entityName)).toBe(true);
    } finally {
      manager.search = originalSearch;
    }
  });

  it('counts observation prose handle matches before anchoring hybrid observation searches', async () => {
    const ts = Date.now();
    const entityName = `Hybrid Observation Handle Project ${ts}`;
    const handle = `hybrid-observation-handle-${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: ['Hybrid observation handle seed.'],
        },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: [`Observation prose includes ${handle}.`],
          kind: 'handoff',
        },
      ],
    });

    const manager = server.getMemoryManager() as any;
    const originalSearch = manager.search.bind(manager);
    manager.search = async () => {
      throw new Error('fallback search should not run when an observation row matches the handle');
    };

    try {
      const searched = await mcpCall(server, 'search_entities', {
        query: handle,
        memoryType: 'observation',
        limit: 10,
        compact: false,
      });

      expect(searched.exactAnchored).toBe(true);
      expect(searched.semanticSkipped).toBe('exact_matches');
      expect(searched.exactObservationMatches).toBeGreaterThanOrEqual(1);
      expect(searched.results.some((result: any) =>
        result.memoryType === 'observation' &&
        Array.isArray(result.content?.contents) &&
        result.content.contents[0].includes(handle)
      )).toBe(true);
    } finally {
      manager.search = originalSearch;
    }
  });

  it('does not suppress fallback when filters remove all exact candidates', async () => {
    const ts = Date.now();
    const entityName = `Hybrid Filter Entity Only ${ts}`;
    const alias = `hybrid-filter-entity-only-${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          aliases: [alias],
          observations: [],
        },
      ],
    });

    const manager = server.getMemoryManager() as any;
    const originalSearch = manager.search.bind(manager);
    let fallbackCalled = false;
    manager.search = async () => {
      fallbackCalled = true;
      return [];
    };

    try {
      const searched = await mcpCall(server, 'search_entities', {
        query: alias,
        memoryType: 'observation',
        limit: 10,
        compact: false,
      });

      expect(fallbackCalled).toBe(true);
      expect(searched.exactAnchored).toBe(false);
      expect(searched.semanticSkipped).toBe(null);
      expect(searched.exactEntityMatches).toBeGreaterThanOrEqual(1);
      expect(searched.filteredExactMatches).toBe(0);
      expect(searched.totalResults).toBe(0);
    } finally {
      manager.search = originalSearch;
    }
  });

  it('refreshes lookup keys when observations are updated', async () => {
    const ts = Date.now();
    const entityName = `Indexed Update Project ${ts}`;
    const oldHandle = `indexed-update-old-${ts}`;
    const newHandle = `indexed-update-new-${ts}`;

    await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          observations: ['Seed for update test.'],
        },
      ],
    });
    const added = await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: [`Original lookup handle ${oldHandle}.`],
          kind: 'handoff',
        },
      ],
    });

    await server.getMemoryManager().updateObservationContent(
      added.observations[0].id,
      `Updated lookup handle ${newHandle}.`,
      undefined,
      'default'
    );

    const oldSearch = await mcpCall(server, 'search_entities', {
      query: oldHandle,
      searchType: 'exact',
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });
    const newSearch = await mcpCall(server, 'search_entities', {
      query: newHandle,
      searchType: 'exact',
      memoryType: 'observation',
      limit: 10,
      compact: false,
    });

    expect(oldSearch.exactObservationMatches).toBe(0);
    expect(newSearch.exactOnly).toBe(true);
    expect(newSearch.exactObservationMatches).toBeGreaterThanOrEqual(1);
    expect(newSearch.results.some((result: any) =>
      Array.isArray(result.content?.contents) && result.content.contents[0].includes(newHandle)
    )).toBe(true);
  });

  it('can rebuild the lookup index for existing graph rows', async () => {
    const ts = Date.now();
    const entityName = `Indexed Rebuild Project ${ts}`;
    const alias = `indexed-rebuild-alias-${ts}`;
    const id = `indexed-rebuild-${ts}`;
    const db = server.getMemoryManager().getDb();

    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
      VALUES (?, 'default', 'entity', ?, 'contract-test', '[]')
    `).run(id, JSON.stringify({
      name: entityName,
      type: 'project',
      aliases: [alias],
      observations: ['Seeded directly to simulate pre-index data.'],
    }));

    const rebuilt = server.getMemoryManager().rebuildGraphLookupIndex('default');
    expect(rebuilt.rowsIndexed).toBeGreaterThanOrEqual(1);
    expect(rebuilt.keysIndexed).toBeGreaterThanOrEqual(1);

    const searched = await mcpCall(server, 'search_entities', {
      query: alias,
      searchType: 'exact',
      limit: 10,
      compact: false,
    });

    expect(searched.exactOnly).toBe(true);
    expect(searched.results.some((result: any) => result.content?.name === entityName)).toBe(true);
  });

  it('removes lookup keys when graph rows are deleted', async () => {
    const ts = Date.now();
    const entityName = `Indexed Delete Project ${ts}`;
    const alias = `indexed-delete-alias-${ts}`;

    const created = await mcpCall(server, 'create_entities', {
      entities: [
        {
          name: entityName,
          entityType: 'project',
          aliases: [alias],
          observations: ['Seed for delete index cleanup.'],
        },
      ],
    });
    const added = await mcpCall(server, 'add_observations', {
      observations: [
        {
          entityName,
          contents: [`Delete lookup marker ${alias}.`],
          kind: 'handoff',
        },
      ],
    });

    const db = server.getMemoryManager().getDb();
    const ids = [created.entities[0].id, added.observations[0].id];
    const beforeDelete = (db.prepare(
      `SELECT COUNT(*) as cnt FROM graph_lookup_keys WHERE memory_id IN (${ids.map(() => '?').join(',')})`
    ).get(...ids) as any)?.cnt || 0;
    expect(beforeDelete).toBeGreaterThan(0);

    const deleted = await server.getMemoryManager().deleteGraphRows(ids, 'default');
    expect(deleted.deleted).toBe(2);

    const afterDelete = (db.prepare(
      `SELECT COUNT(*) as cnt FROM graph_lookup_keys WHERE memory_id IN (${ids.map(() => '?').join(',')})`
    ).get(...ids) as any)?.cnt || 0;
    expect(afterDelete).toBe(0);
  });

  it('exposes add_observations agentId attribution in tools/list', async () => {
    const listed = await (server as any)._handleToolsList();
    const addObservations = listed.tools.find((tool: any) => tool.name === 'add_observations');
    expect(addObservations?.inputSchema?.properties?.agentId).toMatchObject({
      type: 'string',
    });
    const toolNames = listed.tools.map((tool: any) => tool.name);
    // Step-3 tool diet (TOOL-COMPATIBILITY-MAP.md, corrected per sol
    // b2543ebc): unregister_agent stays DISCOVERABLE (lifecycle symmetry
    // with register_agent); gc_agent_registrations is retired from
    // discovery but its handler remains callable until cutover.
    expect(toolNames).toContain('unregister_agent');
    expect(toolNames).not.toContain('gc_agent_registrations');
    const stillCallable = await (server as any)._handleToolCall('gc_agent_registrations', { dryRun: true });
    expect(stillCallable?.isError).not.toBe(true);
  });

  it('groups registrations by canonical agent identity', async () => {
    const ts = Date.now();
    const canonicalAgentId = `codex-desktop-${ts}`;
    const sessionAgentId = `agent-codex-${ts}-session`;
    const cliAgentId = `${canonicalAgentId}-cli`;

    const registered = await mcpCall(server, 'register_agent', {
      agentId: sessionAgentId,
      name: canonicalAgentId,
      capabilities: ['analysis'],
      metadata: { aliases: [cliAgentId] },
    });

    expect(registered.canonicalAgentId).toBe(canonicalAgentId);
    expect(registered.aliases).toContain(cliAgentId);

    await mcpCall(server, 'register_agent', {
      agentId: cliAgentId,
      name: 'Codex CLI',
      capabilities: ['execution'],
      metadata: { canonicalAgentId },
    });

    const status = await mcpCall(server, 'get_agent_status', {
      groupByCanonical: true,
    });

    const canonical = status.canonicalAgents.find((agent: any) => agent.agentId === canonicalAgentId);
    expect(canonical).toBeTruthy();
    expect(canonical.sessionCount).toBeGreaterThanOrEqual(2);
    expect(canonical.aliases).toContain(sessionAgentId);
    expect(canonical.aliases).toContain(cliAgentId);
    expect(canonical.capabilities).toContain('analysis');
    expect(canonical.capabilities).toContain('execution');
  });

  it('groups non-standard ephemeral agent session IDs by useful display name', async () => {
    const ts = Date.now();
    const canonicalAgentId = `codex-desktop-live-${ts}`;
    const sessionAgentId = `agent-codex-live-${ts}-session`;

    const registered = await mcpCall(server, 'register_agent', {
      agentId: sessionAgentId,
      name: canonicalAgentId,
      capabilities: ['analysis'],
    });

    expect(registered.canonicalAgentId).toBe(canonicalAgentId);

    const status = await mcpCall(server, 'get_agent_status', {
      groupByCanonical: true,
    });

    const canonical = status.canonicalAgents.find((agent: any) => agent.agentId === canonicalAgentId);
    expect(canonical).toBeTruthy();
    expect(canonical.aliases).toContain(sessionAgentId);
    expect(canonical.capabilities).toContain('analysis');
  });

  it('soft-unregisters agent registrations and preserves lifecycle metadata', async () => {
    const ts = Date.now();
    const agentId = `agent-lifecycle-${ts}`;

    const registered = await mcpCall(server, 'register_agent', {
      agentId,
      name: 'Lifecycle Test Agent',
      capabilities: ['analysis'],
      ttlSeconds: 60,
      metadata: { purpose: 'contract-test' },
    });

    expect(registered.status).toBe('registered');
    expect(registered.lifecycleStatus).toBe('active');
    expect(registered.ttlSeconds).toBe(60);
    expect(registered.expiresAt).toBeTruthy();

    const activeStatus = await mcpCall(server, 'get_agent_status', { agentId });
    expect(activeStatus.status).toBe('active');
    expect(activeStatus.storedStatus).toBe('active');
    expect(activeStatus.ttlSeconds).toBe(60);
    expect(activeStatus.expiresAt).toBe(registered.expiresAt);

    const unregistered = await mcpCall(server, 'unregister_agent', {
      agentId,
      reason: 'contract complete',
    });
    expect(unregistered.status).toBe('unregistered');
    expect(unregistered.previousStatus).toBe('active');

    const inactiveStatus = await mcpCall(server, 'get_agent_status', { agentId });
    expect(inactiveStatus.status).toBe('inactive');
    expect(inactiveStatus.storedStatus).toBe('inactive');
    expect(inactiveStatus.lifecycleStatus).toBe('inactive');
  });

  it('reports expired registrations and garbage-collects them only when dryRun is false', async () => {
    const ts = Date.now();
    const agentId = `agent-expiring-${ts}`;
    const expiresAt = new Date(Date.now() - 1000).toISOString();

    await mcpCall(server, 'register_agent', {
      agentId,
      name: 'Expiring Test Agent',
      capabilities: ['analysis'],
      expiresAt,
    });

    const expiredStatus = await mcpCall(server, 'get_agent_status', { agentId });
    expect(expiredStatus.status).toBe('expired');
    expect(expiredStatus.storedStatus).toBe('active');
    expect(expiredStatus.expiresAt).toBe(expiresAt);

    const dryRun = await mcpCall(server, 'gc_agent_registrations', {
      dryRun: true,
      deleteExpired: true,
      limit: 50,
    });
    expect(dryRun.status).toBe('dry_run');
    expect(dryRun.deleted).toBe(0);
    expect(dryRun.candidates.some((candidate: any) => candidate.agentId === agentId && candidate.reasons.includes('expired'))).toBe(true);

    const afterDryRun = await mcpCall(server, 'get_agent_status', { agentId });
    expect(afterDryRun.status).toBe('expired');

    const deleted = await mcpCall(server, 'gc_agent_registrations', {
      dryRun: false,
      deleteExpired: true,
      limit: 50,
    });
    expect(deleted.status).toBe('deleted');
    expect(deleted.deleted).toBeGreaterThanOrEqual(1);
    expect(deleted.candidates.some((candidate: any) => candidate.agentId === agentId)).toBe(true);

    const afterDelete = await mcpCall(server, 'get_agent_status', { agentId });
    expect(afterDelete.status).toBe('unknown');
  });
});
