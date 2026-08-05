/**
 * NE-S4: Contract Tests for Session Protocol Tools
 *
 * Exercises get_agent_context, begin_session, end_session against the live neural server.
 * Includes round-trip handoff persistence test.
 *
 * Requires: live server at http://localhost:6174 with API_KEY set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

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

  if (json.result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function httpGet(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  return res.json();
}

const TEST_PREFIX = '_session_test_';
const testAgentId = `${TEST_PREFIX}agent_${Date.now()}`;
const testProjectId = `${TEST_PREFIX}project_${Date.now()}`;

describe('Session Protocol Contract Tests', () => {
  beforeAll(async () => {
    const health = await httpGet('/health');
    expect(health.status).toBe('healthy');

    // Pre-register agent with learnings + preferences so context has data
    await mcpCall('register_agent', {
      agentId: testAgentId,
      name: 'Session Test Agent',
      capabilities: ['testing', 'session-protocol'],
    });

    await mcpCall('record_learning', {
      agentId: testAgentId,
      context: 'session protocol testing',
      lesson: 'always verify handoff round-trip',
      confidence: 0.95,
    });

    await mcpCall('set_preferences', {
      agentId: testAgentId,
      preferences: { verbosity: 'detailed', theme: 'dark' },
    });
  });

  afterAll(() => {
    console.log('\n--- Session Protocol Response Times ---');
    for (const [tool, ms] of Object.entries(timings).sort((a, b) => a[1] - b[1])) {
      console.log(`  ${tool}: ${ms}ms`);
    }
  });

  // === get_agent_context ===

  describe('get_agent_context (D4 transition)', () => {
    // Step-3: the tiered hot/warm/cold bundle is replaced by resume's typed
    // sections; the handler throws the migration error, one bootstrap truth.
    it("is replaced by 'resume' and the error says how to migrate", async () => {
      await expect(mcpCall('get_agent_context', { agentId: testAgentId }))
        .rejects.toThrow(/replaced by 'resume'/);
    });
  });

  describe('begin_session (resume wrapper via the pinned adapter)', () => {
    it('opens a session and returns a frozen-schema resume bundle', async () => {
      await mcpCall('create_entities', {
        entities: [{ name: testProjectId, entityType: 'project', observations: ['session protocol test project'] }],
      });
      const bundle = await mcpCall('begin_session', {
        agentId: testAgentId,
        projectId: testProjectId, // legacy shape — adapted by adaptLegacyBeginSessionArgs
      });
      expect(bundle.schemaVersion).toBe(1);
      expect(bundle.resolvedScope.projectId).toBeTruthy();
      expect(bundle.asOf).toBeDefined();
      expect(bundle.coverage.budget).toBe(4000); // adapter default for omitted maxTokens
    });

    it('does NOT create project skeletons: an unknown project returns explicit resolvedScope nulls (create_entities owns creation)', async () => {
      const freshProject = `${TEST_PREFIX}fresh_${Date.now()}`;
      const bundle = await mcpCall('begin_session', { agentId: testAgentId, projectId: freshProject });
      expect(bundle.resolvedScope).toMatchObject({ projectId: null, scopeKey: null });
      expect(bundle.asOf.stale).toBe(true);
      const search = await mcpCall('search_entities', { query: freshProject, searchType: 'exact', limit: 5 });
      const found = (search.results ?? []).some((r: any) => JSON.stringify(r.content ?? r).includes(freshProject));
      expect(found).toBe(false); // no silent entity creation
    });

    it('first session on a new project: no handoff items, working=null, stale=true — absence explicit', async () => {
      const virginProject = `${TEST_PREFIX}virgin_${Date.now()}`;
      await mcpCall('create_entities', {
        entities: [{ name: virginProject, entityType: 'project', observations: ['virgin project'] }],
      });
      const bundle = await mcpCall('begin_session', { agentId: testAgentId, projectId: virginProject });
      expect(bundle.messages.filter((m: any) => m.itemType === 'handoff')).toEqual([]);
      expect(bundle.working).toBeNull();
      expect(bundle.asOf.stale).toBe(true);
    });
  });

  // === end_session ===

  describe('end_session (checkpoint wrapper)', () => {
    it('the legacy {projectId, summary} shape gets an explicit migration error, never a silent different write', async () => {
      await expect(mcpCall('end_session', {
        agentId: testAgentId,
        projectId: testProjectId,
        summary: 'Completed session protocol contract tests',
      })).rejects.toThrow(/delegates to 'checkpoint'/);
    });

    it('checkpoint-shaped args write an immutable snapshot (outcome=written)', async () => {
      const result = await mcpCall('end_session', {
        agentId: testAgentId,
        scope: { project: testProjectId },
        expectedRevision: null,
        idempotencyKey: `session-close-${Date.now()}`,
        state: {
          objective: 'session protocol contract tests',
          status: 'closed: round-trip verified',
          owner: testAgentId,
          nextActions: ['verify round-trip', 'check token budget'],
          blockers: [], guardrails: [],
        },
      });
      expect(result.outcome).toBe('written');
      expect(result.revision).toBe(1);
    });

    it('factChanges replace legacy learnings and surface in the next resume', async () => {
      const result = await mcpCall('end_session', {
        agentId: testAgentId,
        scope: { project: testProjectId },
        expectedRevision: 1,
        idempotencyKey: `session-learn-${Date.now()}`,
        state: { objective: 'session with learnings', status: 'closed', owner: testAgentId, nextActions: [], blockers: [], guardrails: [] },
        factChanges: [
          { assertion: { subject: 'session-tests', predicate: 'lesson', object: 'session tests work well' }, status: 'asserted', evidenceRefs: [], sourceRefs: [] },
          { assertion: { subject: 'handoff', predicate: 'lesson', object: 'state persists correctly' }, status: 'asserted', evidenceRefs: [], sourceRefs: [] },
        ],
      });
      expect(result.outcome).toBe('written');
      const bundle = await mcpCall('begin_session', { agentId: testAgentId, projectId: testProjectId });
      expect(bundle.currentFacts.length).toBeGreaterThanOrEqual(2);
    });
  });

  // === Round-trip handoff persistence ===

  describe('state round-trip (replaces the legacy handoff flag)', () => {
    const rtProjectId = `${TEST_PREFIX}roundtrip_${Date.now()}`;

    it('end_session writes state, the next begin_session resumes it', async () => {
      await mcpCall('create_entities', {
        entities: [{ name: rtProjectId, entityType: 'project', observations: ['round-trip project'] }],
      });
      const first = await mcpCall('begin_session', { agentId: testAgentId, projectId: rtProjectId });
      expect(first.working).toBeNull();

      const closed = await mcpCall('end_session', {
        agentId: testAgentId, scope: { project: rtProjectId }, expectedRevision: null,
        idempotencyKey: `rt-close-${Date.now()}`,
        state: { objective: 'Round-trip handoff test summary', status: 'handed-off', owner: testAgentId,
                 nextActions: ['item-alpha', 'item-beta', 'item-gamma'], blockers: [], guardrails: [] },
      });
      expect(closed.outcome).toBe('written');

      const second = await mcpCall('begin_session', { agentId: testAgentId, projectId: rtProjectId });
      expect(second.working.objective).toBe('Round-trip handoff test summary');
      expect(second.working.nextActions).toEqual(['item-alpha', 'item-beta', 'item-gamma']);
      expect(second.asOf.revision).toBe(1);
      expect(second.asOf.stale).toBe(false);
    });

    it('a second end_session extends history (revision 2) and the latest state wins on resume', async () => {
      const closed2 = await mcpCall('end_session', {
        agentId: testAgentId, scope: { project: rtProjectId }, expectedRevision: 1,
        idempotencyKey: `rt-close-2-${Date.now()}`,
        state: { objective: 'Updated handoff after second session', status: 'handed-off', owner: testAgentId,
                 nextActions: ['new-item-1'], blockers: [], guardrails: [] },
      });
      expect(closed2.outcome).toBe('written');
      expect(closed2.revision).toBe(2);

      const third = await mcpCall('begin_session', { agentId: testAgentId, projectId: rtProjectId });
      expect(third.working.objective).toBe('Updated handoff after second session');
      expect(third.working.nextActions).toEqual(['new-item-1']);
    });
  });

  // === Phase 0: Context bloat relief ===

  describe('context bloat budget', () => {
    it('begin_session token estimate stays under 4000 with 15+ messages and 15+ observations', async () => {
      const bloatProject = `${TEST_PREFIX}bloat_${Date.now()}`;
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // Setup: create project (begin_session no longer creates skeletons)
      await mcpCall('create_entities', {
        entities: [{ name: bloatProject, entityType: 'project', observations: ['bloat test project'] }],
      });

      // Send 16 messages via HTTP endpoint (bypasses MCP rate limiter)
      for (let i = 0; i < 16; i++) {
        await fetch(`${BASE_URL}/ai-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
          body: JSON.stringify({
            from: `${TEST_PREFIX}sender_${i}`,
            to: testAgentId,
            message: `Bloat test message number ${i} with some extra padding content to simulate real messages that have meaningful length`,
            type: 'info',
          }),
        });
        if (i % 4 === 3) await delay(100);
      }

      // Create 16 observations in batches (4 per call to reduce request count)
      for (let batch = 0; batch < 4; batch++) {
        await mcpCall('add_observations', {
          observations: Array.from({ length: 4 }, (_, j) => ({
            entityName: bloatProject,
            contents: [`Observation ${batch * 4 + j}: detailed technical note about the project state with enough content to be realistic`],
          })),
        });
        await delay(100);
      }

      // Now begin a fresh session — context should be lightweight
      const result = await mcpCall('begin_session', {
        agentId: testAgentId,
        projectId: bloatProject,
      });

      // Step-3 wrapper: the bundle's coverage accounting IS the budget
      // guarantee — totalTokenEstimate never exceeds the adapter's 4000.
      expect(result.schemaVersion).toBe(1);
      expect(result.coverage.budget).toBe(4000);
      expect(result.coverage.totalTokenEstimate).toBeLessThanOrEqual(4000);
      expect(result.coverage.messages.includedCount).toBeLessThanOrEqual(result.coverage.messages.totalCount);
    }, 30000); // 30s timeout for setup
  });

  // === Tool registry includes session tools ===

  describe('tools/list includes session protocol tools', () => {
    it('lists get_agent_context, begin_session, end_session', async () => {
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
      const toolNames = tools.map((t: any) => t.name);

      // Step-3 diet (sol b2543ebc): get_agent_context is retired from
      // DISCOVERY (replaced by resume, D4) but stays callable until cutover.
      expect(toolNames).not.toContain('get_agent_context');
      expect(toolNames).toContain('begin_session');
      expect(toolNames).toContain('end_session');
      expect(toolNames).toContain('resume');
      expect(tools.length).toBe(19);
    });
  });
});
