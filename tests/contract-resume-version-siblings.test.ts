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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import type { RequestContext } from '../src/middleware/auth/types.js';
import { DEFAULT_REQUEST_CONTEXT } from '../src/middleware/auth/types.js';

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

/**
 * PR #36 round 2: exact owners come from the STORED entity records, not the
 * capped lookup index (64 keys per entity). A hidden exact owner must keep a
 * shared name ambiguous; stale index rows must not create owners; the same
 * resolution guards resume (v2, v3, task scopes), checkpoint writes and
 * discover_related_context.
 */
describe('exact owners come from stored entity records (PR #36 round 2)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();
  const agentId = 'vsib-r2-agent';
  const fillers = (tag: string) => Array.from({ length: 100 }, (_, i) => `f${i}x${tag}${s}`); // sort before "zz-…"
  const call = async (toolName: string, args: Record<string, any>, context?: RequestContext) => {
    const result = await (server as any)._handleToolCall(toolName, args, context);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  };
  const resume = (scope: Record<string, string>, resultVersion: number) =>
    call('resume', { agentId, scope, budget: 8000, resultVersion });
  const create = (entities: Array<{ name: string; aliases?: string[]; observations?: string[] }>, context?: RequestContext) =>
    call('create_entities', {
      entities: entities.map((e) => ({ name: e.name, entityType: 'project', observations: e.observations ?? [], aliases: e.aliases ?? [] })),
    }, context);
  const capsule = async (entityName: string) =>
    (await call('add_observations', { observations: [{ entityName, contents: [`capsule for ${entityName}`], kind: 'capsule' }] }))
      .observations[0].id as string;
  const db = () => server.getMemoryManager().getDb();
  const idOf = (name: string, tenant = 'default') =>
    (db().prepare(`SELECT id FROM shared_memory WHERE memory_type = 'entity' AND tenant_id = ? AND json_extract(content, '$.name') = ?`)
      .get(tenant, name) as any).id as string;
  const indexedNames = (key: string) =>
    [...new Set((db().prepare(
      `SELECT json_extract(sm.content, '$.name') AS name FROM graph_lookup_keys g
         JOIN shared_memory sm ON sm.id = g.memory_id
        WHERE g.lookup_key = ? AND g.memory_type = 'entity' AND g.tenant_id = 'default'`
    ).all(key) as any[]).map((r) => r.name))].sort();
  const setContent = (name: string, mutate: (content: any) => void) => {
    const id = idOf(name);
    const content = JSON.parse((db().prepare('SELECT content FROM shared_memory WHERE id = ?').get(id) as any).content);
    mutate(content);
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run(JSON.stringify(content), id); // no reindex
  };
  const expectAmbiguous = async (scope: Record<string, string>, names: string[]) => {
    for (const version of [2, 3]) {
      const bundle = await resume(scope, version);
      expect(bundle.resolvedScope.projectId ?? null).toBeNull();
      expect(bundle.resolvedScope.taskId ?? null).toBeNull();
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates).toEqual([...names].sort());
      expect(bundle.capsule.current ?? null).toBeNull();
      expect(bundle.definition ?? null).toBeNull();
    }
  };
  const expectResolves = async (ref: string, name: string, own?: string) => {
    for (const version of [2, 3]) {
      const bundle = await resume({ project: ref }, version);
      expect(bundle.resolvedScope.ambiguousCandidates).toBeUndefined();
      expect(bundle.resolvedScope.projectId).toBe(idOf(name));
      if (own) expect(bundle.capsule.current?.observationId).toBe(own);
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

  it('codex repro: a capped owner hides the shared alias from the index; the shared name stays ambiguous (with and without a -v3 sibling)', async () => {
    for (const withV3 of [true, false]) {
      const tag = withV3 ? 'c' : 'n';
      const shared = `zz-pr36-shared-${tag}${s}`;
      const a = `pr36-hidden-owner-${tag}${s}`;
      const handle = `pr36-b-private-handle-${tag}${s}`;
      await create([
        { name: a, aliases: [...fillers(tag), shared] },
        { name: shared, aliases: [handle], observations: ['B founding observation'] },
        ...(withV3 ? [{ name: `${shared}-v3` }] : []),
      ]);
      expect(indexedNames(shared)).toContain(shared);
      expect(indexedNames(shared)).not.toContain(a); // precondition: A's alias is not indexed
      const bCapsule = await capsule(handle);
      await expectAmbiguous({ project: shared }, [a, shared]);
      await expectResolves(handle, shared, bCapsule);
      if (withV3) await expectResolves(`${shared}-v3`, `${shared}-v3`);
    }
  });

  it('hidden alias vs hidden alias: two capped owners of the same dropped alias are ambiguous', async () => {
    const key = `zz-hh-${s}`;
    const a = `hh-a-${s}`;
    const b = `hh-b-${s}`;
    await create([{ name: a, aliases: [...fillers('ha'), key] }, { name: b, aliases: [...fillers('hb'), key] }]);
    expect(indexedNames(key)).toEqual([]);
    await expectAmbiguous({ project: key }, [a, b]);
  });

  it('capped, zero-row and visible owners in the same query are all counted', async () => {
    const key = `zz-mix-${s}`;
    const capped = `mix-capped-${s}`;
    const zero = `mix-zero-${s}`;
    await create([{ name: capped, aliases: [...fillers('mc'), key] }, { name: zero, aliases: [key] }, { name: key }]);
    db().prepare('DELETE FROM graph_lookup_keys WHERE memory_id = ?').run(idOf(zero));
    expect(indexedNames(key)).toEqual([key]);
    await expectAmbiguous({ project: key }, [capped, zero, key]);
  });

  it('the shared key as a capped entity\'s canonical name, also held as a hidden alias elsewhere', async () => {
    const key = `zz-canon-${s}`;
    const other = `canon-other-${s}`;
    await create([{ name: key, aliases: fillers('ca') }, { name: other, aliases: [...fillers('cb'), key] }]);
    expect(indexedNames(key)).toEqual([key]);
    await expectAmbiguous({ project: key }, [key, other]);
  });

  it('an alias added after the cap was hit (reindexed, still dropped) counts', async () => {
    const key = `zz-late-${s}`;
    const a = `late-a-${s}`;
    await create([{ name: a, aliases: fillers('la') }, { name: key }]);
    setContent(a, (c) => { c.aliases.push(key); });
    const manager = server.getMemoryManager() as any;
    const content = JSON.parse((db().prepare('SELECT content FROM shared_memory WHERE id = ?').get(idOf(a)) as any).content);
    manager.refreshGraphLookupIndexForMemory(idOf(a), 'default', 'entity', content);
    expect(indexedNames(key)).toEqual([key]);
    await expectAmbiguous({ project: key }, [a, key]);
  });

  it('aliases added, removed or renamed without a reindex; a stale index row for a removed alias owns nothing', async () => {
    const added = `edit-added-${s}`;
    const removed = `edit-removed-${s}`;
    const a = `edit-a-${s}`;
    const ren = `edit-ren-old-${s}`;
    await create([{ name: a, aliases: [removed] }, { name: added }, { name: removed }, { name: ren }]);
    // added without reindex -> A now shares `added` exactly
    setContent(a, (c) => { c.aliases = [added]; });
    await expectAmbiguous({ project: added }, [a, added]);
    // removed without reindex -> the stale index row for `removed` is ignored
    expect(indexedNames(removed)).toEqual([a, removed].sort());
    await expectResolves(removed, removed);
    // renamed without reindex -> the new name resolves, the old one does not
    setContent(ren, (c) => { c.name = `edit-ren-new-${s}`; });
    const renamed = await resume({ project: `edit-ren-new-${s}` }, 2);
    expect(renamed.resolvedScope.projectId).toBe(idOf(`edit-ren-new-${s}`));
    const old = await resume({ project: ren }, 2);
    expect(old.resolvedScope.scopeKey).toBeNull();
    expect(old.resolvedScope.ambiguousCandidates).toBeUndefined();
  });

  it('a deleted entity that still held the alias owns nothing, nor does a dangling index row', async () => {
    const key = `del-key-${s}`;
    const a = `del-a-${s}`;
    await create([{ name: a, aliases: [key] }, { name: key }]);
    await expectAmbiguous({ project: key }, [a, key]);
    await (server.getMemoryManager() as any).retireEntitiesToTrash([a], 'default', 'test'); // what delete_entity does
    db().prepare(`INSERT INTO graph_lookup_keys (tenant_id, lookup_key, memory_type, memory_id, key_kind, weight, updated_at)
      VALUES ('default', ?, 'entity', 'dangling-id', 'alias', 95, CURRENT_TIMESTAMP)`).run(key);
    await expectResolves(key, key);
  });

  it('the unindexed project-skeleton path still owns its name', async () => {
    const key = `skel-${s}`;
    const b = `skel-b-${s}`;
    (server.getMemoryManager() as any).ensureProjectEntity(agentId, key, 'default');
    await create([{ name: b, aliases: [key] }]);
    expect(indexedNames(key)).toEqual([b]);
    await expectAmbiguous({ project: key }, [key, b]);
  });

  it('many owners, some capped and some unindexed, are all listed', async () => {
    const key = `zz-many-${s}`;
    const names = Array.from({ length: 6 }, (_, i) => `many-${i}-${s}`);
    await create(names.map((name, i) => ({ name, aliases: i < 2 ? [...fillers(`m${i}`), key] : [key] })));
    db().prepare('DELETE FROM graph_lookup_keys WHERE memory_id = ?').run(idOf(names[2]));
    await expectAmbiguous({ project: key }, names);
  });

  it('owners in another tenant have no effect', async () => {
    const key = `tenant-key-${s}`;
    const other = { ...DEFAULT_REQUEST_CONTEXT, tenantId: 'vsib-other-tenant' } as RequestContext;
    await create([{ name: `tenant-other-${s}`, aliases: [key] }], other);
    await create([{ name: key }]);
    await expectResolves(key, key);
  });

  it('task scopes resolve the same way: version siblings resolve, a hidden collision is ambiguous', async () => {
    const t2 = `task-x-${s}-v2`;
    const t3 = `task-x-${s}-v3`;
    const key = `zz-task-shared-${s}`;
    const a = `task-hidden-${s}`;
    await create([{ name: t2 }, { name: t3 }, { name: a, aliases: [...fillers('ta'), key] }, { name: key }]);
    for (const version of [2, 3]) {
      expect((await resume({ task: t2 }, version)).resolvedScope.taskId).toBe(idOf(t2));
      expect((await resume({ task: t3 }, version)).resolvedScope.taskId).toBe(idOf(t3));
    }
    await expectAmbiguous({ task: key }, [a, key]);
  });

  it('checkpoint against a shared exact name is refused and writes into neither scope', async () => {
    const key = `zz-ckpt-${s}`;
    const a = `ckpt-a-${s}`;
    const aHandle = `ckpt-a-handle-${s}`;
    const bHandle = `ckpt-b-handle-${s}`;
    await create([{ name: a, aliases: [...fillers('ck'), key, aHandle] }, { name: key, aliases: [bHandle] }]);
    await expect(call('checkpoint', {
      agentId, scope: { project: key }, expectedRevision: null, idempotencyKey: `ckpt-${s}`,
      state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
    })).rejects.toThrow(/ambiguous/);
    for (const handle of [aHandle, bHandle]) {
      for (const version of [2, 3]) {
        const bundle = await resume({ project: handle }, version);
        expect(bundle.resolvedScope.scopeKey).not.toBeNull();
        expect(bundle.working).toBeNull();
      }
    }
    // Control: the unique handle checkpoints normally.
    const ok = await call('checkpoint', {
      agentId, scope: { project: bHandle }, expectedRevision: null, idempotencyKey: `ckpt-ok-${s}`,
      state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
    });
    expect(ok.outcome).toBe('written');
    expect((await resume({ project: key }, 2)).resolvedScope.scopeKey).toBeNull();
  });

  it('discover_related_context: version siblings resolve; a hidden collision fails closed before retrieval', async () => {
    const manager = server.getMemoryManager() as any;
    const original = manager.searchRelatedContextSemantic;
    let semanticCalls = 0;
    manager.searchRelatedContextSemantic = async () => { semanticCalls++; return { results: [], degraded: false, reasons: [] }; };
    try {
      const d2 = `disc-x-${s}-v2`;
      const d3 = `disc-x-${s}-v3`;
      const key = `zz-disc-${s}`;
      const a = `disc-hidden-${s}`;
      await create([{ name: d2 }, { name: d3 }, { name: a, aliases: [...fillers('di'), key] }, { name: key }]);
      for (const name of [d2, d3]) {
        const found = await call('discover_related_context', { scope: { project: name }, intent: 'version sibling' });
        expect(found.error).toBeUndefined();
        expect(found.resolvedScope.projectId).toBe(idOf(name));
      }
      semanticCalls = 0;
      const ambiguous = await call('discover_related_context', { scope: { project: key }, intent: 'must fail closed' });
      expect(ambiguous.error).toMatchObject({ code: 'SCOPE_AMBIGUOUS' });
      expect(ambiguous.resolvedScope.ambiguousCandidates).toEqual([a, key].sort());
      expect(ambiguous.candidates).toEqual([]);
      expect(semanticCalls).toBe(0);
    } finally {
      manager.searchRelatedContextSemantic = original;
    }
  });

  it('repeated calls give a stable result, also across unrelated writes and a cache rebuild', async () => {
    const key = `zz-stable-${s}`;
    const a = `stable-a-${s}`;
    await create([{ name: a, aliases: [...fillers('st'), key] }, { name: key }]);
    for (let i = 0; i < 3; i++) {
      await expectAmbiguous({ project: key }, [a, key]);
      await call('send_ai_message', { from: agentId, to: 'vsib-nobody', content: `unrelated write ${i}` });
    }
  });

  it('control: two visible owners stay ambiguous', async () => {
    const key = `vis-key-${s}`;
    await create([{ name: `vis-a-${s}`, aliases: [key] }, { name: `vis-b-${s}`, aliases: [key] }]);
    expect(indexedNames(key)).toEqual([`vis-a-${s}`, `vis-b-${s}`]);
    await expectAmbiguous({ project: key }, [`vis-a-${s}`, `vis-b-${s}`]);
  });

  it('documented (M1): with no exact owner, a missing version resolves to the stored version', async () => {
    const v3 = `m1-x-${s}-v3`;
    await create([{ name: v3 }]);
    expect((await resume({ project: `m1-x-${s}-v2` }, 2)).resolvedScope.projectId).toBe(idOf(v3));
  });

  it('a read error fails closed: unresolved, not a variant fallback', async () => {
    const v2 = `rerr-${s}-v2`;
    await create([{ name: v2 }]);
    const manager = server.getMemoryManager() as any;
    const original = manager.entityExactOwners;
    manager.entityExactOwners = () => null;
    try {
      expect(manager.resolveEntityCandidatesExact(v2, 'default')).toEqual([]);
      expect(manager.resolveEntityCandidatesExact(`${v2} LLC`, 'default')).toEqual([]);
      const bundle = await resume({ project: v2 }, 2);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
    } finally {
      manager.entityExactOwners = original;
    }
    await expectResolves(v2, v2);
  });
});

/**
 * PR #36 round 3 (codex-p1 R1-R5, corrupt-row rule, non-string name): the
 * exact-owner catalog reads stored records with JSON.parse semantics, uses
 * the shared privacy classifier on the parsed payload, never caches a map
 * built inside a transaction, and treats unreadable entity rows as owning
 * nothing while blocking every name their index keys point at.
 */
describe('exact-owner catalog edge cases (PR #36 round 3)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();
  const agentId = 'vsib-r3-agent';
  const call = async (toolName: string, args: Record<string, any>) => {
    const result = await (server as any)._handleToolCall(toolName, args);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  };
  const manager = () => server.getMemoryManager() as any;
  const db = () => server.getMemoryManager().getDb();
  const resume = (project: string, resultVersion: number) =>
    call('resume', { agentId, scope: { project }, budget: 8000, resultVersion });
  const create = (entities: Array<{ name: string; aliases?: string[] }>) =>
    call('create_entities', {
      entities: entities.map((e) => ({ name: e.name, entityType: 'project', observations: [], aliases: e.aliases ?? [] })),
    });
  const idOf = (name: string) =>
    (db().prepare(`SELECT id FROM shared_memory WHERE memory_type = 'entity' AND json_extract(content, '$.name') = ?`).get(name) as any).id as string;
  const insertRaw = (id: string, content: string) =>
    db().prepare(`INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags) VALUES (?, 'default', 'entity', ?, 'r3', '[]')`).run(id, content);
  const importRaw = (id: string, content: string) =>
    manager().importEntities({
      schemaVersion: 1,
      entities: [{ id, content, created_by: 'r3', tags: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      observations: [],
      relations: [],
    }, 'default');
  const names = (ref: string) => [...new Set(manager().resolveEntityCandidatesExact(ref, 'default').map((c: any) => c.name))].sort();
  const checkpoint = (project: string, key: string) => call('checkpoint', {
    agentId, scope: { project }, expectedRevision: null, idempotencyKey: key,
    state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
  });
  const expectAmbiguous = async (ref: string, expected: string[]) => {
    for (const version of [2, 3]) {
      const bundle = await resume(ref, version);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates).toEqual([...expected].sort());
    }
  };
  const expectUnresolved = async (ref: string, mustNotContain: string[] = []) => {
    for (const version of [2, 3]) {
      const bundle = await resume(ref, version);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.projectId ?? null).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates).toBeUndefined();
      expect(bundle.capsule.current ?? null).toBeNull();
      for (const text of mustNotContain) expect(JSON.stringify(bundle)).not.toContain(text);
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

  it('R1: duplicate JSON keys read last-wins, like JSON.parse (imported raw bytes)', async () => {
    const shared = `r1-shared-${s}`;
    const x = `r1-x-${s}`;
    await create([{ name: shared }, { name: x }]);
    await importRaw(`r1-a-${s}`, `{"name":"r1-a-${s}","entityType":"project","aliases":[],"aliases":["${shared}"]}`);
    await importRaw(`r1-d-${s}`, `{"name":"r1-decoy-${s}","name":"${x}","entityType":"project","aliases":[]}`);
    expect((db().prepare('SELECT content FROM shared_memory WHERE id = ?').get(`r1-a-${s}`) as any).content).toContain('"aliases":[],"aliases"');
    await expectAmbiguous(shared, [`r1-a-${s}`, shared]);
    await expectAmbiguous(x, [x]); // two owners named x (names are listed once)
  });

  it('R2: a catalog built inside a rolled-back transaction is not reused', async () => {
    const shared = `r2-shared-${s}`;
    const a = `r2-a-${s}`;
    await create([{ name: a, aliases: [shared] }, { name: shared }]);
    const removeAliasAndResolve = () => {
      db().prepare(`UPDATE shared_memory SET content = json_set(content, '$.aliases', json('[]')) WHERE id = ?`).run(idOf(a));
      expect(names(shared)).toEqual([shared]); // inside: A's alias is gone
      throw new Error('rollback');
    };
    expect(() => db().transaction(removeAliasAndResolve)()).toThrow('rollback');
    expect(names(shared)).toEqual([a, shared].sort());
    await expectAmbiguous(shared, [a, shared]);
    await expect(checkpoint(shared, `r2-ckpt-${s}`)).rejects.toThrow(/ambiguous/);
    // Savepoint: the inner transaction rolls back, the outer one commits.
    db().transaction(() => {
      try { db().transaction(removeAliasAndResolve)(); } catch { /* rolled back to the savepoint */ }
    })();
    expect(names(shared)).toEqual([a, shared].sort());
    await expectAmbiguous(shared, [a, shared]);
    await expect(checkpoint(shared, `r2-ckpt2-${s}`)).rejects.toThrow(/ambiguous/);
    for (const v of [2, 3]) expect((await resume(a, v)).working).toBeNull();
    for (const v of [2, 3]) expect((await resume(`${shared}`, v)).working ?? null).toBeNull();
  });

  it('R4: a private owner with an array-typed entityType fails closed and is never listed', async () => {
    const shared = `r4-shared-${s}`;
    const hidden = `r4-private-hidden-${s}`;
    await create([{ name: shared }]);
    insertRaw(`r4-p-${s}`, JSON.stringify({ name: hidden, entityType: ['message_detail'], aliases: [shared] }));
    expect(manager().isConfidentialMessageSearchItem('entity', { name: hidden, entityType: ['message_detail'] })).toBe(true);
    await expectUnresolved(shared, [hidden]);
  });

  it('R5: aliases count only as a real JSON array, not a string that looks like one', async () => {
    const shared = `r5-shared-${s}`;
    await create([{ name: shared }]);
    insertRaw(`r5-a-${s}`, JSON.stringify({ name: `r5-a-${s}`, entityType: 'project', aliases: `["${shared}"]` }));
    expect(names(shared)).toEqual([shared]);
    const bundle = await resume(shared, 2);
    expect(bundle.resolvedScope.projectId).toBe(idOf(shared));
  });

  it('corrupt entity row: owns nothing, its indexed names do not resolve (not to B), doctor counts it, checkpoint refused', async () => {
    const shared = `cor-shared-${s}`;
    const a = `cor-a-${s}`;
    await create([{ name: a, aliases: [shared] }, { name: shared }]);
    const aId = idOf(a);
    const before = manager().countInvalidEntityRows('default');
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run('{"name": "cor-a", "aliases": [', aId);
    expect(manager().countInvalidEntityRows('default')).toBe(before + 1);
    expect((await manager().getSystemStatus()).sqlite.invalidEntityRows).toBeGreaterThanOrEqual(before + 1);
    await expectUnresolved(shared);
    await expectUnresolved(a);
    await expect(checkpoint(shared, `cor-ckpt-${s}`)).rejects.toThrow(/did not resolve/);
    // A valid-JSON non-object counts as unreadable too.
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run('[1,2]', aId);
    expect(manager().countInvalidEntityRows('default')).toBe(before + 1);
    await expectUnresolved(shared);
    // Repaired: ambiguous again.
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run(JSON.stringify({ name: a, entityType: 'project', aliases: [shared] }), aId);
    expect(manager().countInvalidEntityRows('default')).toBe(before);
    await expectAmbiguous(shared, [a, shared]);
  });

  it('a non-string name owns nothing (not its stringified form); its string aliases still count', async () => {
    const num = `9${String(s).slice(-6)}`;
    const alias = `nsn-alias-${s}`;
    await create([{ name: num }]);
    insertRaw(`nsn-${s}`, JSON.stringify({ name: Number(num), entityType: 'project', aliases: [alias] }));
    expect(names(num)).toEqual([num]);
    expect(manager().resolveEntityCandidatesExact(alias, 'default').map((c: any) => c.id)).toEqual([`nsn-${s}`]);
  });
});

describe('owner lookups across snapshot restore (PR #36 round 3, R3)', () => {
  let server: NeuralMCPServer;
  let tmpDir = '';
  const s = Date.now();

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsib-r3-snapshot-'));
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('after restoreSnapshot a shared name is ambiguous again', async () => {
    const manager = server.getMemoryManager() as any;
    const shared = `r3-shared-${s}`;
    const a = `r3-a-${s}`;
    await (server as any)._handleToolCall('create_entities', {
      entities: [
        { name: a, entityType: 'project', observations: [], aliases: [shared] },
        { name: shared, entityType: 'project', observations: [], aliases: [] },
      ],
    });
    const names = () => [...new Set(manager.resolveEntityCandidatesExact(shared, 'default').map((c: any) => c.name))].sort();
    expect(names()).toEqual([a, shared].sort());
    const snapshot = await manager.createSnapshot(`r3-${s}`);
    await manager.retireEntitiesToTrash([a], 'default', 'r3');
    expect(names()).toEqual([shared]);
    expect(manager.ownerSnapshot).toBeNull(); // nothing is retained between calls
    await manager.restoreSnapshot(snapshot.snapshotId);
    expect(names()).toEqual([a, shared].sort());
  });
});

/**
 * PR #36 round 4: the cache stamp sees DDL (F1); a non-string name never
 * mints a scope, also through the variant fallback (F2); the corrupt-row
 * guards each have a test that fails without them (MINOR-1); the status
 * count degrades instead of failing (NIT-2).
 */
describe('exact-owner catalog round 4', () => {
  let server: NeuralMCPServer;
  const s = Date.now();
  const agentId = 'vsib-r4-agent';
  const call = async (toolName: string, args: Record<string, any>) => {
    const result = await (server as any)._handleToolCall(toolName, args);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  };
  const manager = () => server.getMemoryManager() as any;
  const db = () => server.getMemoryManager().getDb();
  const resume = (project: string, resultVersion: number) =>
    call('resume', { agentId, scope: { project }, budget: 8000, resultVersion });
  const create = (entities: Array<{ name: string; aliases?: string[] }>) =>
    call('create_entities', {
      entities: entities.map((e) => ({ name: e.name, entityType: 'project', observations: [], aliases: e.aliases ?? [] })),
    });
  const idOf = (name: string) =>
    (db().prepare(`SELECT id FROM shared_memory WHERE memory_type = 'entity' AND json_valid(content) AND json_extract(content, '$.name') = ?`).get(name) as any).id as string;
  const checkpoint = (project: string, key: string) => call('checkpoint', {
    agentId, scope: { project }, expectedRevision: null, idempotencyKey: key,
    state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
  });
  const snapshotRows = () => (db().prepare('SELECT COUNT(*) AS c FROM eng4_state_snapshots').get() as any).c as number;
  const expectNoScope = async (ref: string) => {
    for (const version of [2, 3]) {
      const bundle = await resume(ref, version);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.projectId ?? null).toBeNull();
    }
    const before = snapshotRows();
    await expect(checkpoint(ref, `noscope-${ref}`)).rejects.toThrow(/did not resolve|ambiguous/);
    expect(snapshotRows()).toBe(before);
  };

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('F2: an imported entity whose name is an array never mints a scope (no other entity has the name)', async () => {
    const name = `imported-name-${s}`;
    await manager().importEntities({
      schemaVersion: 1,
      entities: [{
        id: `imp-${s}`,
        content: JSON.stringify({ name: [name], entityType: 'project', aliases: [], metadata: { aliases: [name] } }),
        created_by: 'r4', tags: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
      observations: [],
      relations: [],
    }, 'default');
    expect(manager().resolveEntityCandidatesExact(name, 'default')).toEqual([]);
    await expectNoScope(name);
  });

  it('F2: a name changed to a number or an array without a reindex does not resolve through old index rows', async () => {
    const num = `7${String(s).slice(-7)}`;
    const arr = `numeric-name-${s}`;
    await create([{ name: num }, { name: arr }]);
    for (const [name, replacement] of [[num, Number(num)], [arr, [arr]]] as const) {
      const id = idOf(name);
      db().prepare(`UPDATE shared_memory SET content = json_set(content, '$.name', json(?)) WHERE id = ?`).run(JSON.stringify(replacement), id);
      expect((db().prepare('SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE memory_id = ? AND lookup_key = ?').get(id, name) as any).c).toBe(1);
      expect(manager().resolveEntityCandidatesExact(name, 'default')).toEqual([]);
      await expectNoScope(name);
    }
  });

  it('MINOR-1a: a variant whose base key points at a corrupt row is unresolved, not handed to another version', async () => {
    const base = `mvx-${s}`;
    const a = `mvx-owner-${s}`;
    await create([{ name: a, aliases: [base] }, { name: `${base}-v7` }]);
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run('{corrupt', idOf(a));
    expect(manager().resolveEntityCandidatesExact(`${base}-v2`, 'default')).toEqual([]);
    await expectNoScope(`${base}-v2`);
    expect(manager().resolveEntityCandidatesExact(`${base}-v7`, 'default').map((c: any) => c.name)).toEqual([`${base}-v7`]);
  });

  it('MINOR-1b: a capsule under a name a corrupt row also held is not owned by the other holder', async () => {
    const sh = `msh-${s}`;
    const a = `msh-a-${s}`;
    const b = `msh-b-${s}`;
    const handle = `msh-b-handle-${s}`;
    await create([{ name: a, aliases: [sh] }, { name: b, aliases: [sh, handle] }]);
    const legacy = (await call('add_observations', {
      observations: [{ entityName: sh, contents: ['legacy capsule under the shared alias'], kind: 'capsule' }],
    })).observations[0].id as string;
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run('{corrupt', idOf(a));
    for (const version of [2, 3]) {
      const bundle = await resume(handle, version);
      expect(bundle.resolvedScope.projectId).toBe(idOf(b));
      expect(bundle.capsule.current ?? null).toBeNull();
      expect(JSON.stringify(bundle)).not.toContain(legacy);
    }
  });

  it('NIT-2: a failing invalid-row count degrades to null in system status', async () => {
    const original = manager().countInvalidEntityRows;
    manager().countInvalidEntityRows = () => { throw new Error('count failed'); };
    try {
      const status = await manager().getSystemStatus();
      expect(status.sqlite.connected).toBe(true);
      expect(status.sqlite.invalidEntityRows).toBeNull();
    } finally {
      manager().countInvalidEntityRows = original;
    }
    expect(typeof (await manager().getSystemStatus()).sqlite.invalidEntityRows).toBe('number');
  });
});

describe('exact-owner cache sees a same-connection table swap (PR #36 round 4, F1)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('after ALTER TABLE ... RENAME swaps shared_memory, a shared name is ambiguous again and checkpoint writes nothing', async () => {
    const manager = server.getMemoryManager() as any;
    const db = server.getMemoryManager().getDb();
    const shared = `swap-shared-${s}`;
    const a = `swap-a-${s}`;
    await (server as any)._handleToolCall('create_entities', {
      entities: [
        { name: a, entityType: 'project', observations: [], aliases: [shared] },
        { name: shared, entityType: 'project', observations: [], aliases: [] },
      ],
    });
    const names = () => [...new Set(manager.resolveEntityCandidatesExact(shared, 'default').map((c: any) => c.name))].sort();
    db.exec('CREATE TABLE replacement AS SELECT * FROM shared_memory');
    const aId = (db.prepare(`SELECT id FROM shared_memory WHERE json_extract(content, '$.name') = ?`).get(a) as any).id;
    db.prepare(`UPDATE shared_memory SET content = json_set(content, '$.aliases', json('[]')) WHERE id = ?`).run(aId);
    expect(names()).toEqual([shared]); // warms a B-only catalog
    db.exec(`BEGIN;
      ALTER TABLE shared_memory RENAME TO old_entities;
      ALTER TABLE replacement RENAME TO shared_memory;
      COMMIT;`);
    expect(names()).toEqual([a, shared].sort());
    const before = (db.prepare('SELECT COUNT(*) AS c FROM eng4_state_snapshots').get() as any).c;
    const result = await (server as any)._handleToolCall('checkpoint', {
      agentId: 'swap-agent', scope: { project: shared }, expectedRevision: null, idempotencyKey: `swap-${s}`,
      state: { objective: 'o', status: 's', owner: 'swap-agent', nextActions: [], blockers: [], guardrails: [] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ambiguous/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM eng4_state_snapshots').get() as any).c).toBe(before);
  });
});

/**
 * PR #36 round 5: a TEMP table can shadow shared_memory for every unqualified
 * reader without moving total_changes() or the main schema_version, so the
 * cache stamp includes temp.schema_version. Search must not crash on (or
 * list under) a non-string name, and the two readers that derive keys from a
 * stored name skip non-string names.
 */
describe('exact-owner cache sees a TEMP table shadowing shared_memory (PR #36 round 5)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('creating a TEMP shadow rebuilds the catalog (ambiguous, checkpoint refused); dropping it rebuilds again', async () => {
    const manager = server.getMemoryManager() as any;
    const db = server.getMemoryManager().getDb();
    const shared = `tmp-shared-${s}`;
    const a = `tmp-a-${s}`;
    const call = async (toolName: string, args: Record<string, any>) => (server as any)._handleToolCall(toolName, args);
    await call('create_entities', {
      entities: [
        { name: a, entityType: 'project', observations: [], aliases: [shared] },
        { name: shared, entityType: 'project', observations: [], aliases: [] },
      ],
    });
    const names = () => [...new Set(manager.resolveEntityCandidatesExact(shared, 'default').map((c: any) => c.name))].sort();
    const bId = (db.prepare(`SELECT id FROM shared_memory WHERE json_extract(content, '$.name') = ?`).get(shared) as any).id;
    const aId = (db.prepare(`SELECT id FROM shared_memory WHERE json_extract(content, '$.name') = ?`).get(a) as any).id;
    db.exec('CREATE TABLE main.shadow_copy AS SELECT * FROM main.shared_memory'); // A still holds the alias here
    db.prepare(`UPDATE main.shared_memory SET content = json_set(content, '$.aliases', json('[]')) WHERE id = ?`).run(aId);
    expect(names()).toEqual([shared]); // warms a B-only catalog
    const snapshots = () => (db.prepare('SELECT COUNT(*) AS c FROM eng4_state_snapshots').get() as any).c as number;
    const before = snapshots();

    // (create) the TEMP table hides the real one: A holds the alias again.
    db.exec('CREATE TEMP TABLE shared_memory AS SELECT * FROM main.shadow_copy');
    expect(names()).toEqual([a, shared].sort());
    for (const version of [2, 3]) {
      const result = await call('resume', { agentId: 'tmp-agent', scope: { project: shared }, budget: 8000, resultVersion: version });
      const bundle = JSON.parse(result.content[0].text);
      expect(bundle.resolvedScope.scopeKey).toBeNull();
      expect(bundle.resolvedScope.ambiguousCandidates).toEqual([a, shared].sort());
    }
    const refused = await call('checkpoint', {
      agentId: 'tmp-agent', scope: { project: shared }, expectedRevision: null, idempotencyKey: `tmp-${s}`,
      state: { objective: 'o', status: 's', owner: 'tmp-agent', nextActions: [], blockers: [], guardrails: [] },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/ambiguous/);
    expect(snapshots()).toBe(before);

    // (drop) the real table is visible again: B alone.
    db.exec('DROP TABLE temp.shared_memory');
    expect(names()).toEqual([shared]);
    const result = await call('resume', { agentId: 'tmp-agent', scope: { project: shared }, budget: 8000, resultVersion: 2 });
    expect(JSON.parse(result.content[0].text).resolvedScope.projectId).toBe(bId);
  });
});

describe('search and key-deriving readers with a non-string entity name (PR #36 round 5)', () => {
  let server: NeuralMCPServer;
  const s = Date.now();
  const call = async (toolName: string, args: Record<string, any>) => {
    const result = await (server as any)._handleToolCall(toolName, args);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  };

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('search_entities (exact, semantic, hybrid) does not crash on an imported array name and never lists it under that name', async () => {
    const name = `srch-imported-${s}`;
    await (server.getMemoryManager() as any).importEntities({
      schemaVersion: 1,
      entities: [{
        id: `srch-${s}`,
        content: JSON.stringify({ name: [name], entityType: ['project'], aliases: [], metadata: { aliases: [name] } }),
        created_by: 'r5', tags: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
      observations: [],
      relations: [],
    }, 'default');
    for (const searchType of ['exact', 'semantic', 'hybrid']) {
      const found = await call('search_entities', { query: name, searchType, compact: false });
      const text = JSON.stringify(found);
      expect(text).not.toContain(`"canonicalEntityName":["${name}"]`);
      for (const r of found.results ?? []) {
        expect(r.canonicalEntityName === undefined || typeof r.canonicalEntityName === 'string').toBe(true);
      }
    }
  });

  it('observation lookup and related-context keys never derive keys from a non-string name', async () => {
    const orig = `kd-orig-${s}`;
    const alias = `kd-alias-${s}`;
    const arrName = `kd-arr-${s}`;
    await call('create_entities', { entities: [{ name: orig, entityType: 'project', observations: [], aliases: [alias] }] });
    const manager = server.getMemoryManager() as any;
    const db = server.getMemoryManager().getDb();
    const id = (db.prepare(`SELECT id FROM shared_memory WHERE json_extract(content, '$.name') = ?`).get(orig) as any).id;
    // The name becomes an array without a reindex; the alias index row stays.
    db.prepare(`UPDATE shared_memory SET content = json_set(content, '$.name', json(?)) WHERE id = ?`).run(JSON.stringify([arrName]), id);
    const stray = (await call('add_observations', { observations: [{ entityName: arrName, contents: ['filed under the array name text'] }] }))
      .observations[0].id as string;
    // entityNameLookupValuesForQuery: the entity found through its alias must
    // not contribute String(["kd-arr-…"]) as a lookup value.
    expect([...manager.entityNameLookupValuesForQuery(alias, 'default')]).not.toContain(arrName);
    expect(manager.findObservationsByEntityOrAlias(alias, 'default').map((r: any) => r.id)).not.toContain(stray);
    // related-context lookup keys for the resolved entity: aliases only.
    const keys = manager.relatedContextEntityLookupKeys(alias, 'default', id);
    expect(keys.entityId).toBe(id);
    expect(keys.lookupKeys).toContain(alias);
    expect(keys.lookupKeys).not.toContain(arrName);
  });
});

/**
 * PR #36 round 6 (C1): no cross-call owner cache. Each operation runs on one
 * owner snapshot (MemoryManager.withOwnerSnapshot): one transaction, one
 * catalog build per tenant while nothing has been written, fresh reads after
 * any write, nothing retained after the call.
 */
describe('owner snapshot per operation (PR #36 round 6, C1)', () => {
  let server: NeuralMCPServer;
  let tmpDir = '';
  const s = Date.now();
  const agentId = 'snap-agent';
  const call = async (toolName: string, args: Record<string, any>) => {
    const result = await (server as any)._handleToolCall(toolName, args);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  };
  const manager = () => server.getMemoryManager() as any;
  const db = () => server.getMemoryManager().getDb();
  const create = (entities: Array<{ name: string; aliases?: string[] }>) =>
    call('create_entities', {
      entities: entities.map((e) => ({ name: e.name, entityType: 'project', observations: [], aliases: e.aliases ?? [] })),
    });
  const idOf = (name: string) =>
    (db().prepare(`SELECT id FROM shared_memory WHERE memory_type = 'entity' AND json_valid(content) AND json_extract(content, '$.name') = ?`).get(name) as any).id as string;
  const names = (ref: string) => [...new Set(manager().resolveEntityCandidatesExact(ref, 'default').map((c: any) => c.name))].sort();
  const setAliases = (id: string, aliases: string[]) =>
    db().prepare(`UPDATE shared_memory SET content = json_set(content, '$.aliases', json(?)) WHERE id = ?`).run(JSON.stringify(aliases), id);

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsib-r6-'));
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds the owner catalog once per resume (v2, v3) and once per checkpoint', async () => {
    const scope = `cnt-${s}`;
    await create([{ name: scope, aliases: [`cnt-alias-${s}`] }, { name: `cnt-${s}-v3` }]);
    for (const [entityName, kind] of [[scope, 'capsule'], [`cnt-alias-${s}`, 'decision'], [`${scope} LLC`, 'note'], [`cnt-${s}-v9`, 'capsule']]) {
      await call('add_observations', { observations: [{ entityName, contents: [`${kind} row`], kind }] });
    }
    for (const resultVersion of [2, 3]) {
      manager().ownerCatalogBuilds = 0;
      const bundle = await call('resume', { agentId, scope: { project: scope }, budget: 8000, resultVersion });
      expect(bundle.resolvedScope.projectId).toBe(idOf(scope));
      expect(bundle.capsule.candidatesConsidered).toBeGreaterThan(0);
      expect(manager().ownerCatalogBuilds).toBe(1);
    }
    manager().ownerCatalogBuilds = 0;
    const written = await call('checkpoint', {
      agentId, scope: { project: scope }, expectedRevision: null, idempotencyKey: `cnt-ckpt-${s}`,
      state: { objective: 'o', status: 's', owner: agentId, nextActions: [], blockers: [], guardrails: [] },
    });
    expect(written.outcome).toBe('written');
    expect(manager().ownerCatalogBuilds).toBe(1);
    expect(manager().ownerSnapshot).toBeNull();
  });

  it('a catalog built after a write inside a savepoint is not reused after ROLLBACK TO / RELEASE', async () => {
    const shared = `sp-shared-${s}`;
    const a = `sp-a-${s}`;
    await create([{ name: a, aliases: [shared] }, { name: shared }]);
    const aId = idOf(a);
    manager().withOwnerSnapshot(() => {
      try {
        db().transaction(() => {
          setAliases(aId, []);
          expect(names(shared)).toEqual([shared]); // built after the write
          throw new Error('rollback to savepoint');
        })();
      } catch { /* rolled back: A holds the alias again */ }
      expect(names(shared)).toEqual([a, shared].sort());
    });
    expect(names(shared)).toEqual([a, shared].sort());

    const shared2 = `sp2-shared-${s}`;
    const a2 = `sp2-a-${s}`;
    await create([{ name: a2, aliases: [shared2] }, { name: shared2 }]);
    const a2Id = idOf(a2);
    manager().withOwnerSnapshot(() => {
      expect(names(shared2)).toEqual([a2, shared2].sort()); // kept (no write yet)
      db().transaction(() => { setAliases(a2Id, []); })(); // RELEASE: the change stays
      expect(names(shared2)).toEqual([shared2]);
    });
    expect(names(shared2)).toEqual([shared2]);
  });

  it('after a write inside the snapshot (project skeleton insert) later lookups read fresh', async () => {
    const key = `skel6-${s}`;
    manager().withOwnerSnapshot(() => {
      expect(names(key)).toEqual([]);
      manager().ensureProjectEntity(agentId, key, 'default');
      expect(names(key)).toEqual([key]);
    });
  });

  it('nothing survives across calls: a commit from another connection is seen by the next call', async () => {
    const shared = `xc-shared-${s}`;
    const a = `xc-a-${s}`;
    await create([{ name: a, aliases: [shared] }, { name: shared }]);
    expect(names(shared)).toEqual([a, shared].sort());
    expect(manager().ownerSnapshot).toBeNull();
    const other = new Database(path.join(tmpDir, 'test.db'));
    try {
      other.prepare(`UPDATE shared_memory SET content = json_set(content, '$.aliases', json('[]')) WHERE id = ?`).run(idOf(a));
    } finally {
      other.close();
    }
    expect(names(shared)).toEqual([shared]);
  });
});
