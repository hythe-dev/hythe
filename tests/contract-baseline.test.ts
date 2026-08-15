/**
 * P0: Baseline Contract Tests
 *
 * Exercises all 15 "keep" tools against the live neural server.
 * These tests form the regression gate for every subsequent SPECTRA phase.
 *
 * Requires: live server at http://localhost:6174 with API_KEY set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

// Timing log for baselines
const timings: Record<string, number> = {};

async function mcpCall(toolName: string, args: Record<string, any> = {}): Promise<any> {
  const start = Date.now();
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

  const elapsed = Date.now() - start;
  timings[toolName] = elapsed;

  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);

  const text = json.result?.content?.[0]?.text;
  if (!text) return json.result;

  // Check for tool-level errors
  if (json.result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function httpPost(path: string, body: any): Promise<any> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  timings[`HTTP:${path}`] = elapsed;
  return res.json();
}

async function httpGet(path: string): Promise<any> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  const elapsed = Date.now() - start;
  timings[`HTTP:${path}`] = elapsed;
  return res.json();
}

// Test entity name prefix to identify and avoid polluting real data
const TEST_PREFIX = '_contract_test_';
const testEntityName = `${TEST_PREFIX}entity_${Date.now()}`;
const testAgentId = `${TEST_PREFIX}agent_${Date.now()}`;

describe('Neural Contract Baseline', () => {
  beforeAll(async () => {
    // Verify server is reachable
    const health = await httpGet('/health');
    expect(health.status).toBe('healthy');
  });

  afterAll(() => {
    console.log('\n--- Response Time Baselines ---');
    for (const [tool, ms] of Object.entries(timings).sort((a, b) => a[1] - b[1])) {
      console.log(`  ${tool}: ${ms}ms`);
    }
  });

  // === KNOWLEDGE GRAPH TOOLS ===

  describe('create_entities + search_entities', () => {
    it('creates an entity and finds it via search', async () => {
      // Create
      const created = await mcpCall('create_entities', {
        entities: [
          {
            name: testEntityName,
            entityType: 'test',
            observations: ['contract test observation'],
          },
        ],
      });

      expect(created.created).toBe(1);
      expect(created.entities).toHaveLength(1);
      expect(created.entities[0].name).toBe(testEntityName);

      // Search
      const searched = await mcpCall('search_entities', {
        query: testEntityName,
        searchType: 'exact',
        limit: 10,
      });

      expect(searched.totalResults).toBeGreaterThanOrEqual(1);

      // At least one result should contain our entity name
      const found = searched.results.some((r: any) => {
        const content = r.content;
        if (typeof content === 'string') return content.includes(testEntityName);
        return JSON.stringify(content).includes(testEntityName);
      });
      expect(found).toBe(true);
    });
  });

  describe('add_observations', () => {
    it('appends observations to an existing entity', async () => {
      const result = await mcpCall('add_observations', {
        observations: [
          {
            entityName: testEntityName,
            contents: ['added observation 1', 'added observation 2'],
          },
        ],
      });

      expect(result.added).toBe(1);
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0].contents).toEqual([
        'added observation 1',
        'added observation 2',
      ]);
    });
  });

  describe('create_relations', () => {
    const relatedEntityName = `${TEST_PREFIX}related_${Date.now()}`;

    it('creates a relation between two entities', async () => {
      // Create a second entity to relate to
      await mcpCall('create_entities', {
        entities: [
          {
            name: relatedEntityName,
            entityType: 'test',
            observations: ['related entity for contract test'],
          },
        ],
      });

      const result = await mcpCall('create_relations', {
        relations: [
          {
            from: testEntityName,
            to: relatedEntityName,
            relationType: 'test_relation',
          },
        ],
      });

      expect(result.created).toBe(1);
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe(testEntityName);
      expect(result.relations[0].to).toBe(relatedEntityName);
      expect(result.relations[0].relationType).toBe('test_relation');
    });
  });

  describe('read_graph', () => {
    it('returns a bounded graph page and excludes observations by default', async () => {
      const result = await mcpCall('read_graph', {
        analysisLevel: 'basic',
      });

      expect(result.graph).toBeDefined();
      expect(result.graph.entities).toBeDefined();
      expect(result.graph.relations).toBeDefined();
      expect(result.graph.observations).toBeDefined();
      expect(result.statistics).toBeDefined();
      expect(result.statistics.nodeCount).toBeGreaterThanOrEqual(0);
      expect(result.statistics.edgeCount).toBeGreaterThanOrEqual(0);
      expect(result.graph.entities.length).toBeLessThanOrEqual(100);
      expect(result.graph.relations.length).toBeLessThanOrEqual(100);
      expect(result.graph.observations).toHaveLength(0);
      expect(result.pagination.limit).toBe(100);
      expect(result.pagination.includeObservations).toBe(false);
    });

    it('can include a bounded observations page when requested', async () => {
      const result = await mcpCall('read_graph', {
        limit: 5,
        includeObservations: true,
      });

      expect(result.graph.entities.length).toBeLessThanOrEqual(5);
      expect(result.graph.relations.length).toBeLessThanOrEqual(5);
      expect(result.graph.observations.length).toBeLessThanOrEqual(5);
      expect(result.pagination.limit).toBe(5);
      expect(result.pagination.includeObservations).toBe(true);
    });
  });

  describe('get_entity_neighborhood', () => {
    it('returns a bounded local graph around an entity', async () => {
      const centerName = `${TEST_PREFIX}nbhd_center_${Date.now()}`;
      const neighborName = `${TEST_PREFIX}nbhd_neighbor_${Date.now()}`;
      await mcpCall('create_entities', {
        entities: [
          { name: centerName, entityType: 'test', observations: ['neighborhood center'] },
          { name: neighborName, entityType: 'test', observations: ['neighborhood neighbor'] },
        ],
      });
      await mcpCall('create_relations', {
        relations: [{ from: centerName, to: neighborName, relationType: 'nbhd_rel' }],
      });

      const result = await mcpCall('get_entity_neighborhood', {
        entity: centerName,
        depth: 1,
        limit: 50,
      });

      expect(result.found).toBe(true);
      expect(result.center?.name).toBe(centerName);
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
      expect(result.nodes.some((n: any) => n.name === neighborName)).toBe(true);
      expect(result.edges.some((e: any) =>
        e.source === centerName && e.target === neighborName && e.relationType === 'nbhd_rel'
      )).toBe(true);
      expect(result.statistics.edgeCount).toBeGreaterThanOrEqual(1);
      expect(result.truncated).toBeDefined();
    });

    it('returns found:false for a missing entity', async () => {
      const result = await mcpCall('get_entity_neighborhood', {
        entity: `${TEST_PREFIX}missing_${Date.now()}`,
      });
      expect(result.found).toBe(false);
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });

  describe('get_entity_backlinks', () => {
    it('returns bounded incoming links for an entity', async () => {
      const sourceName = `${TEST_PREFIX}backlink_source_${Date.now()}`;
      const targetName = `${TEST_PREFIX}backlink_target_${Date.now()}`;
      await mcpCall('create_entities', {
        entities: [
          { name: sourceName, entityType: 'test', observations: ['backlink source'] },
          { name: targetName, entityType: 'test', observations: ['backlink target'] },
        ],
      });
      await mcpCall('create_relations', {
        relations: [{ from: sourceName, to: targetName, relationType: 'links_to' }],
      });

      const result = await mcpCall('get_entity_backlinks', {
        entity: targetName,
        limit: 10,
        includeOutgoing: true,
      });

      expect(result.found).toBe(true);
      expect(result.entity).toBe(targetName);
      expect(Array.isArray(result.backlinks)).toBe(true);
      expect(result.backlinks.some((link: any) =>
        link.from === sourceName && link.to === targetName && link.relationType === 'links_to'
      )).toBe(true);
      expect(result.backlinks.length).toBeLessThanOrEqual(10);
      expect(result.truncated).toBeDefined();
    });
  });

  // === AI MESSAGING TOOLS ===

  describe('send_ai_message + get_ai_messages', () => {
    const messageContent = `contract test message ${Date.now()}`;

    it('sends a message and retrieves it', async () => {
      // Send
      const sent = await mcpCall('send_ai_message', {
        from: testAgentId,
        to: testAgentId,
        content: messageContent,
        messageType: 'info',
        priority: 'low',
      });

      expect(sent.status).toBe('sent');
      expect(sent.sentCount).toBeGreaterThanOrEqual(1);

      // Retrieve
      const messages = await mcpCall('get_ai_messages', {
        agentId: testAgentId,
      });

      expect(messages.agentId).toBe(testAgentId);
      expect(messages.totalMessages).toBeGreaterThanOrEqual(1);

      // Find our message
      const found = messages.messages.some((m: any) => {
        const content = m.content;
        return (
          JSON.stringify(content).includes(messageContent) ||
          content?.content?.includes(messageContent)
        );
      });
      expect(found).toBe(true);
    });
  });

  // === AGENT MANAGEMENT TOOLS ===

  describe('register_agent + get_agent_status', () => {
    it('registers an agent and retrieves its status', async () => {
      // Register
      const registered = await mcpCall('register_agent', {
        agentId: testAgentId,
        name: 'Contract Test Agent',
        capabilities: ['testing'],
      });

      expect(registered.agentId || registered.registrationId).toBeTruthy();
      expect(registered.status).toBe('registered');

      // Get status
      const status = await mcpCall('get_agent_status', {
        agentId: testAgentId,
      });

      expect(status.agentId).toBe(testAgentId);
      expect(status.status).toBeDefined();
    });
  });

  // === INDIVIDUAL MEMORY TOOLS ===

  describe('record_learning + get_individual_memory', () => {
    it('records a learning and retrieves individual memory', async () => {
      const result = await mcpCall('record_learning', {
        agentId: testAgentId,
        context: 'contract test context',
        lesson: 'contract test lesson',
        confidence: 0.9,
      });

      expect(result.recorded || result.status).toBeTruthy();

      // Retrieve
      const memory = await mcpCall('get_individual_memory', {
        agentId: testAgentId,
      });

      expect(memory).toBeDefined();
      // Memory should contain our agent's data
      const memoryStr = JSON.stringify(memory);
      expect(memoryStr.includes(testAgentId) || memory.agentId === testAgentId).toBe(true);
    });
  });

  describe('set_preferences', () => {
    it('sets agent preferences', async () => {
      const result = await mcpCall('set_preferences', {
        agentId: testAgentId,
        preferences: {
          theme: 'dark',
          verbosity: 'high',
        },
      });

      expect(result).toBeDefined();
      // Preferences should be acknowledged
      const resultStr = JSON.stringify(result);
      expect(
        resultStr.includes('updated') ||
        resultStr.includes('set') ||
        resultStr.includes('preferences') ||
        result.status
      ).toBeTruthy();
    });
  });

  // === UTILITY TOOLS ===

  describe('translate_path', () => {
    it('translates a Unix path to Windows format', async () => {
      const result = await mcpCall('translate_path', {
        path: '/home/user/projects/test',
        fromPlatform: 'linux',
        toPlatform: 'windows',
      });

      expect(result).toBeDefined();
      expect(result.translatedPath).toBeDefined();
      expect(result.originalPath).toBe('/home/user/projects/test');
      expect(result.toPlatform).toBe('windows');
    });
  });

  describe('search_nodes (legacy alias)', () => {
    it('returns results like search_entities with graph type', async () => {
      const result = await mcpCall('search_nodes', { query: 'test' });
      expect(result).toBeDefined();
      expect(result.results).toBeDefined();
    });
  });

  // === HTTP ENDPOINTS ===

  describe('HTTP /health', () => {
    it('returns healthy status', async () => {
      const result = await httpGet('/health');
      expect(result.status).toBe('healthy');
      // Port is environment-dependent (the hermetic test server uses an alt
      // port); assert it matches whatever BASE_URL points at.
      const expectedPort = Number(new URL(BASE_URL).port) || 6174;
      expect(result.port).toBe(expectedPort);
    });
  });

  describe('HTTP /ready', () => {
    it('returns readiness status', async () => {
      const result = await httpGet('/ready');
      expect(result.ready).toBe(true);
      expect(result.systems).toBeDefined();
      expect(result.systems.sqlite).toBe(true);
    });
  });

  describe('HTTP /ai-message POST + /ai-messages/:agentId GET', () => {
    const httpTestAgent = `${TEST_PREFIX}http_${Date.now()}`;
    const httpTestMsg = `http contract test ${Date.now()}`;

    it('sends via HTTP and retrieves messages', async () => {
      // Send via HTTP endpoint
      const sent = await httpPost('/ai-message', {
        from: httpTestAgent,
        to: httpTestAgent,
        message: httpTestMsg,
        type: 'info',
      });

      expect(sent.status).toBe('queued');
      expect(sent.messageId).toBeTruthy();

      // Retrieve via HTTP endpoint
      const messages = await httpGet(`/ai-messages/${httpTestAgent}`);
      expect(messages.messages).toBeDefined();
      expect(messages.messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  // === TOOL REGISTRY ===

  describe('tools/list', () => {
    it('returns the full tool registry', async () => {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      const json = await res.json();
      const tools = json.result?.tools || [];

      // Step-3 tool diet plus bounded related-context discovery: the
      // agent-facing surface is EXACTLY 20 — 17 retained legacy tools,
      // one read-only discovery tool, and the two ENG-4 primitives. Retired
      // tools stay callable until cutover but never appear in discovery.
      expect(tools.length).toBe(20);

      const keepTools = [
        'create_entities',
        'add_observations',
        'get_current_observation',
        'create_relations',
        'search_entities',
        'get_entity_detail',
        'get_entity_neighborhood',
        'send_ai_message',
        'get_ai_messages',
        'get_message_detail',
        'archive_messages',
        'register_agent',
        'unregister_agent',
        'get_agent_status',
        'set_agent_identity',
        'begin_session',
        'end_session',
        'discover_related_context',
        'resume',
        'checkpoint',
      ];
      const retiredFromDiscovery = [
        'get_agent_context', 'search_nodes', 'read_graph', 'get_entity_backlinks',
        'compact_memory', 'gc_agent_registrations', 'delete_entity',
        'remove_observations', 'update_observation', 'delete_observations_by_entity',
        'get_user_profile', 'update_user_profile', 'set_preferences',
        'mark_messages_read', 'record_learning', 'get_individual_memory',
      ];

      const toolNames = tools.map((t: any) => t.name);
      for (const tool of retiredFromDiscovery) {
        expect(toolNames).not.toContain(tool);
      }
      for (const tool of keepTools) {
        expect(toolNames).toContain(tool);
      }
    });
  });
});
