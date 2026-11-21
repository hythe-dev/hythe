/**
 * Issue #35 (comment 7053605496): when version siblings both exist (x-v2 and
 * x-v3, or x and x-v3), resume with either EXACT canonical name failed
 * closed: the exact resolver also matched -vN-stripped variants, so both
 * entities were candidates (ambiguousCandidates [x-v2, x-v3]), no scope was
 * read and no capsule was returned. Resolution is now exact first: a name
 * that is exactly an entity's canonical name or declared alias resolves to
 * that entity; variants apply only when no entity has the name exactly. A
 * name two entities share exactly stays ambiguous.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

describe('resume resolves version siblings by exact name (issue #35)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();
  const agentId = 'vsib-test-agent';
  const resume = (project: string, resultVersion: number) =>
    mcpCall(server, 'resume', { agentId, scope: { project }, budget: 8000, resultVersion });
  const create = (entities: Array<{ name: string; aliases?: string[] }>) =>
    mcpCall(server, 'create_entities', {
      entities: entities.map((e) => ({ name: e.name, entityType: 'project', observations: [], aliases: e.aliases ?? [] })),
    });
  const capsule = async (entityName: string) =>
    (await mcpCall(server, 'add_observations', {
      observations: [{ entityName, contents: [`capsule for ${entityName}`], kind: 'capsule' }],
    })).observations[0].id as string;
  const idOf = (name: string) =>
    (server.getMemoryManager().getDb().prepare(
      `SELECT id FROM shared_memory WHERE memory_type = 'entity' AND json_extract(content, '$.name') = ?`
    ).get(name) as any).id as string;

  const expectOwnScope = async (ref: string, name: string, own: string) => {
    for (const version of [2, 3]) {
      const bundle = await resume(ref, version);
      expect(bundle.resolvedScope.ambiguousCandidates).toBeUndefined();
      expect(bundle.resolvedScope.projectId).toBe(idOf(name));
      expect(bundle.resolvedScope.scopeKey).toBe(`p:${idOf(name)}`);
      expect(bundle.capsule.current?.observationId).toBe(own);
      expect(bundle.capsule.conflicts).toEqual([]);
      expect(bundle.capsule.candidatesConsidered).toBe(1);
    }
  };

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('base + version (hb-voice / hb-voice-v3): each exact name resolves to itself with its own capsule', async () => {
    const base = `vsib-hb-voice-${s}`;
    const v3 = `${base}-v3`;
    await create([{ name: base }, { name: v3 }]);
    const baseCapsule = await capsule(base);
    const v3Capsule = await capsule(v3);
    await expectOwnScope(base, base, baseCapsule);
    await expectOwnScope(v3, v3, v3Capsule);
  });

  it('two versions, no base (x-v2 / x-v3): each exact name resolves to itself with its own capsule', async () => {
    const v2 = `vsib-x-${s}-v2`;
    const v3 = `vsib-x-${s}-v3`;
    await create([{ name: v2 }, { name: v3 }]);
    const v2Capsule = await capsule(v2);
    const v3Capsule = await capsule(v3);
    await expectOwnScope(v2, v2, v2Capsule);
    await expectOwnScope(v3, v3, v3Capsule);
  });

  it('alias form: version-sibling aliases each resolve to their own entity', async () => {
    const baseName = `vsib-alias-base-${s}`;
    const v3Name = `vsib-alias-other-${s}`;
    const a2Name = `vsib-alias-two-${s}`;
    const a3Name = `vsib-alias-three-${s}`;
    const handle = `vsib-handle-${s}`;
    await create([
      { name: baseName, aliases: [handle] },              // alias "h"
      { name: v3Name, aliases: [`${handle}-v3`] },        // alias "h-v3"
      { name: a2Name, aliases: [`vsib-ver-${s}-v2`] },    // alias "y-v2"
      { name: a3Name, aliases: [`vsib-ver-${s}-v3`] },    // alias "y-v3"
    ]);
    const baseCapsule = await capsule(handle);
    const v3Capsule = await capsule(`${handle}-v3`);
    const a2Capsule = await capsule(`vsib-ver-${s}-v2`);
    const a3Capsule = await capsule(`vsib-ver-${s}-v3`);
    await expectOwnScope(handle, baseName, baseCapsule);
    await expectOwnScope(`${handle}-v3`, v3Name, v3Capsule);
    await expectOwnScope(`vsib-ver-${s}-v2`, a2Name, a2Capsule);
    await expectOwnScope(`vsib-ver-${s}-v3`, a3Name, a3Capsule);
    for (const version of [2, 3]) {
      expect((await resume(`${handle}-v3`, version)).resolvedScope.aliasesMatched).toEqual([`${handle}-v3`]);
    }
  });

  it('a real shared-alias collision stays ambiguous and reads no scope', async () => {
    const shared = `vsib-shared-${s}`;
    const one = `vsib-one-${s}`;
    const two = `vsib-two-${s}`;
    await create([{ name: one, aliases: [shared] }, { name: two, aliases: [shared] }]);
    await capsule(one);
    await capsule(two);
    for (const version of [2, 3]) {
      const bundle = await resume(shared, version);
      expect(bundle.resolvedScope.projectId).toBeNull();
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates).toEqual([one, two].sort());
      expect(bundle.capsule.current ?? null).toBeNull();
    }
    // Each entity still resolves by its own canonical name.
    for (const version of [2, 3]) {
      expect((await resume(one, version)).resolvedScope.projectId).toBe(idOf(one));
    }
  });

  it('variants still resolve when no entity has the name exactly; an exact-name tie stays ambiguous', async () => {
    const solo = `vsib-solo-${s}-v2`;
    await create([{ name: solo }]);
    const soloCapsule = await capsule(solo);
    await expectOwnScope(solo, solo, soloCapsule);
    for (const version of [2, 3]) {
      expect((await resume(`vsib-solo-${s}-v2 LLC`, version)).resolvedScope.projectId).toBe(idOf(solo));
    }
    // Two entities whose canonical names normalize to the same key.
    const twin = `vsib-twin-${s}`;
    await create([{ name: twin }, { name: twin.toUpperCase() }]);
    for (const version of [2, 3]) {
      const bundle = await resume(twin, version);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates?.length).toBe(2);
    }
  });
});
