/**
 * Field feedback P1 item 4: exact-name ranking in search_entities.
 *
 * Field report: search_entities("ascend-website", searchType:"exact") listed
 * prefix-related entities (newer "ascend-website-*" projects) ABOVE the entity
 * actually named "ascend-website". The lookup index stores derived name
 * variants (first segments, initials, suffixes) at the same weight as the name
 * itself, so all of them were "exact" hits with the same score and the newest
 * won. Results now carry matchKind (exact | exact-ci | prefix | related) and
 * relevance order is matchKind first, then searchScore.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

const RANK: Record<string, number> = { exact: 3, 'exact-ci': 2, prefix: 1, related: 0 };

describe('search_entities matchKind and exact-name ranking', () => {
  let server: NeuralMCPServer;
  const suffix = Date.now();
  const base = `c4-site-${suffix}`;
  const prefixA = `${base}-redesign`;
  const prefixB = `${base}-launch`;
  const spaced = `C4 Site ${suffix}`;
  const aliasHolder = `c4-alias-holder-${suffix}`;
  const mentioner = `c4-mentioner-${suffix}`;
  const topic = `c4-topic-${suffix}`;
  const topicChild = `${topic}-child`;
  const big = `c4-big-${suffix}`;

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
    // The canonical entity is created FIRST, so every prefix-related entity is newer.
    await mcpCall(server, 'create_entities', { entities: [{ name: base, entityType: 'project', observations: [] }] });
    await mcpCall(server, 'create_entities', {
      entities: [
        { name: prefixA, entityType: 'project', observations: [] },
        { name: prefixB, entityType: 'project', observations: [] },
        { name: spaced, entityType: 'project', observations: [] },
        { name: aliasHolder, entityType: 'project', observations: [], aliases: [base] },
        { name: mentioner, entityType: 'note', observations: [] },
      ],
    });
    await mcpCall(server, 'add_observations', {
      observations: [
        { entityName: base, contents: ['canonical project decision'] },
        { entityName: prefixA, contents: ['redesign detail'] },
        { entityName: mentioner, contents: [`see ${base} for the plan`] },
      ],
    });
    // The name is only a prefix match for `topic`, but a declared alias equals it.
    await mcpCall(server, 'create_entities', {
      entities: [
        { name: topicChild, entityType: 'project', observations: [], aliases: [topic] },
        { name: big, entityType: 'project', observations: [] },
      ],
    });
    // Large enough (>= 2KB) to take the compact envelope.
    await mcpCall(server, 'add_observations', {
      observations: [{ entityName: big, contents: ['large '.padEnd(3000, 'y')] }],
    });
    await mcpCall(server, 'create_relations', {
      relations: [{ from: base, to: prefixA, relationType: 'c4_parent_of' }],
    });
    const db = server.getMemoryManager().getDb();
    // Make the newest-first tie-break of the old ordering visible: the canonical row is the oldest.
    db.prepare("UPDATE shared_memory SET created_at = '2020-01-01 00:00:00' WHERE memory_type = 'entity' AND json_extract(content, '$.name') = ?").run(base);
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  const kindOf = (results: any[], name: string, memoryType = 'entity') =>
    results.find((r) => (r.canonicalEntityName ?? r.name) === name && (r.storageMemoryType ?? r.memoryType) === memoryType)?.matchKind;

  it('the entity named exactly as the query ranks first, above newer prefix-related entities', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base, searchType: 'exact', memoryTypes: ['entity'] });
    expect(page.results[0].canonicalEntityName).toBe(base);
    expect(page.results[0].matchKind).toBe('exact');
    const names = page.results.map((r: any) => r.canonicalEntityName);
    expect(names).toEqual(expect.arrayContaining([prefixA, prefixB]));
    expect(kindOf(page.results, prefixA)).toBe('prefix');
    expect(kindOf(page.results, prefixB)).toBe('prefix');
  });

  it('labels case/separator equality and declared aliases exact-ci, ranked between exact and prefix', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base, searchType: 'exact', memoryTypes: ['entity'] });
    expect(kindOf(page.results, spaced)).toBe('exact-ci');
    expect(kindOf(page.results, aliasHolder)).toBe('exact-ci');
    const kinds = page.results.map((r: any) => r.matchKind);
    expect(kinds.slice(0, 3)).toEqual(['exact', 'exact-ci', 'exact-ci']);
  });

  it('results are ordered by matchKind across memory types; observations follow their entity name', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base, searchType: 'exact', compact: false });
    const ranks = page.results.map((r: any) => RANK[r.matchKind]);
    expect(ranks.every((rank: number) => typeof rank === 'number')).toBe(true);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(kindOf(page.results, base, 'observation')).toBe('exact');
    expect(kindOf(page.results, prefixA, 'observation')).toBe('prefix');
    // Matched only through a handle in prose: related, and last.
    expect(kindOf(page.results, mentioner, 'observation')).toBe('related');
    expect(page.results[page.results.length - 1].matchKind).toBe('related');
  });

  it('a case-different query makes no row "exact", and the normalized match leads', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base.toUpperCase(), searchType: 'exact', memoryTypes: ['entity'] });
    expect(page.results.some((r: any) => r.matchKind === 'exact')).toBe(false);
    expect(page.results[0].matchKind).toBe('exact-ci');
    expect([base, spaced, aliasHolder]).toContain(page.results[0].canonicalEntityName);
    expect(kindOf(page.results, prefixA)).toBe('prefix');
  });

  it('a lone prefix query labels the longer names prefix, never exact', async () => {
    const page = await mcpCall(server, 'search_entities', { query: 'c4-site', searchType: 'exact', memoryTypes: ['entity'] });
    expect(page.results.length).toBeGreaterThan(0);
    for (const r of page.results) {
      expect(Object.keys(RANK)).toContain(r.matchKind);
      expect(r.matchKind).not.toBe('exact');
    }
    for (const name of [base, prefixA, prefixB]) {
      const kind = kindOf(page.results, name);
      if (kind !== undefined) expect(kind).toBe('prefix');
    }
  });

  it('a declared alias equal to the query is exact-ci even when the name is only a prefix match', async () => {
    const page = await mcpCall(server, 'search_entities', { query: topic, searchType: 'exact', memoryTypes: ['entity'] });
    expect(kindOf(page.results, topicChild)).toBe('exact-ci');
    expect(page.results[0].canonicalEntityName).toBe(topicChild);
  });

  it('a relation takes the best of from/to', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base, searchType: 'exact', memoryTypes: ['relation'], compact: false });
    const rel = page.results.find((r: any) => r.content?.relationType === 'c4_parent_of' || r.storageMemoryType === 'relation');
    expect(rel).toBeDefined();
    expect(rel.matchKind).toBe('exact');
  });

  it('the compact envelope carries matchKind', async () => {
    const page = await mcpCall(server, 'search_entities', { query: big, searchType: 'exact', memoryTypes: ['observation'] });
    const compacted = page.results.find((r: any) => r._compacted);
    expect(compacted).toBeDefined();
    expect(compacted.matchKind).toBe('exact');
  });

  for (const searchType of ['hybrid', 'semantic']) {
    it(`${searchType} broad fallback (no name anchor) keeps pure searchScore order`, async () => {
      const query = `c4 zebra quartz ${suffix}`;
      const prefixNamed = `c4-zebra-quartz-${suffix}-child`;
      const manager = server.getMemoryManager();
      const spy = vi.spyOn(manager, 'search').mockResolvedValue([
        { id: `r-unrelated-${suffix}`, type: 'shared', memoryType: 'entity', content: { name: `c4-unrelated-${suffix}`, entityType: 'project', observations: [] }, timestamp: '2026-01-02T00:00:00Z', semanticSimilarity: 0.95 },
        { id: `r-prefix-${suffix}`, type: 'shared', memoryType: 'entity', content: { name: prefixNamed, entityType: 'project', observations: [] }, timestamp: '2026-01-01T00:00:00Z', semanticSimilarity: 0.3 },
      ] as any);
      try {
        const page = await mcpCall(server, 'search_entities', { query, searchType, compact: false });
        expect(spy).toHaveBeenCalled();
        const rows = page.results.map((r: any) => ({ name: r.canonicalEntityName, kind: r.matchKind, score: r.searchScore }));
        expect(rows.map((r: any) => r.name)).toEqual([`c4-unrelated-${suffix}`, prefixNamed]);
        expect(rows[0].score).toBeGreaterThan(rows[1].score);
        // Still labelled, just not used for ordering.
        expect(rows.map((r: any) => r.kind)).toEqual(['related', 'prefix']);
      } finally {
        spy.mockRestore();
      }
    });
  }

  it('sortBy:recency still wins over matchKind when explicitly requested', async () => {
    const page = await mcpCall(server, 'search_entities', { query: base, searchType: 'exact', memoryTypes: ['entity'], sortBy: 'recency' });
    expect(page.results[0].canonicalEntityName).not.toBe(base);
    expect(page.results.find((r: any) => r.canonicalEntityName === base).matchKind).toBe('exact');
  });

  it('the schema documents matchKind and anchor-vs-identity', () => {
    const search = UnifiedToolSchemas.search_entities;
    expect(search.description).toMatch(/matchKind/);
    expect(search.description).toMatch(/name-ANCHORED, not an identity lookup/);
  });
});
