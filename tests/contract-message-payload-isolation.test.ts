import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpRaw(
  server: NeuralMCPServer,
  toolName: string,
  args: Record<string, any> = {},
  context?: Record<string, any>,
): Promise<{ result: any; parsed: any }> {
  const result = context
    ? await (server as any)._handleToolCall(toolName, args, context)
    : await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  let parsed: any = text;
  if (typeof text === 'string') {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Error responses can be plain text.
    }
  }
  return { result, parsed };
}

async function mcpCall(
  server: NeuralMCPServer,
  toolName: string,
  args: Record<string, any> = {},
): Promise<any> {
  const response = await mcpRaw(server, toolName, args);
  if (response.result?.isError) {
    throw new Error(`Tool error: ${String(response.parsed)}`);
  }
  return response.parsed;
}

function sentId(result: any): string {
  return result.messageIds[0].messageId;
}

describe('Direct-message payload isolation', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('keeps oversized and historical message payloads out of generic entity/vector search', async () => {
    const suffix = Date.now();
    const sender = `payload-sender-${suffix}`;
    const recipient = `payload-recipient-${suffix}`;
    const attacker = `payload-attacker-${suffix}`;
    const oversizedSecret = `oversized-private-${suffix}-` + 'x'.repeat(3200);
    const historicalSecret = `historical-private-${suffix}`;
    const materializedSecret = `materialized-private-${suffix}`;
    const orphanSecret = `orphan-private-${suffix}`;
    const relationSecret = `relation-private-${suffix}`;
    const historicalEntityName = `msg-detail-historical-${suffix}`;
    const historicalEntityAlias = `private-detail-alias-${suffix}`;
    const orphanEntityName = `msg-detail-missing-${suffix}`;
    const normalEntityName = `public-project-${suffix}`;
    const manager = server.getMemoryManager();
    const db = manager.getDb();

    // Reproduce the pre-containment representation so compatibility and search
    // filtering are both exercised without creating new private entities.
    const historicalEntityId = await manager.store(sender, {
      name: historicalEntityName,
      aliases: [historicalEntityAlias],
      entityType: 'legacy-payload',
      type: 'message_detail',
      observations: [historicalSecret],
      createdBy: sender,
      timestamp: new Date().toISOString(),
    }, 'shared', 'entity');
    const materializedObservationId = await manager.store(sender, {
      entityName: historicalEntityAlias,
      contents: [materializedSecret],
      addedBy: sender,
      metadata: { source: 'legacy_materialized_observation' },
    }, 'shared', 'observation');
    const orphanObservationId = await manager.store(sender, {
      entityName: orphanEntityName,
      contents: [orphanSecret],
      addedBy: sender,
      metadata: { source: 'legacy_orphan_observation' },
    }, 'shared', 'observation');
    await manager.store(sender, {
      from: historicalEntityAlias,
      to: `public-relation-target-${suffix}`,
      relationType: 'legacy_private_link',
      properties: { note: relationSecret },
    }, 'shared', 'relation');
    const historicalMessageId = `historical-message-${suffix}`;
    db.prepare(`
      INSERT INTO ai_messages
        (id, from_agent, from_source, to_agent, content, message_type, priority, metadata, tenant_id, summary)
      VALUES (?, ?, 'direct', ?, ?, 'info', 'normal', '{}', 'default', ?)
    `).run(
      historicalMessageId,
      sender,
      recipient,
      `Full content stored as entity "${historicalEntityName}".`,
      'Historical pointer',
    );

    const storeMemory = vi.fn(async (memory: any) => memory.id);
    const searchMemories = vi.fn(async () => [
      {
        id: 'historical-ai-message-vector',
        agentId: sender,
        tenantId: 'default',
        type: 'ai_message',
        content: oversizedSecret,
        timestamp: Date.now(),
        tags: ['message'],
        priority: 5,
        relationships: [],
      },
      {
        id: 'historical-message-detail-vector',
        agentId: sender,
        tenantId: 'default',
        type: 'entity',
        content: JSON.stringify({
          name: historicalEntityName,
          entityType: 'legacy-payload',
          type: 'message_detail',
          observations: [historicalSecret],
        }),
        timestamp: Date.now(),
        tags: [],
        priority: 5,
        relationships: [],
      },
    ]);
    (manager as any).vectorClient = { storeMemory, searchMemories };
    (manager as any).isAdvancedSystemsEnabled = true;

    const sent = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: recipient,
      content: oversizedSecret,
    });
    const messageId = sentId(sent);

    const stored = db.prepare(
      'SELECT content FROM ai_messages WHERE id = ? AND tenant_id = ?'
    ).get(messageId, 'default') as { content: string };
    expect(stored.content).toBe(oversizedSecret);
    expect((db.prepare(`
      SELECT COUNT(*) AS count
      FROM shared_memory
      WHERE tenant_id = 'default'
        AND content LIKE ?
    `).get(`%${oversizedSecret.slice(0, 80)}%`) as any).count).toBe(0);
    expect(storeMemory.mock.calls.some(([memory]) =>
      memory.type === 'ai_message' ||
      memory.type === 'message_detail' ||
      memory.type === 'entity' && JSON.parse(memory.content).type === 'message_detail'
    )).toBe(false);

    const wrongDetail = await mcpRaw(server, 'get_message_detail', {
      agentId: attacker,
      messageId,
      markAsRead: false,
    });
    expect(wrongDetail.result.isError).toBe(true);

    const authorizedDetail = await mcpCall(server, 'get_message_detail', {
      agentId: recipient,
      messageId,
      markAsRead: false,
    });
    expect(authorizedDetail.content).toBe(oversizedSecret);

    const historicalDetail = await mcpCall(server, 'get_message_detail', {
      agentId: recipient,
      messageId: historicalMessageId,
      markAsRead: false,
    });
    expect(historicalDetail.content).toBe(historicalSecret);

    const secretSearch = await mcpCall(server, 'search_entities', {
      query: `private-${suffix}`,
      compact: false,
      limit: 20,
    });
    expect(JSON.stringify(secretSearch.results)).not.toContain(oversizedSecret);
    expect(JSON.stringify(secretSearch.results)).not.toContain(historicalSecret);
    expect(JSON.stringify(secretSearch.results)).not.toContain(materializedSecret);
    expect(JSON.stringify(secretSearch.results)).not.toContain(orphanSecret);
    expect(JSON.stringify(secretSearch.results)).not.toContain(relationSecret);

    const materializedSearch = await mcpCall(server, 'search_entities', {
      query: materializedSecret,
      compact: false,
      limit: 20,
    });
    expect(JSON.stringify(materializedSearch.results)).not.toContain(materializedSecret);
    const orphanSearch = await mcpCall(server, 'search_entities', {
      query: orphanSecret,
      compact: false,
      limit: 20,
    });
    expect(JSON.stringify(orphanSearch.results)).not.toContain(orphanSecret);
    const relationSearch = await mcpCall(server, 'search_entities', {
      query: relationSecret,
      compact: false,
      limit: 20,
    });
    expect(JSON.stringify(relationSearch.results)).not.toContain(relationSecret);

    const historicalNameSearch = await mcpCall(server, 'search_entities', {
      query: historicalEntityName,
      searchType: 'exact',
      compact: false,
      limit: 20,
    });
    expect(historicalNameSearch.results).toEqual([]);

    const detailByName = await mcpCall(server, 'get_entity_detail', {
      names: [historicalEntityName],
    });
    const detailById = await mcpCall(server, 'get_entity_detail', {
      ids: [historicalEntityId],
    });
    const childDetailById = await mcpCall(server, 'get_entity_detail', {
      ids: [materializedObservationId],
    });
    const orphanDetailById = await mcpCall(server, 'get_entity_detail', {
      ids: [orphanObservationId],
    });
    expect(JSON.stringify(detailByName)).not.toContain(historicalSecret);
    expect(JSON.stringify(detailById)).not.toContain(historicalSecret);
    expect(detailByName.retrieved).toBe(0);
    expect(detailByName.entities).toEqual([]);
    expect(detailById.retrieved).toBe(0);
    expect(detailById.entities).toEqual([]);
    expect(childDetailById.retrieved).toBe(0);
    expect(childDetailById.entities).toEqual([]);
    expect(JSON.stringify(childDetailById)).not.toContain(materializedSecret);
    expect(orphanDetailById.retrieved).toBe(0);
    expect(orphanDetailById.entities).toEqual([]);
    expect(JSON.stringify(orphanDetailById)).not.toContain(orphanSecret);

    expect(manager.isConfidentialEntityReference(historicalEntityAlias, 'default')).toBe(true);
    (manager as any).confidentialEntityReferenceCache.clear();
    const prepareSpy = vi.spyOn(db as any, 'prepare');
    expect(manager.isConfidentialEntityReference(historicalEntityAlias, 'default')).toBe(true);
    const prepareCallsAfterCacheFill = prepareSpy.mock.calls.length;
    expect(prepareCallsAfterCacheFill).toBeGreaterThan(0);
    for (let i = 0; i < 999; i += 1) {
      expect(manager.isConfidentialEntityReference(historicalEntityAlias, 'default')).toBe(true);
    }
    expect(prepareSpy.mock.calls).toHaveLength(prepareCallsAfterCacheFill);
    prepareSpy.mockRestore();

    const graph = await mcpCall(server, 'read_graph', { includeObservations: true });
    expect(JSON.stringify(graph)).not.toContain(historicalSecret);
    expect(JSON.stringify(graph)).not.toContain(materializedSecret);
    expect(JSON.stringify(graph)).not.toContain(orphanSecret);
    expect(JSON.stringify(graph)).not.toContain(relationSecret);
    expect(graph.graph.entities.some((entry: any) => entry.id === historicalEntityId)).toBe(false);

    const current = await mcpCall(server, 'get_current_observation', {
      entity: historicalEntityAlias,
    });
    expect(current.current).toBeNull();
    expect(JSON.stringify(current)).not.toContain(materializedSecret);

    const neighborhood = await mcpCall(server, 'get_entity_neighborhood', {
      entity: historicalEntityName,
      includeObservations: true,
    });
    expect(neighborhood.found).toBe(false);
    expect(JSON.stringify(neighborhood)).not.toContain(materializedSecret);

    const fullExport = manager.getGraphExport({
      tenantId: 'default',
      limit: 200,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });
    const entityExport = manager.getGraphExport({
      tenantId: 'default',
      limit: 200,
      includeObservations: true,
      entityName: historicalEntityAlias,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });
    expect(JSON.stringify(fullExport)).not.toContain(materializedSecret);
    expect(JSON.stringify(entityExport)).not.toContain(materializedSecret);
    expect(JSON.stringify(fullExport)).not.toContain(historicalEntityAlias);

    const backlinks = await mcpCall(server, 'get_entity_backlinks', {
      entity: historicalEntityAlias,
      includeOutgoing: true,
    });
    expect(JSON.stringify(backlinks)).not.toContain(relationSecret);
    expect(backlinks.outgoing).toEqual([]);

    const rejectedAliasObservation = await mcpRaw(server, 'add_observations', {
      observations: [{ entityName: historicalEntityAlias, contents: [materializedSecret] }],
    });
    expect(rejectedAliasObservation.result.isError).toBe(true);
    const rejectedOrphanObservation = await mcpRaw(server, 'add_observations', {
      observations: [{ entityName: orphanEntityName, contents: [orphanSecret] }],
    });
    expect(rejectedOrphanObservation.result.isError).toBe(true);
    const rejectedPrivateRelation = await mcpRaw(server, 'create_relations', {
      relations: [{
        from: historicalEntityAlias,
        to: `public-relation-target-${suffix}`,
        relationType: 'must_not_cross_private_boundary',
      }],
    });
    expect(rejectedPrivateRelation.result.isError).toBe(true);
    const rejectedReservedEntity = await mcpRaw(server, 'create_entities', {
      entities: [{
        name: `forbidden-message-detail-${suffix}`,
        entityType: 'message_detail',
        observations: [materializedSecret],
      }],
    });
    expect(rejectedReservedEntity.result.isError).toBe(true);
    const rejectedReservedName = await mcpRaw(server, 'create_entities', {
      entities: [{
        name: `msg-detail-reserved-${suffix}`,
        entityType: 'project',
        observations: ['must not use the private namespace'],
      }],
    });
    expect(rejectedReservedName.result.isError).toBe(true);

    const resumed = await mcpCall(server, 'resume', {
      agentId: attacker,
      scope: { project: historicalEntityName },
      budget: 4000,
    });
    expect(resumed.resolvedScope.scopeKey).toBeNull();
    expect(JSON.stringify(resumed)).not.toContain(historicalSecret);

    const begun = await mcpCall(server, 'begin_session', {
      agentId: attacker,
      scope: { project: historicalEntityName },
      budget: 4000,
    });
    expect(begun.resolvedScope.scopeKey).toBeNull();
    expect(JSON.stringify(begun)).not.toContain(historicalSecret);

    // Retired public handlers no longer call this legacy builder, but keep its
    // internal read path confidential so a future compatibility adapter cannot
    // accidentally re-expose historical payload entities.
    const legacyContext = manager.getAgentContext(
      attacker,
      historicalEntityName,
      'cold',
      'default',
      100_000,
    );
    expect(JSON.stringify(legacyContext)).not.toContain(historicalSecret);
    expect(JSON.stringify(legacyContext)).not.toContain(materializedSecret);
    const legacyAliasContext = manager.getAgentContext(
      attacker,
      historicalEntityAlias,
      'cold',
      'default',
      100_000,
    );
    expect(JSON.stringify(legacyAliasContext)).not.toContain(materializedSecret);

    await mcpCall(server, 'create_entities', {
      entities: [{
        name: normalEntityName,
        entityType: 'project',
        observations: [`public observation ${suffix}`],
      }],
    });
    const normalSearch = await mcpCall(server, 'search_entities', {
      query: normalEntityName,
      searchType: 'exact',
      compact: false,
      limit: 20,
    });
    expect(normalSearch.results.some((result: any) => result.content?.name === normalEntityName)).toBe(true);
  });

  it('classifies oversized private graph rows before constructing lossy previews', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const db = manager.getDb();
    (manager as any).isAdvancedSystemsEnabled = false;
    (manager as any).vectorClient = undefined;
    const privateName = `private-large-parent-${suffix}`;
    const privateAlias = `private-large-alias-${suffix}`;
    const observationSecret = `large-private-observation-${suffix}`;
    const relationSecret = `large-private-relation-${suffix}`;

    const privateEntityId = await manager.store('legacy-sender', {
      name: privateName,
      aliases: [privateAlias],
      type: 'message_detail',
      observations: ['historical private body'],
    }, 'shared', 'entity', 'default');
    const privateObservationId = await manager.store('legacy-sender', {
      entityName: privateAlias,
      contents: [`${observationSecret}-${'o'.repeat(manager.contentSizeThreshold + 64)}`],
      metadata: { entityId: privateEntityId },
    }, 'shared', 'observation', 'default');
    const privateRelationId = await manager.store('legacy-sender', {
      from: privateAlias,
      to: `public-large-target-${suffix}`,
      relationType: 'legacy_private_link',
      properties: { note: `${relationSecret}-${'r'.repeat(manager.contentSizeThreshold + 64)}` },
    }, 'shared', 'relation', 'default');

    const publicName = `public-large-parent-${suffix}`;
    await manager.store('public-agent', {
      name: publicName,
      entityType: 'project',
      observations: [],
    }, 'shared', 'entity', 'default');
    const publicMarker = `large-public-control-${suffix}`;
    const publicObservationId = await manager.store('public-agent', {
      entityName: publicName,
      contents: [`${publicMarker}-${'p'.repeat(manager.contentSizeThreshold + 64)}`],
    }, 'shared', 'observation', 'default');

    for (const id of [privateObservationId, privateRelationId, publicObservationId]) {
      const row = db.prepare(
        'SELECT LENGTH(content) AS bytes FROM shared_memory WHERE id = ?'
      ).get(id) as { bytes: number };
      expect(row.bytes).toBeGreaterThan(manager.contentSizeThreshold);
    }

    const observationResults = await manager.search(
      observationSecret,
      { shared: true, individual: false },
      'default',
      { limit: 20 },
    );
    const relationResults = await manager.search(
      relationSecret,
      { shared: true, individual: false },
      'default',
      { limit: 20 },
    );
    expect(observationResults.map((result) => result.id)).not.toContain(privateObservationId);
    expect(relationResults.map((result) => result.id)).not.toContain(privateRelationId);
    expect(JSON.stringify(observationResults)).not.toContain(observationSecret);
    expect(JSON.stringify(relationResults)).not.toContain(relationSecret);

    const observationToolResults = await mcpCall(server, 'search_entities', {
      query: observationSecret,
      compact: false,
      limit: 20,
    });
    const relationToolResults = await mcpCall(server, 'search_entities', {
      query: relationSecret,
      compact: false,
      limit: 20,
    });
    expect(observationToolResults.results.map((result: any) => result.id))
      .not.toContain(privateObservationId);
    expect(relationToolResults.results.map((result: any) => result.id))
      .not.toContain(privateRelationId);
    expect(JSON.stringify(observationToolResults.results)).not.toContain(observationSecret);
    expect(JSON.stringify(relationToolResults.results)).not.toContain(relationSecret);

    // Preserve the legitimate large-row contract: a public row remains
    // searchable as a bounded, chunked preview.
    const publicResults = await manager.search(
      publicMarker,
      { shared: true, individual: false },
      'default',
      { limit: 20 },
    );
    const publicResult = publicResults.find((result) => result.id === publicObservationId);
    expect(publicResult).toMatchObject({ chunked: true });
  });

  it('treats reserved canonical names and aliases as private despite corrupt domain types', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const reservedName = `msg-detail-corrupt-project-${suffix}`;
    const aliasCanonicalName = `corrupt-private-alias-parent-${suffix}`;
    const reservedAlias = `msg-detail-corrupt-alias-${suffix}`;
    const canonicalSecret = `reserved-canonical-secret-${suffix}`;
    const aliasSecret = `reserved-alias-secret-${suffix}`;

    const canonicalId = await manager.store('legacy-sender', {
      name: reservedName,
      entityType: 'project',
      observations: [canonicalSecret],
    }, 'shared', 'entity', 'default');
    const aliasId = await manager.store('legacy-sender', {
      name: aliasCanonicalName,
      aliases: [reservedAlias],
      entityType: 'analysis',
      observations: [aliasSecret],
    }, 'shared', 'entity', 'default');
    await manager.store('legacy-sender', {
      entityName: aliasCanonicalName,
      contents: [aliasSecret],
      metadata: { entityId: aliasId },
    }, 'shared', 'observation', 'default');
    const collisionName = `public-private-child-collision-${suffix}`;
    const collisionId = await manager.store('public-agent', {
      name: collisionName,
      entityType: 'project',
      observations: [],
    }, 'shared', 'entity', 'default');
    await manager.store('legacy-sender', {
      entityName: collisionName,
      contents: [aliasSecret],
      metadata: { entityId: aliasId },
    }, 'shared', 'observation', 'default');

    expect(manager.isConfidentialEntityReference(reservedName, 'default')).toBe(true);
    expect(manager.isConfidentialEntityReference(aliasCanonicalName, 'default')).toBe(true);
    expect(manager.isConfidentialEntityReference(reservedAlias, 'default')).toBe(true);

    for (const query of [reservedName, aliasCanonicalName, reservedAlias, canonicalSecret, aliasSecret]) {
      const searched = await mcpCall(server, 'search_entities', {
        query,
        compact: false,
        limit: 20,
      });
      expect(JSON.stringify(searched.results)).not.toContain(canonicalSecret);
      expect(JSON.stringify(searched.results)).not.toContain(aliasSecret);
      expect(searched.results.map((result: any) => result.id)).not.toContain(canonicalId);
      expect(searched.results.map((result: any) => result.id)).not.toContain(aliasId);
    }

    const detail = await mcpCall(server, 'get_entity_detail', { ids: [canonicalId, aliasId] });
    expect(detail.retrieved).toBe(0);
    expect(detail.entities).toEqual([]);

    const graph = await mcpCall(server, 'read_graph', { includeObservations: true, limit: 500 });
    expect(JSON.stringify(graph)).not.toContain(canonicalSecret);
    expect(JSON.stringify(graph)).not.toContain(aliasSecret);
    expect(graph.graph.entities.map((entry: any) => entry.id)).not.toContain(canonicalId);
    expect(graph.graph.entities.map((entry: any) => entry.id)).not.toContain(aliasId);
    expect(graph.statistics.nodeCount).toBe(graph.graph.entities.length);
    expect(graph.statistics.edgeCount).toBe(graph.graph.relations.length);
    expect(graph.statistics.observationCount).toBe(graph.graph.observations.length);
    expect(graph.pagination.nextOffset).toEqual({
      entities: null,
      relations: null,
      observations: null,
    });

    const exportResult = manager.getGraphExport({
      tenantId: 'default',
      limit: 500,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });
    expect(JSON.stringify(exportResult)).not.toContain(canonicalSecret);
    expect(JSON.stringify(exportResult)).not.toContain(aliasSecret);
    expect(exportResult.nodes?.map((node: any) => node.id)).not.toContain(canonicalId);
    expect(exportResult.nodes?.map((node: any) => node.id)).not.toContain(aliasId);
    expect(exportResult.nodes?.find((node: any) => node.id === collisionId)?.observationCount).toBe(0);

    const collisionCurrent = await mcpCall(server, 'get_current_observation', {
      entity: collisionName,
    });
    expect(collisionCurrent.current).toBeNull();
    expect(JSON.stringify(collisionCurrent)).not.toContain(aliasSecret);

    const legacyCorruptContext = manager.getAgentContext(
      'legacy-reader', aliasCanonicalName, 'cold', 'default', 100_000,
    );
    expect(JSON.stringify(legacyCorruptContext)).not.toContain(aliasSecret);

    const portableExport = manager.exportEntities({
      tenantId: 'default',
      entityNames: [reservedName, aliasCanonicalName],
    });
    expect(portableExport.counts).toEqual({ entities: 0, observations: 0, relations: 0 });
  });

  it('fails closed when malformed graph payloads cannot be proven public', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const db = manager.getDb();
    const secretPrefix = `malformed-private-${suffix}`;
    const publicName = `malformed-public-control-${suffix}`;
    const malformedRows = [
      {
        id: `malformed-entity-${suffix}`,
        memoryType: 'entity',
        content: `{"name":"msg-detail-malformed-${suffix}","observations":["${secretPrefix}-entity`,
      },
      {
        id: `malformed-observation-${suffix}`,
        memoryType: 'observation',
        content: `{"entityName":"msg-detail-malformed-${suffix}","contents":["${secretPrefix}-observation`,
      },
      {
        id: `malformed-relation-${suffix}`,
        memoryType: 'relation',
        content: `{"from":"msg-detail-malformed-${suffix}","properties":{"note":"${secretPrefix}-relation`,
      },
      {
        id: `non-object-observation-${suffix}`,
        memoryType: 'observation',
        content: JSON.stringify(`${secretPrefix}-non-object`),
      },
      {
        id: `valid-child-of-malformed-entity-${suffix}`,
        memoryType: 'observation',
        content: JSON.stringify({
          entityName: publicName,
          contents: [`${secretPrefix}-valid-child`],
          metadata: { entityId: `malformed-entity-${suffix}` },
        }),
      },
    ];
    const insert = db.prepare(`
      INSERT INTO shared_memory
        (id, tenant_id, memory_type, content, created_by, tags)
      VALUES (?, 'default', ?, ?, 'legacy-corrupt-writer', '[]')
    `);
    for (const row of malformedRows) {
      insert.run(row.id, row.memoryType, row.content);
    }
    (manager as any).confidentialEntityReferenceCache.delete('default');
    for (const row of malformedRows) {
      expect(manager.isConfidentialGraphRow(row.memoryType, row.content, 'default')).toBe(true);
    }

    const publicEntityId = await manager.store('public-agent', {
      name: publicName,
      entityType: 'project',
      observations: [],
    }, 'shared', 'entity', 'default');
    await manager.store('public-agent', {
      entityName: publicName,
      contents: [`public-control-${suffix}`],
    }, 'shared', 'observation', 'default');

    const rawSearch = await manager.search(
      secretPrefix,
      { shared: true, individual: false },
      'default',
      { limit: 20 },
    );
    for (const row of malformedRows) {
      expect(rawSearch.map((entry) => entry.id)).not.toContain(row.id);
    }
    expect(JSON.stringify(rawSearch)).not.toContain(secretPrefix);

    const toolSearch = await mcpCall(server, 'search_entities', {
      query: secretPrefix,
      compact: false,
      limit: 20,
    });
    expect(JSON.stringify(toolSearch.results)).not.toContain(secretPrefix);

    const detail = await mcpCall(server, 'get_entity_detail', {
      ids: malformedRows.map((row) => row.id),
    });
    expect(detail.retrieved).toBe(0);
    expect(detail.entities).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(secretPrefix);

    const graph = await mcpCall(server, 'read_graph', {
      includeObservations: true,
      limit: 500,
    });
    expect(JSON.stringify(graph)).not.toContain(secretPrefix);
    for (const row of malformedRows) {
      expect(JSON.stringify(graph)).not.toContain(row.id);
    }

    const graphExport = manager.getGraphExport({
      tenantId: 'default',
      limit: 500,
      includeObservations: true,
      permissions: new Set(['graph:view', 'graph:observations:view']),
    });
    expect(JSON.stringify(graphExport)).not.toContain(secretPrefix);
    for (const row of malformedRows) {
      expect(JSON.stringify(graphExport)).not.toContain(row.id);
    }
    expect(graphExport.nodes?.map((entry: any) => entry.id)).toContain(publicEntityId);

    const publicSearch = await mcpCall(server, 'search_entities', {
      query: publicName,
      searchType: 'exact',
      compact: false,
      limit: 20,
    });
    expect(publicSearch.results.map((entry: any) => entry.id)).toContain(publicEntityId);

    const publicNeighborhood = await mcpCall(server, 'get_entity_neighborhood', {
      entity: publicName,
      includeObservations: true,
    });
    expect(publicNeighborhood.found).toBe(true);
    expect(publicNeighborhood.center?.id).toBe(publicEntityId);
    expect(publicNeighborhood.center?.observationCount).toBe(1);
    expect(publicNeighborhood.observations).toHaveLength(1);
    expect(JSON.stringify(publicNeighborhood)).not.toContain(secretPrefix);

    const publicBacklinks = await mcpCall(server, 'get_entity_backlinks', {
      entity: publicName,
      includeOutgoing: true,
    });
    expect(publicBacklinks.found).toBe(true);
    expect(JSON.stringify(publicBacklinks)).not.toContain(secretPrefix);

    const portableExport = manager.exportEntities({
      tenantId: 'default',
      entityNames: [publicName],
    });
    expect(portableExport.entities.map((entry: any) => entry.id)).toContain(publicEntityId);
    expect(JSON.stringify(portableExport)).not.toContain(secretPrefix);
  });

  it('rejects generic mutations of private parents and children with zero side effects', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const db = manager.getDb();
    const privateName = `mutation-private-parent-${suffix}`;
    const privateAlias = `mutation-private-alias-${suffix}`;
    const privateSecret = `mutation-private-secret-${suffix}`;
    const privateId = await manager.store('legacy-sender', {
      name: privateName,
      aliases: [privateAlias],
      type: 'message_detail',
      observations: [privateSecret],
    }, 'shared', 'entity', 'default');
    const privateObservationId = await manager.store('legacy-sender', {
      entityName: privateAlias,
      contents: [privateSecret],
      metadata: { entityId: privateId },
    }, 'shared', 'observation', 'default');
    const before = db.prepare(
      'SELECT id, content FROM shared_memory WHERE id IN (?, ?) ORDER BY id'
    ).all(privateId, privateObservationId);

    const devContext = {
      tenantId: 'default',
      userId: 'privacy-regression-operator',
      authType: 'dev',
      apiKeyId: null,
      idpSub: null,
      roles: [],
      scopes: [],
      mfaLevel: null,
      timezoneHint: null,
    };
    const attempts = [
      await mcpRaw(server, 'delete_entity', {
        agentId: 'privacy-regression-operator',
        entityName: privateName,
      }, devContext),
      await mcpRaw(server, 'remove_observations', {
        agentId: 'privacy-regression-operator',
        entityName: privateAlias,
        observationIds: [privateObservationId],
      }, devContext),
      await mcpRaw(server, 'delete_observations_by_entity', {
        agentId: 'privacy-regression-operator',
        entityName: privateAlias,
      }, devContext),
      await mcpRaw(server, 'update_observation', {
        agentId: 'privacy-regression-operator',
        observationId: privateObservationId,
        newContent: 'generic mutation must not replace private content',
      }, devContext),
    ];
    for (const attempt of attempts) {
      expect(attempt.result.isError).toBe(true);
      expect(JSON.stringify(attempt.parsed)).toContain('private mailbox data');
    }
    await expect(manager.deleteGraphRows([privateObservationId], 'default'))
      .rejects.toThrow('private mailbox data');

    const after = db.prepare(
      'SELECT id, content FROM shared_memory WHERE id IN (?, ?) ORDER BY id'
    ).all(privateId, privateObservationId);
    expect(after).toEqual(before);

    // A public observation still follows the existing generic update path.
    const publicName = `mutation-public-parent-${suffix}`;
    await manager.store('public-agent', {
      name: publicName,
      entityType: 'project',
      observations: [],
    }, 'shared', 'entity', 'default');
    const publicObservationId = await manager.store('public-agent', {
      entityName: publicName,
      contents: ['public before'],
    }, 'shared', 'observation', 'default');
    const publicUpdate = await mcpRaw(server, 'update_observation', {
      agentId: 'privacy-regression-operator',
      observationId: publicObservationId,
      newContent: 'public after',
    }, devContext);
    expect(publicUpdate.result.isError).not.toBe(true);
    expect((db.prepare('SELECT content FROM shared_memory WHERE id = ?')
      .get(publicObservationId) as { content: string }).content).toContain('public after');
  });
});
