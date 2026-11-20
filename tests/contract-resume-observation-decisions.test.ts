/**
 * Field feedback P1 item 2: add_observations(kind:"decision") did not appear
 * in resume().decisions, which only read the current checkpoint's decision
 * events. resume v2/v3 now list both, labelled: checkpoint decisions first
 * (source:"checkpoint"), then the unsuperseded decision observations on the
 * scope entity, newest first (source:"observation"). The v1 bundle is frozen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import Ajv from 'ajv';
import { RESUME_OUTPUT_SCHEMA, RESUME_OUTPUT_SCHEMA_V1 } from '../src/unified-server/eng4/schemas.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

describe('resume lists observation-sourced decisions (v2/v3)', () => {
  let server: NeuralMCPServer;
  const suffix = Date.now();
  const project = `c2-decisions-${suffix}`;
  const other = `c2-other-${suffix}`;
  // A PREFIX SIBLING: its observations share the scope's lookup-key prefix.
  const sibling = `${project}-child`;
  const agentId = 'c2-test-agent';
  let oldId = '';
  let keptId = '';
  let newestId = '';

  const resume = (resultVersion?: number) =>
    mcpCall(server, 'resume', {
      agentId,
      scope: { project },
      budget: 8000,
      ...(resultVersion ? { resultVersion } : {}),
    });

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
    await mcpCall(server, 'create_entities', {
      entities: [
        { name: project, entityType: 'project', observations: [] },
        { name: other, entityType: 'project', observations: [] },
        { name: sibling, entityType: 'project', observations: [] },
      ],
    });
    await mcpCall(server, 'checkpoint', {
      agentId,
      scope: { project },
      expectedRevision: null,
      idempotencyKey: `c2-cp-${suffix}`,
      state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
      events: [{ kind: 'decision', summary: 'checkpoint decision', at: '2026-11-01T00:00:00Z' }],
    });
    const first = await mcpCall(server, 'add_observations', {
      observations: [
        { entityName: project, contents: ['decision to be replaced'], kind: 'decision' },
        { entityName: project, contents: ['decision that stays'], kind: 'decision' },
        { entityName: project, contents: ['a plain note, not a decision'] },
        { entityName: other, contents: ['decision on another entity'], kind: 'decision' },
      ],
    });
    [oldId, keptId] = first.observations.map((o: any) => o.id);
    const second = await mcpCall(server, 'add_observations', {
      observations: [
        { entityName: project, contents: ['replacement decision'], kind: 'decision', metadata: { supersedes: [oldId] } },
      ],
    });
    newestId = second.observations[0].id;
    // The sibling records its own decision and a note that claims to supersede
    // the scope's kept decision: neither may affect the scope's resume.
    await mcpCall(server, 'add_observations', {
      observations: [
        { entityName: sibling, contents: ['sibling decision'], kind: 'decision' },
        { entityName: sibling, contents: ['sibling note'], metadata: { supersedes: [keptId] } },
      ],
    });
    const db = server.getMemoryManager().getDb();
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-11-02 00:00:00', oldId);
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-11-03 00:00:00', keptId);
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run('2026-11-04 00:00:00', newestId);
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  for (const version of [2, 3]) {
    it(`v${version}: checkpoint decisions first, then unsuperseded decision observations, newest first, labelled`, async () => {
      const bundle = await resume(version);
      const decisions = bundle.decisions;
      expect(decisions.map((d: any) => d.source)).toEqual(['checkpoint', 'observation', 'observation']);
      expect(decisions[0]).toMatchObject({ summary: 'checkpoint decision', source: 'checkpoint' });
      expect(decisions[0].observationId).toBeUndefined();
      expect(decisions.slice(1).map((d: any) => d.observationId)).toEqual([newestId, keptId]);
      expect(decisions[1]).toMatchObject({
        id: `observation:${newestId}`,
        summary: 'replacement decision',
        source: 'observation',
        evidenceRefs: [],
        author: expect.any(String),
        recordedAt: expect.any(String),
      });
      const summaries = decisions.map((d: any) => d.summary);
      expect(summaries).not.toContain('decision to be replaced'); // superseded
      expect(summaries).not.toContain('a plain note, not a decision'); // not kind:decision
      expect(summaries).not.toContain('decision on another entity'); // other scope
      expect(summaries).not.toContain('sibling decision'); // prefix sibling
      expect(bundle.observationDecisions).toEqual({ listedCount: 2, totalCount: 2, omittedCount: 0 });
      expect(bundle.coverage.decisions).toMatchObject({ includedCount: 3, totalCount: 3, contentComplete: true });
      expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    });
  }

  it('v1 (frozen) is unchanged: checkpoint decisions only, no source field', async () => {
    const bundle = await resume();
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle).not.toHaveProperty('observationDecisions');
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.decisions[0]).toEqual({
      id: expect.stringMatching(/:0$/),
      summary: 'checkpoint decision',
      recordedAt: '2026-11-01T00:00:00Z',
      evidenceRefs: [],
    });
    expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
  });

  it('the frozen v1 output schema does not accept the new decision fields', () => {
    const item = (RESUME_OUTPUT_SCHEMA_V1 as any).properties.decisions.items;
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort()).toEqual(['evidenceRefs', 'id', 'recordedAt', 'summary']);
  });

  it('observation decisions are budgeted and paged like any other item', async () => {
    const paged = `c2-paged-${suffix}`;
    await mcpCall(server, 'create_entities', { entities: [{ name: paged, entityType: 'project', observations: [] }] });
    await mcpCall(server, 'add_observations', {
      observations: [1, 2, 3].map((n) => ({ entityName: paged, contents: [`decision ${n} `.padEnd(600, 'x')], kind: 'decision' })),
    });
    const page1 = await mcpCall(server, 'resume', {
      agentId, scope: { project: paged }, resultVersion: 2, sections: ['decisions'], budget: 256,
    });
    expect(page1.decisions.length).toBeGreaterThan(0);
    expect(page1.decisions.length).toBeLessThan(3);
    expect(page1.coverage.decisions).toMatchObject({ totalCount: 3, omittedReason: 'budget', nextCursor: expect.any(String) });
    const page2 = await mcpCall(server, 'resume', {
      agentId, scope: { project: paged }, resultVersion: 2, sections: ['decisions'], budget: 256,
      cursor: page1.coverage.decisions.nextCursor,
    });
    expect(page2.decisions[0].observationId).not.toBe(page1.decisions[0].observationId);
    expect(page2.decisions[0].source).toBe('observation');
  });

  it('a prefix sibling neither leaks its decisions in nor hides the scope decisions (ownership, not lookup prefix)', async () => {
    const bundle = await resume(2);
    const ids = bundle.decisions.map((d: any) => d.observationId).filter(Boolean);
    expect(ids).toContain(keptId); // the sibling's supersedes:[keptId] is ignored
    expect(bundle.decisions.map((d: any) => d.summary)).not.toContain('sibling decision');
    // The sibling's own resume does list its decision.
    const own = await mcpCall(server, 'resume', { agentId, scope: { project: sibling }, budget: 8000, resultVersion: 2 });
    expect(own.decisions.map((d: any) => d.summary)).toEqual(['sibling decision']);
  });

  it('lists at most the 10 newest observation decisions and counts the rest', async () => {
    const many = `c2-many-${suffix}`;
    await mcpCall(server, 'create_entities', { entities: [{ name: many, entityType: 'project', observations: [] }] });
    const added = await mcpCall(server, 'add_observations', {
      observations: Array.from({ length: 12 }, (_, n) => ({ entityName: many, contents: [`many decision ${n}`], kind: 'decision' })),
    });
    const db = server.getMemoryManager().getDb();
    added.observations.forEach((o: any, n: number) =>
      db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(`2026-10-${String(n + 1).padStart(2, '0')} 00:00:00`, o.id));
    const bundle = await mcpCall(server, 'resume', { agentId, scope: { project: many }, budget: 8000, resultVersion: 3 });
    expect(bundle.decisions.map((d: any) => d.summary)).toEqual(
      Array.from({ length: 10 }, (_, i) => `many decision ${11 - i}`));
    expect(bundle.observationDecisions).toEqual({ listedCount: 10, totalCount: 12, omittedCount: 2 });
  });

  it('one observation scan per resume, even for an unrequested section', async () => {
    const manager = server.getMemoryManager() as any;
    const scan = vi.spyOn(manager, 'getScopeObservationSelections');
    const capsules = vi.spyOn(manager, 'getCapsuleObservations');
    try {
      await mcpCall(server, 'resume', { agentId, scope: { project }, budget: 8000, resultVersion: 2, sections: ['working'] });
      expect(scan).toHaveBeenCalledTimes(1);
      expect(capsules).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      capsules.mockRestore();
    }
  });
});
