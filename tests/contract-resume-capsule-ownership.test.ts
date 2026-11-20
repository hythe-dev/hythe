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
  const verScope = `c31-ver-${suffix}-v2`;
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
    const names = [leakScope, `${leakScope}-child`, hideScope, `${hideScope}-child`, selfScope, verScope];
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
    ids.verCapsule = await add(`c31-ver-${suffix}`, 'capsule under the base name', { kind: 'capsule' });
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

  it('an entity named like a version (-vN) sees observations stored under its base name, as the resolver does', async () => {
    const bundle = await resume(verScope, 2);
    expect(bundle.capsule.current?.observationId).toBe(ids.verCapsule);
  });

  it('the sibling still sees its own capsule', async () => {
    const bundle = await resume(`${leakScope}-child`, 2);
    expect(bundle.capsule.current?.observationId).toBe(ids.leakSibling);
    expect(bundle.capsule.conflicts).toEqual([]);
  });
});

/**
 * PR #34 review: ownership must use the SAME rule as the exact entity
 * resolver (one shared helper), so observations stored under a name the
 * resolver maps to the scope entity are never silently dropped. That covers
 * a case/spacing variant, a company-suffix variant and a declared alias, for
 * both capsules and observation decisions. A genuinely different entity whose
 * name merely starts with the scope's name still never leaks (#31).
 */
describe('resume observation ownership matches the entity resolver (capsules and decisions)', () => {
  let server: NeuralMCPServer;
  const suffix = Date.now();
  const llc = `c31r-acme-${suffix}-llc`; // canonical name carries a company suffix
  const base = `c31r-acme-${suffix}`; // the same entity, per the resolver
  const aliased = `c31r-al-${suffix}`;
  const alias = `c31r-alias-${suffix}`;
  const sibling = `${llc}-child`; // a different entity: prefix only
  const agentId = 'c31r-test-agent';
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
    await mcpCall(server, 'create_entities', {
      entities: [
        { name: llc, entityType: 'project', observations: [] },
        { name: sibling, entityType: 'project', observations: [] },
        { name: aliased, entityType: 'project', observations: [], aliases: [alias] },
      ],
    });
    // Suffix variant and case/spacing variant of the scope name.
    ids.suffixCapsule = await add(base, 'capsule under the base name', { kind: 'capsule' });
    ids.suffixDecision = await add(base, 'decision under the base name', { kind: 'decision' });
    ids.caseDecision = await add(`C31R Acme ${suffix} LLC`, 'decision under a case and spacing variant', { kind: 'decision' });
    // The prefix sibling: a newer capsule, a decision, and a supersedes aimed at the scope's capsule.
    ids.siblingCapsule = await add(sibling, 'sibling capsule', { kind: 'capsule' });
    ids.siblingDecision = await add(sibling, 'sibling decision', { kind: 'decision' });
    ids.siblingNote = await add(sibling, 'sibling note', { metadata: { supersedes: [ids.suffixCapsule] } });
    setCreated(ids.suffixCapsule, '2026-11-01 00:00:00');
    setCreated(ids.suffixDecision, '2026-11-01 00:00:01');
    setCreated(ids.caseDecision, '2026-11-01 00:00:02');
    setCreated(ids.siblingCapsule, '2026-11-02 00:00:00');
    // Observations stored under a declared alias.
    ids.aliasCapsule = await add(alias, 'capsule under the alias', { kind: 'capsule' });
    ids.aliasDecision = await add(alias, 'decision under the alias', { kind: 'decision' });
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('the resolver maps the suffix variant, the case variant and the alias to the scope entity (precondition)', () => {
    const manager = server.getMemoryManager() as any;
    const ids = (name: string) => manager.resolveEntityCandidatesExact(name, 'default').map((c: any) => c.name);
    expect(ids(base)).toEqual([llc]);
    expect(ids(`C31R Acme ${suffix} LLC`)).toEqual([llc]);
    expect(ids(alias)).toEqual([aliased]);
    expect(ids(sibling)).toEqual([sibling]);
  });

  for (const version of [2, 3]) {
    it(`v${version}: suffix- and case-variant observations count for the scope; the prefix sibling's never do`, async () => {
      const bundle = await resume(llc, version);
      expect(bundle.capsule.current?.observationId).toBe(ids.suffixCapsule);
      expect(bundle.capsule.conflicts).toEqual([]);
      expect(bundle.capsule.candidatesConsidered).toBe(3);
      const observed = bundle.decisions.filter((d: any) => d.source === 'observation').map((d: any) => d.observationId);
      expect(observed).toEqual([ids.caseDecision, ids.suffixDecision]);
      const text = JSON.stringify(bundle);
      for (const id of [ids.siblingCapsule, ids.siblingDecision, ids.siblingNote]) expect(text).not.toContain(id);
      expect(validBundle(bundle), JSON.stringify(validBundle.errors)).toBe(true);
    });

    it(`v${version}: observations stored under a declared alias count for the scope`, async () => {
      const bundle = await resume(aliased, version);
      expect(bundle.capsule.current?.observationId).toBe(ids.aliasCapsule);
      expect(bundle.capsule.candidatesConsidered).toBe(2);
      const observed = bundle.decisions.filter((d: any) => d.source === 'observation').map((d: any) => d.observationId);
      expect(observed).toEqual([ids.aliasDecision]);
      expect(bundle.observationDecisions).toEqual({ listedCount: 1, totalCount: 1, omittedCount: 0 });
    });
  }

  it('the prefix sibling keeps its own capsule and decision, and none of the scope\'s', async () => {
    const bundle = await resume(sibling, 2);
    expect(bundle.capsule.current?.observationId).toBe(ids.siblingCapsule);
    expect(bundle.capsule.conflicts).toEqual([]);
    const observed = bundle.decisions.filter((d: any) => d.source === 'observation').map((d: any) => d.observationId);
    expect(observed).toEqual([ids.siblingDecision]);
  });
});
