/**
 * Issue #31: resume v2/v3 selected the capsule from every row the lookup
 * index returned for the scope name, and those rows include prefix siblings
 * ("<scope>-child" observations for "<scope>"). A sibling's capsule could
 * become the scope's capsule.current or a conflict, and a sibling's
 * supersedes could retire the scope's capsule. Capsules now use the same
 * ownership rule as observation decisions (#29): only observations whose
 * entityName is the scope entity's name or a declared alias count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { RESUME_OUTPUT_SCHEMA } from '../src/unified-server/eng4/schemas.js';

const ajv = new Ajv({ allErrors: true, $data: true });
const validBundle = ajv.compile(RESUME_OUTPUT_SCHEMA as any);

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

describe('resume capsule selection counts only the scope entity\'s own observations (#31)', () => {
  let server: NeuralMCPServer;
  const suffix = Date.now();
  const leakScope = `c31-leak-${suffix}`;
  const hideScope = `c31-hide-${suffix}`;
  const selfScope = `c31-self-${suffix}`;
  const agentId = 'c31-test-agent';
  const ids: Record<string, string> = {};

  const resume = (project: string, resultVersion: number) =>
    mcpCall(server, 'resume', { agentId, scope: { project }, budget: 8000, resultVersion });
  const add = async (entityName: string, contents: string, extra: Record<string, any> = {}) =>
    (await mcpCall(server, 'add_observations', { observations: [{ entityName, contents: [contents], ...extra }] })).observations[0].id as string;
  const setCreated = (id: string, at: string) =>
    server.getMemoryManager().getDb().prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(at, id);

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
    const names = [leakScope, `${leakScope}-child`, hideScope, `${hideScope}-child`, selfScope];
    await mcpCall(server, 'create_entities', {
      entities: names.map((name) => ({ name, entityType: 'project', observations: [] })),
    });
    // Leak: the scope's capsule is OLDER than a sibling's capsule.
    ids.leakOwn = await add(leakScope, 'leak scope capsule', { kind: 'capsule' });
    ids.leakSibling = await add(`${leakScope}-child`, 'sibling capsule', { kind: 'capsule' });
    setCreated(ids.leakOwn, '2026-11-01 00:00:00');
    setCreated(ids.leakSibling, '2026-11-02 00:00:00');
    // Hide: a sibling note claims to supersede the scope's capsule.
    ids.hideOwn = await add(hideScope, 'hide scope capsule', { kind: 'capsule' });
    ids.hideSibling = await add(`${hideScope}-child`, 'sibling note', { metadata: { supersedes: [ids.hideOwn] } });
    // Control: the scope's OWN supersedes still retires its older capsule.
    ids.selfOld = await add(selfScope, 'old capsule', { kind: 'capsule' });
    ids.selfNew = await add(selfScope, 'new capsule', { kind: 'capsule', metadata: { supersedes: [ids.selfOld] } });
    ids.selfNote = await add(selfScope, 'a later note');
    setCreated(ids.selfOld, '2026-11-01 00:00:00');
    setCreated(ids.selfNew, '2026-11-02 00:00:00');
    setCreated(ids.selfNote, '2026-11-03 00:00:00');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  for (const version of [2, 3]) {
    it(`v${version}: a prefix sibling's newer capsule is neither current nor a conflict`, async () => {
      const bundle = await resume(leakScope, version);
      expect(bundle.capsule.current?.observationId).toBe(ids.leakOwn);
      expect(bundle.capsule.conflicts).toEqual([]);
      expect(bundle.capsule.candidatesConsidered).toBe(1);
      expect(JSON.stringify(bundle.capsule)).not.toContain(ids.leakSibling);
      expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    });

    it(`v${version}: a prefix sibling's supersedes does not retire the scope's capsule`, async () => {
      const bundle = await resume(hideScope, version);
      expect(bundle.capsule.current?.observationId).toBe(ids.hideOwn);
      expect(bundle.capsule.conflicts).toEqual([]);
      expect(bundle.capsule.candidatesConsidered).toBe(1);
    });

    it(`v${version}: the scope's own supersedes still retires its older capsule; a newer note does not displace it`, async () => {
      const bundle = await resume(selfScope, version);
      expect(bundle.capsule.current?.observationId).toBe(ids.selfNew);
      expect(bundle.capsule.conflicts).toEqual([]);
      expect(bundle.capsule.candidatesConsidered).toBe(3);
    });
  }

  it('the sibling still sees its own capsule', async () => {
    const bundle = await resume(`${leakScope}-child`, 2);
    expect(bundle.capsule.current?.observationId).toBe(ids.leakSibling);
    expect(bundle.capsule.conflicts).toEqual([]);
  });
});
