/**
 * ENG-1: Current-observation read + replace-current write contract tests.
 *
 * Verifies get_current_observation (single authoritative observation resolved
 * server-side via the entity lookup index) and add_observations
 * mode:"replace-current" / supersedesLatest:true (server-side supersession of
 * the entity's current observation), plus back-compat of the unmodified
 * add_observations path.
 */
import { describe, it, expect, afterAll } from 'vitest';

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

async function toolsList(): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const json = await res.json();
  return json.result?.tools || [];
}

describe('Current Observation (ENG-1)', () => {
  const runTag = Date.now();
  const cleanupEntities: string[] = [];

  function testEntityName(suffix: string): string {
    const name = `test_eng1_${suffix}_${runTag}`;
    cleanupEntities.push(name);
    return name;
  }

  afterAll(async () => {
    for (const entityName of cleanupEntities) {
      try {
        await mcpCall('delete_observations_by_entity', { entityName, reason: 'ENG-1 contract test cleanup' });
      } catch { /* best-effort cleanup */ }
    }
  });

  describe('tool registration', () => {
    it('get_current_observation appears in tools/list', async () => {
      const tools = await toolsList();
      const tool = tools.find((t: any) => t.name === 'get_current_observation');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.entity).toBeDefined();
    });

    it('add_observations schema exposes mode and supersedesLatest', async () => {
      const tools = await toolsList();
      const tool = tools.find((t: any) => t.name === 'add_observations');
      expect(tool.inputSchema.properties.mode.enum).toContain('replace-current');
      expect(tool.inputSchema.properties.supersedesLatest).toBeDefined();
      const itemProps = tool.inputSchema.properties.observations.items.properties;
      expect(itemProps.mode.enum).toContain('replace-current');
      expect(itemProps.supersedesLatest).toBeDefined();
    });
  });

  describe('get_current_observation', () => {
    it('returns a clean no_observations shape for an entity with no observations', async () => {
      const result = await mcpCall('get_current_observation', {
        entity: `test_eng1_never_written_${runTag}`,
      });
      expect(result.current).toBeNull();
      expect(result.reason).toBe('no_observations');
      expect(result.resolution.candidatesInWindow).toBe(0);
    });

    it('returns the newest observation with id, timestamp, kind, canonicalFact, and full contents', async () => {
      const entityName = testEntityName('read');
      await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['first observation'] }],
      });
      await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['second observation'] }],
      });
      const third = await mcpCall('add_observations', {
        observations: [{
          entityName,
          contents: ['third observation — the current one'],
          kind: 'decision',
          canonicalFact: 'the third observation is current',
        }],
      });
      const expectedId = third.observations[0].id;

      const result = await mcpCall('get_current_observation', { entity: entityName });
      expect(result.current).not.toBeNull();
      expect(result.current.id).toBe(expectedId);
      expect(result.current.kind).toBe('decision');
      expect(result.current.canonicalFact).toBe('the third observation is current');
      expect(result.current.contents).toEqual(['third observation — the current one']);
      expect(result.current.timestamp).toBeTruthy();
      expect(result.canonicalKey).toBeTruthy();
    });

    it('accepts entityName and name as aliases for entity', async () => {
      const entityName = testEntityName('alias');
      const added = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['alias target'] }],
      });
      const expectedId = added.observations[0].id;

      const byEntityName = await mcpCall('get_current_observation', { entityName });
      expect(byEntityName.current.id).toBe(expectedId);

      const byName = await mcpCall('get_current_observation', { name: entityName });
      expect(byName.current.id).toBe(expectedId);
    });

    it('returns a helpful error when entity is missing', async () => {
      const result = await mcpCall('get_current_observation', {});
      expect(result.error).toContain('entity');
      expect(result.example).toBeDefined();
    });

    it('respects an explicit client-side supersedes chain', async () => {
      const entityName = testEntityName('chain');
      const first = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v1'] }],
      });
      const firstId = first.observations[0].id;
      const second = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v2'], kind: 'correction', supersedes: [firstId] }],
      });

      const result = await mcpCall('get_current_observation', { entity: entityName });
      expect(result.current.id).toBe(second.observations[0].id);
      expect(result.current.metadata.supersedes).toEqual([firstId]);
    });
  });

  describe('add_observations mode:"replace-current"', () => {
    it('two successive replace-current writes leave exactly one non-superseded observation', async () => {
      const entityName = testEntityName('replace');

      const first = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['state v1'], mode: 'replace-current' }],
      });
      const firstId = first.observations[0].id;
      // Nothing existed to supersede, but the mode is recorded
      expect(first.observations[0].metadata.supersedeMode).toBe('replace-current');
      expect(first.observations[0].metadata.supersedes).toBeUndefined();

      const second = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['state v2'], mode: 'replace-current' }],
      });
      const secondId = second.observations[0].id;
      // Server resolved and superseded v1 without the client passing its id
      expect(second.observations[0].metadata.supersedes).toEqual([firstId]);
      expect(second.observations[0].metadata.supersedeMode).toBe('replace-current');

      const current = await mcpCall('get_current_observation', { entity: entityName });
      expect(current.current.id).toBe(secondId);
      // v1 is superseded, v2 is not: exactly one non-superseded observation
      expect(current.resolution.candidatesInWindow).toBe(2);
    });

    it('supersedesLatest:true is an alias for replace-current', async () => {
      const entityName = testEntityName('aliasflag');
      const first = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v1'] }],
      });
      const second = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v2'], supersedesLatest: true }],
      });
      expect(second.observations[0].metadata.supersedes).toEqual([first.observations[0].id]);

      const current = await mcpCall('get_current_observation', { entity: entityName });
      expect(current.current.id).toBe(second.observations[0].id);
    });

    it('call-level mode applies to every observation and same-entity chains stay intact', async () => {
      const entityName = testEntityName('calllevel');
      const result = await mcpCall('add_observations', {
        mode: 'replace-current',
        observations: [
          { entityName, contents: ['chained v1'] },
          { entityName, contents: ['chained v2'] },
        ],
      });
      const [v1, v2] = result.observations;
      expect(v1.metadata.supersedeMode).toBe('replace-current');
      // Second observation in the same call supersedes the first
      expect(v2.metadata.supersedes).toEqual([v1.id]);

      const current = await mcpCall('get_current_observation', { entity: entityName });
      expect(current.current.id).toBe(v2.id);
    });

    it('merges the resolved id with client-supplied supersedes', async () => {
      const entityName = testEntityName('merge');
      const first = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v1'] }],
      });
      const firstId = first.observations[0].id;
      const second = await mcpCall('add_observations', {
        observations: [{
          entityName,
          contents: ['v2'],
          mode: 'replace-current',
          supersedes: ['manual-handle-1'],
        }],
      });
      expect(second.observations[0].metadata.supersedes).toContain('manual-handle-1');
      expect(second.observations[0].metadata.supersedes).toContain(firstId);
    });

    it('per-observation mode:"append" overrides a call-level replace-current', async () => {
      const entityName = testEntityName('override');
      await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['v1'] }],
      });
      const result = await mcpCall('add_observations', {
        mode: 'replace-current',
        observations: [{ entityName, contents: ['appended anyway'], mode: 'append' }],
      });
      expect(result.observations[0].metadata.supersedeMode).toBeUndefined();
      expect(result.observations[0].metadata.supersedes).toBeUndefined();
    });
  });

  describe('back-compat', () => {
    it('add_observations without mode behaves exactly as before', async () => {
      const entityName = testEntityName('backcompat');
      const first = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['plain v1'] }],
      });
      const second = await mcpCall('add_observations', {
        observations: [{ entityName, contents: ['plain v2'], severity: 'high', kind: 'finding' }],
      });

      expect(first.added).toBe(1);
      expect(second.observations[0].metadata.supersedeMode).toBeUndefined();
      expect(second.observations[0].metadata.supersedes).toBeUndefined();
      expect(second.observations[0].metadata.kind).toBe('finding');
      expect(second.observations[0].metadata.severity).toBe('high');
      expect(second.observations[0].metadata.source).toBe('add_observations');
      expect(second.observations[0].metadata.contentHash).toBeTruthy();

      // Both remain un-superseded appends; newest wins as current
      const current = await mcpCall('get_current_observation', { entity: entityName });
      expect(current.current.id).toBe(second.observations[0].id);
      expect(current.resolution.supersededSkipped).toBe(0);
    });
  });
});
