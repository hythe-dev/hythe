/**
 * Generic discover_related_context contract.
 *
 * The fixtures deliberately use only synthetic alpha/beta domains. The tool
 * must derive candidates from tenant data; no project, organization, or
 * relation vocabulary belongs in production code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { SqliteVecClient } from '../src/memory/sqlite-vec-client.js';
import type { RequestContext } from '../src/middleware/auth/types.js';

type ToolInvocation = {
  result: any;
  payload: any;
  text: string;
};

type SemanticEnvelope = {
  results: any[];
  degraded: boolean;
  reasons: string[];
};

const TENANT_ALPHA = 'tenant-alpha';
const TENANT_BETA = 'tenant-beta';

function requestContext(tenantId: string, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId,
    userId: null,
    authType: 'dev',
    apiKeyId: null,
    idpSub: null,
    roles: [],
    scopes: ['*'],
    mfaLevel: null,
    timezoneHint: null,
    agentPrincipal: null,
    agentCredentialPresented: false,
    agentAuthMode: 'observe',
    ...overrides,
  };
}

async function invokeRaw(
  server: NeuralMCPServer,
  name: string,
  args: Record<string, unknown>,
  context: RequestContext,
): Promise<ToolInvocation> {
  const result = await (server as any)._handleToolCall(name, args, context);
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Tool ${name} did not return MCP text content`);
  }
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Preserve the raw response so a missing handler produces an informative
    // red failure instead of hiding behind a JSON parse exception.
  }
  return { result, payload, text };
}

async function callOk(
  server: NeuralMCPServer,
  name: string,
  args: Record<string, unknown>,
  context: RequestContext,
): Promise<any> {
  const call = await invokeRaw(server, name, args, context);
  if (call.result?.isError || call.payload === null) {
    throw new Error(`Tool ${name} failed: ${call.text}`);
  }
  return call.payload;
}

function semanticObservation(observation: any, similarity: number): any {
  return {
    id: observation.id,
    type: 'shared',
    content: {
      entityName: observation.entityName,
      contents: observation.contents,
      addedBy: observation.addedBy,
      timestamp: observation.timestamp,
      metadata: observation.metadata,
    },
    relevance: similarity,
    semanticSimilarity: similarity,
    source: `sqlite-vec:${observation.addedBy ?? 'alpha-fixture'}`,
    timestamp: new Date(observation.timestamp),
    memoryType: 'observation',
  };
}

function semanticEntity(entity: any, similarity: number): any {
  return {
    id: entity.id,
    type: 'shared',
    content: {
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases ?? [],
      observations: [],
    },
    relevance: similarity,
    semanticSimilarity: similarity,
    source: 'sqlite-vec:alpha-fixture',
    timestamp: new Date(entity.timestamp),
    memoryType: 'entity',
  };
}

function nodeNames(path: any): string[] {
  return (path?.nodes ?? []).map((node: any) => typeof node === 'string' ? node : node?.name);
}

function installSemanticSearch(
  server: NeuralMCPServer,
  implementation: (query: string, tenantId: string, limit: number) => Promise<SemanticEnvelope>,
) {
  const manager = server.getMemoryManager() as any;
  const original = manager.searchRelatedContextSemantic;
  const mock = vi.fn(implementation);
  manager.searchRelatedContextSemantic = mock;
  return {
    mock,
    restore() {
      manager.searchRelatedContextSemantic = original;
    },
  };
}

describe('discover_related_context generic read-only contract', () => {
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const names = {
    scope: `alpha-project-${tag}`,
    scopeAlias: `alpha-workspace-${tag}`,
    ambiguousAlias: `alpha-ambiguous-${tag}`,
    direct: `alpha-direct-pattern-${tag}`,
    bridge: `alpha-bridge-${tag}`,
    twoHop: `alpha-two-hop-pattern-${tag}`,
    semanticOnly: `alpha-semantic-pattern-${tag}`,
    evidence: `alpha-evidence-pattern-${tag}`,
    tieA: `alpha-tie-a-${tag}`,
    tieB: `alpha-tie-b-${tag}`,
    betaPrivate: `beta-private-pattern-${tag}`,
  };
  const alphaContext = requestContext(TENANT_ALPHA);
  const betaContext = requestContext(TENANT_BETA);
  let server: NeuralMCPServer;
  let previousAdvancedMemory: string | undefined;
  let entities: Record<string, any>;
  let observations: Record<string, any>;
  let limitEntities: any[];

  beforeAll(async () => {
    previousAdvancedMemory = process.env.ENABLE_ADVANCED_MEMORY;
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');

    const alphaCreated = await callOk(server, 'create_entities', {
      entities: [
        { name: names.scope, entityType: 'project', aliases: [names.scopeAlias], observations: [] },
        { name: names.direct, entityType: 'pattern', observations: [] },
        { name: names.bridge, entityType: 'component', observations: [] },
        { name: names.twoHop, entityType: 'pattern', observations: [] },
        { name: names.semanticOnly, entityType: 'pattern', observations: [] },
        { name: names.evidence, entityType: 'pattern', observations: [] },
        { name: names.tieA, entityType: 'pattern', observations: [] },
        { name: names.tieB, entityType: 'pattern', observations: [] },
        { name: `alpha-ambiguous-one-${tag}`, entityType: 'project', aliases: [names.ambiguousAlias], observations: [] },
        { name: `alpha-ambiguous-two-${tag}`, entityType: 'project', aliases: [names.ambiguousAlias], observations: [] },
      ],
    }, alphaContext);
    entities = Object.fromEntries(alphaCreated.entities.map((entity: any) => [entity.name, entity]));

    const added = await callOk(server, 'add_observations', {
      observations: [
        { entityName: names.direct, contents: ['adaptive orchestration pattern alpha'] },
        { entityName: names.twoHop, contents: ['adaptive orchestration pattern beta'] },
        { entityName: names.semanticOnly, contents: ['adaptive orchestration pattern gamma'] },
        { entityName: names.tieA, contents: ['equal semantic tie pattern'] },
        { entityName: names.tieB, contents: ['equal semantic tie pattern'] },
      ],
    }, alphaContext);
    observations = Object.fromEntries(added.observations.map((observation: any) => [observation.entityName, observation]));

    const evidenceHistory = await callOk(server, 'add_observations', {
      observations: [
        {
          entityName: names.evidence,
          contents: ['historical unmarked state'],
          metadata: { evidenceRefs: ['evidence:alpha-historical'] },
        },
        {
          entityName: names.evidence,
          contents: ['explicitly superseded state'],
          metadata: { evidenceRefs: ['evidence:alpha-superseded'] },
        },
      ],
    }, alphaContext);
    const historical = evidenceHistory.observations[0];
    const superseded = evidenceHistory.observations[1];
    const evidenceCurrent = await callOk(server, 'add_observations', {
      observations: [{
        entityName: names.evidence,
        contents: ['current validated state'],
        kind: 'decision',
        canonicalFact: 'alpha current fact',
        supersedes: [superseded.id],
        metadata: {
          evidenceRefs: ['evidence:alpha-current'],
          sourceRefs: ['source:alpha-current'],
          contradictions: ['fact:alpha-conflict'],
        },
      }],
    }, alphaContext);
    observations.evidenceHistorical = historical;
    observations.evidenceSuperseded = superseded;
    observations.evidenceCurrent = evidenceCurrent.observations[0];

    await callOk(server, 'create_relations', {
      relations: [
        { from: names.scope, to: names.direct, relationType: 'uses_pattern' },
        { from: names.scope, to: names.bridge, relationType: 'depends_on' },
        { from: names.bridge, to: names.twoHop, relationType: 'documents' },
        { from: names.scope, to: names.evidence, relationType: 'validates' },
        { from: names.scope, to: names.tieA, relationType: 'compares' },
        { from: names.scope, to: names.tieB, relationType: 'compares' },
      ],
    }, alphaContext);

    const bulk = await callOk(server, 'create_entities', {
      entities: Array.from({ length: 30 }, (_, index) => ({
        name: `alpha-limit-${String(index).padStart(2, '0')}-${tag}`,
        entityType: 'pattern',
        observations: [],
      })),
    }, alphaContext);
    limitEntities = bulk.entities;

    const betaCreated = await callOk(server, 'create_entities', {
      entities: [
        { name: names.scope, entityType: 'project', aliases: [names.scopeAlias], observations: [] },
        { name: names.betaPrivate, entityType: 'pattern', observations: [] },
      ],
    }, betaContext);
    entities.betaScope = betaCreated.entities.find((entity: any) => entity.name === names.scope);
    entities.betaPrivate = betaCreated.entities.find((entity: any) => entity.name === names.betaPrivate);
    const betaAdded = await callOk(server, 'add_observations', {
      observations: [{ entityName: names.betaPrivate, contents: ['beta tenant private pattern'] }],
    }, betaContext);
    observations.betaPrivate = betaAdded.observations[0];
    await callOk(server, 'create_relations', {
      relations: [{ from: names.scope, to: names.betaPrivate, relationType: 'uses_pattern' }],
    }, betaContext);
  });

  afterAll(async () => {
    await server.close();
    if (previousAdvancedMemory === undefined) delete process.env.ENABLE_ADVANCED_MEMORY;
    else process.env.ENABLE_ADVANCED_MEMORY = previousAdvancedMemory;
  });

  it('advertises a domain-neutral, exact-scope, bounded read contract', async () => {
    const listed = await (server as any)._handleToolsList();
    const tool = listed.tools.find((candidate: any) => candidate.name === 'discover_related_context');

    expect(tool).toBeDefined();
    expect(tool.description.toLowerCase()).toContain('read-only');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'intent'],
    });
    expect(tool.inputSchema.properties.scope.properties).toHaveProperty('project');
    expect(tool.inputSchema.properties.scope.properties).toHaveProperty('task');
    expect(tool.inputSchema.properties.candidateLimit).toMatchObject({ minimum: 1, maximum: 25, default: 10 });
    expect(tool.inputSchema.properties.graphDepth).toMatchObject({ minimum: 1, maximum: 2, default: 1 });
    expect(tool.inputSchema.properties.budget).toMatchObject({ minimum: 256, maximum: 12000, default: 3000 });
    expect(tool.inputSchema.properties).not.toHaveProperty('tenantId');
    expect(tool.inputSchema.properties).not.toHaveProperty('agentId');
  });

  it('resolves an exact canonical name or alias and fails closed before retrieval for unknown or ambiguous scopes', async () => {
    const semantic = installSemanticSearch(server, async () => ({ results: [], degraded: false, reasons: [] }));
    try {
      const exact = await callOk(server, 'discover_related_context', {
        scope: { project: names.scopeAlias },
        intent: 'find reusable alpha patterns',
      }, alphaContext);
      expect(exact.error).toBeUndefined();
      expect(exact.resolvedScope).toMatchObject({
        projectId: entities[names.scope].id,
        taskId: null,
      });
      expect(exact.resolvedScope.scopeKey).toBe(`p:${entities[names.scope].id}`);
      expect(exact.resolvedScope.aliasesMatched).toContain(names.scopeAlias);
      expect(semantic.mock).toHaveBeenCalledTimes(1);

      semantic.mock.mockClear();
      const unknown = await callOk(server, 'discover_related_context', {
        scope: { project: `alpha-unknown-${tag}` },
        intent: 'must not search broadly',
      }, alphaContext);
      expect(unknown.error).toMatchObject({ code: 'SCOPE_NOT_FOUND' });
      expect(unknown.resolvedScope.scopeKey).toBeNull();
      expect(unknown.candidates).toEqual([]);
      expect(unknown.coverage).toMatchObject({ examinedCount: 0, rankedCount: 0, returnedCount: 0 });
      expect(semantic.mock).not.toHaveBeenCalled();

      const ambiguous = await callOk(server, 'discover_related_context', {
        scope: { project: names.ambiguousAlias },
        intent: 'must also fail before retrieval',
      }, alphaContext);
      expect(ambiguous.error).toMatchObject({ code: 'SCOPE_AMBIGUOUS' });
      expect(ambiguous.resolvedScope.scopeKey).toBeNull();
      expect(ambiguous.resolvedScope.ambiguousCandidates).toHaveLength(2);
      expect(ambiguous.candidates).toEqual([]);
      expect(ambiguous.coverage).toMatchObject({ examinedCount: 0, rankedCount: 0, returnedCount: 0 });
      expect(semantic.mock).not.toHaveBeenCalled();
    } finally {
      semantic.restore();
    }
  });

  it('keeps an ambiguous error envelope within the hard budget without truncating identifiers', async () => {
    const longAlias = `alpha-budget-ambiguous-${tag}`;
    const longStem = `alpha-${'identifier-'.repeat(180)}`;
    await callOk(server, 'create_entities', {
      entities: [
        { name: `${longStem}one`, entityType: 'project', aliases: [longAlias], observations: [] },
        { name: `${longStem}two`, entityType: 'project', aliases: [longAlias], observations: [] },
      ],
    }, alphaContext);

    const semantic = installSemanticSearch(server, async () => ({ results: [], degraded: false, reasons: [] }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: longAlias },
        intent: 'bounded ambiguity response',
        budget: 256,
      }, alphaContext);

      expect(result.error).toMatchObject({ code: 'SCOPE_AMBIGUOUS', candidateCount: 2 });
      expect(result.resolvedScope.ambiguousCandidateCount).toBe(2);
      expect(result.resolvedScope.ambiguousCandidates).toEqual([]);
      expect(result.coverage.tokenEstimate).toBeLessThanOrEqual(256);
      expect(semantic.mock).not.toHaveBeenCalled();
    } finally {
      semantic.restore();
    }
  });

  it('combines semantic candidates with direct and two-hop graph reranking and explains every score', async () => {
    const equalSimilarity = 0.82;
    const semantic = installSemanticSearch(server, async () => ({
      results: [
        semanticObservation(observations[names.semanticOnly], equalSimilarity),
        semanticObservation(observations[names.twoHop], equalSimilarity),
        semanticObservation(observations[names.direct], equalSimilarity),
      ],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'adaptive orchestration pattern',
        candidateLimit: 25,
        graphDepth: 2,
        budget: 12000,
      }, alphaContext);

      const direct = result.candidates.find((candidate: any) => candidate.entity.name === names.direct);
      const twoHop = result.candidates.find((candidate: any) => candidate.entity.name === names.twoHop);
      const semanticOnly = result.candidates.find((candidate: any) => candidate.entity.name === names.semanticOnly);
      expect(direct).toBeDefined();
      expect(twoHop).toBeDefined();
      expect(semanticOnly).toBeDefined();

      expect(direct.scores.semantic).toBeCloseTo(equalSimilarity);
      expect(twoHop.scores.semantic).toBeCloseTo(equalSimilarity);
      expect(semanticOnly.scores.semantic).toBeCloseTo(equalSimilarity);
      expect(direct.scores.graph).toBeGreaterThan(twoHop.scores.graph);
      expect(twoHop.scores.graph).toBeGreaterThan(semanticOnly.scores.graph);
      expect(direct.scores.combined).toBeGreaterThan(twoHop.scores.combined);
      expect(twoHop.scores.combined).toBeGreaterThan(semanticOnly.scores.combined);
      expect(direct.rank).toBeLessThan(twoHop.rank);
      expect(twoHop.rank).toBeLessThan(semanticOnly.rank);

      const directPath = direct.explanation.paths.find((path: any) => path.hops === 1);
      expect(nodeNames(directPath)).toEqual([names.scope, names.direct]);
      expect(directPath.edges).toEqual([
        expect.objectContaining({ from: names.scope, to: names.direct, relationType: 'uses_pattern' }),
      ]);
      const twoHopPath = twoHop.explanation.paths.find((path: any) => path.hops === 2);
      expect(nodeNames(twoHopPath)).toEqual([names.scope, names.bridge, names.twoHop]);
      expect(twoHopPath.edges.map((edge: any) => edge.relationType)).toEqual(['depends_on', 'documents']);
      expect(semanticOnly.explanation.paths).toEqual([]);
      expect(semanticOnly.explanation.semanticMatches).toEqual([
        expect.objectContaining({
          memoryId: observations[names.semanticOnly].id,
          memoryType: 'observation',
          similarity: equalSimilarity,
        }),
      ]);
    } finally {
      semantic.restore();
    }
  });

  it('labels current, explicitly superseded, and merely historical semantic hits without promoting stale evidence', async () => {
    const semantic = installSemanticSearch(server, async () => ({
      results: [
        semanticObservation(observations.evidenceHistorical, 0.96),
        semanticObservation(observations.evidenceSuperseded, 0.94),
        semanticObservation(observations.evidenceCurrent, 0.91),
      ],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'validated current evidence',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.name === names.evidence);
      expect(candidate).toBeDefined();
      expect(candidate.explanation.currentness.currentObservation).toMatchObject({
        id: observations.evidenceCurrent.id,
        kind: 'decision',
        canonicalFact: 'alpha current fact',
        contents: ['current validated state'],
      });

      const matched = Object.fromEntries(
        candidate.explanation.currentness.matchedObservations.map((item: any) => [item.id, item]),
      );
      expect(matched[observations.evidenceCurrent.id]).toMatchObject({ status: 'current', supersededBy: [] });
      expect(matched[observations.evidenceSuperseded.id]).toMatchObject({
        status: 'superseded',
        supersededBy: [observations.evidenceCurrent.id],
      });
      expect(matched[observations.evidenceHistorical.id]).toMatchObject({ status: 'historical', supersededBy: [] });

      expect(candidate.explanation.evidenceRefs).toEqual(['evidence:alpha-current']);
      expect(candidate.explanation.sourceRefs).toContain('source:alpha-current');
      expect(candidate.explanation.contradictions).toEqual(['fact:alpha-conflict']);
      expect(candidate.explanation.evidenceRefs).not.toContain('evidence:alpha-superseded');
      expect(candidate.explanation.evidenceRefs).not.toContain('evidence:alpha-historical');
      expect(candidate.explanation.provenance.map((row: any) => row.memoryId)).toEqual(
        expect.arrayContaining([
          observations.evidenceHistorical.id,
          observations.evidenceSuperseded.id,
          observations.evidenceCurrent.id,
        ]),
      );
    } finally {
      semantic.restore();
    }
  });

  it('uses the trusted tenant context for scope, semantic retrieval, graph expansion, and candidate hydration', async () => {
    const semantic = installSemanticSearch(server, async (_query, tenantId) => ({
      results: tenantId === TENANT_ALPHA
        ? [semanticObservation(observations[names.direct], 0.88)]
        : [semanticObservation(observations.betaPrivate, 0.88)],
      degraded: false,
      reasons: [],
    }));
    try {
      const alpha = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'tenant-local pattern',
        candidateLimit: 25,
        graphDepth: 1,
      }, alphaContext);
      const beta = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'tenant-local pattern',
        candidateLimit: 25,
        graphDepth: 1,
      }, betaContext);

      expect(alpha.resolvedScope.projectId).toBe(entities[names.scope].id);
      expect(beta.resolvedScope.projectId).toBe(entities.betaScope.id);
      expect(alpha.candidates.some((candidate: any) => candidate.entity.name === names.direct)).toBe(true);
      expect(alpha.candidates.some((candidate: any) => candidate.entity.name === names.betaPrivate)).toBe(false);
      expect(beta.candidates.some((candidate: any) => candidate.entity.name === names.betaPrivate)).toBe(true);
      expect(beta.candidates.some((candidate: any) => candidate.entity.name === names.direct)).toBe(false);
      expect(semantic.mock.mock.calls.map((call: any[]) => call[1])).toEqual([TENANT_ALPHA, TENANT_BETA]);
    } finally {
      semantic.restore();
    }
  });

  it('requires memory:read from a presented agent credential', async () => {
    const credentialBase = {
      agentId: 'alpha-agent',
      credentialId: 'alpha-credential',
      enforcementState: 'enforced' as const,
    };
    const deniedContext = requestContext(TENANT_ALPHA, {
      agentAuthMode: 'required',
      agentCredentialPresented: true,
      agentPrincipal: { ...credentialBase, scopes: ['state:read'] },
    });
    const denied = await invokeRaw(server, 'discover_related_context', {
      scope: { project: names.scope },
      intent: 'authorization check',
    }, deniedContext);
    expect(denied.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'Agent authorization failed',
        code: 'AGENT_SCOPE_REQUIRED',
      },
    });

    const semantic = installSemanticSearch(server, async () => ({ results: [], degraded: false, reasons: [] }));
    try {
      const allowedContext = requestContext(TENANT_ALPHA, {
        agentAuthMode: 'required',
        agentCredentialPresented: true,
        agentPrincipal: { ...credentialBase, scopes: ['memory:read'] },
      });
      const allowed = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'authorization check',
      }, allowedContext);
      expect(allowed.error).toBeUndefined();
    } finally {
      semantic.restore();
    }
  });

  it('defensively clamps compute and response limits even when schema validation is bypassed', async () => {
    const semantic = installSemanticSearch(server, async () => ({
      results: limitEntities.map((entity, index) => semanticEntity(entity, 0.9 - index / 1000)),
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'bounded alpha candidate set',
        candidateLimit: 999,
        graphDepth: 999,
        budget: 999_999,
      }, alphaContext);

      expect(result.coverage).toMatchObject({
        candidateLimit: 25,
        graphDepth: 2,
        requestedBudget: 999_999,
        budget: 12000,
        budgetClamped: true,
        returnedCount: 25,
        truncated: true,
        omittedReason: 'limit',
      });
      expect(result.candidates).toHaveLength(25);
      expect(result.coverage.tokenEstimate).toBeLessThanOrEqual(result.coverage.budget);
      expect(semantic.mock).toHaveBeenCalledTimes(1);
      expect(semantic.mock.mock.calls[0][2]).toBe(75);

      semantic.mock.mockResolvedValueOnce({ results: [], degraded: false, reasons: [] });
      const minimum = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'minimum response budget',
        candidateLimit: 25,
        graphDepth: 2,
        budget: 1,
      }, alphaContext);
      expect(minimum.coverage).toMatchObject({
        requestedBudget: 1,
        budget: 256,
        budgetClamped: true,
      });
      expect(minimum.coverage.tokenEstimate).toBeLessThanOrEqual(256);
    } finally {
      semantic.restore();
    }
  });

  it('uses stable score tie-breaks independent of semantic backend order', async () => {
    let reverse = false;
    const semantic = installSemanticSearch(server, async () => {
      reverse = !reverse;
      const rows = [
        semanticObservation(observations[names.tieA], 0.81),
        semanticObservation(observations[names.tieB], 0.81),
      ];
      return { results: reverse ? rows.reverse() : rows, degraded: false, reasons: [] };
    });
    try {
      const args = {
        scope: { project: names.scope },
        intent: 'equal tie pattern',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      };
      const first = await callOk(server, 'discover_related_context', args, alphaContext);
      const second = await callOk(server, 'discover_related_context', args, alphaContext);
      const tieIds = new Set([entities[names.tieA].id, entities[names.tieB].id]);
      const firstOrder = first.candidates.map((candidate: any) => candidate.entity.id).filter((id: string) => tieIds.has(id));
      const secondOrder = second.candidates.map((candidate: any) => candidate.entity.id).filter((id: string) => tieIds.has(id));
      const expected = [...tieIds].sort((left, right) => left.localeCompare(right));

      expect(firstOrder).toEqual(expected);
      expect(secondOrder).toEqual(expected);
      expect(firstOrder).toEqual(secondOrder);
    } finally {
      semantic.restore();
    }
  });

  it('performs no memory store, relation creation, audit, or other SQLite write', async () => {
    const manager = server.getMemoryManager() as any;
    const db = manager.getDb();
    const beforeChanges = (db.prepare('SELECT total_changes() AS value').get() as any).value;
    const beforeRelations = (db.prepare(
      "SELECT COUNT(*) AS value FROM shared_memory WHERE tenant_id = ? AND memory_type = 'relation'",
    ).get(TENANT_ALPHA) as any).value;
    const beforeAudit = (db.prepare('SELECT COUNT(*) AS value FROM neural_audit_log').get() as any).value;
    const store = vi.spyOn(manager, 'store');
    const semantic = installSemanticSearch(server, async () => ({
      results: [semanticObservation(observations[names.direct], 0.84)],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'read without durable relationship',
        candidateLimit: 25,
        graphDepth: 2,
      }, alphaContext);
      expect(result.writesPerformed).toBe(0);
      expect(store).not.toHaveBeenCalled();
      expect((db.prepare('SELECT total_changes() AS value').get() as any).value).toBe(beforeChanges);
      expect((db.prepare(
        "SELECT COUNT(*) AS value FROM shared_memory WHERE tenant_id = ? AND memory_type = 'relation'",
      ).get(TENANT_ALPHA) as any).value).toBe(beforeRelations);
      expect((db.prepare('SELECT COUNT(*) AS value FROM neural_audit_log').get() as any).value).toBe(beforeAudit);
    } finally {
      semantic.restore();
      store.mockRestore();
    }
  });

  it('reports semantic degradation explicitly while still returning bounded graph candidates', async () => {
    const semantic = installSemanticSearch(server, async () => {
      throw new Error('alpha-vector-backend-unavailable');
    });
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'degraded semantic discovery',
        candidateLimit: 10,
        graphDepth: 1,
        budget: 3000,
      }, alphaContext);

      expect(result.error).toBeUndefined();
      expect(result.degraded).toMatchObject({ semantic: true, graph: false });
      expect(result.degraded.reasons).toContain('semantic_backend_failed');
      expect(result.degraded.reasons.join(' ')).not.toContain('alpha-vector-backend-unavailable');
      expect(result.candidates.some((candidate: any) => candidate.entity.name === names.direct)).toBe(true);
      expect(result.candidates.every((candidate: any) => candidate.scores.semantic === null)).toBe(true);
      expect(result.coverage.examinedCount).toBeGreaterThan(0);
      expect(result.coverage.returnedCount).toBe(result.candidates.length);
      expect(['none', 'limit', 'budget']).toContain(result.coverage.omittedReason);
    } finally {
      semantic.restore();
    }
  });

  it('the actual semantic adapter filters orphaned, stale, and type-mismatched vector rows and reports degradation', async () => {
    const manager = server.getMemoryManager() as any;
    const db = manager.getDb();
    const validId = observations[names.semanticOnly].id;
    const staleId = observations[names.twoHop].id;
    const typeMismatchId = observations[names.direct].id;
    const validBacking = db.prepare(
      'SELECT content FROM shared_memory WHERE tenant_id = ? AND id = ?',
    ).get(TENANT_ALPHA, validId) as { content: string };
    const staleBacking = db.prepare(
      'SELECT content FROM shared_memory WHERE tenant_id = ? AND id = ?',
    ).get(TENANT_ALPHA, staleId) as { content: string };
    const typeMismatchBacking = db.prepare(
      'SELECT content FROM shared_memory WHERE tenant_id = ? AND id = ?',
    ).get(TENANT_ALPHA, typeMismatchId) as { content: string };
    const vectorMemory = (
      id: string,
      type: string,
      content: string,
      distance: number,
    ) => ({
      id,
      agentId: 'alpha-vector-fixture',
      tenantId: TENANT_ALPHA,
      type,
      content,
      timestamp: Date.now(),
      tags: [],
      priority: 5,
      relationships: [],
      metadata: { distance },
    });
    const underlyingSearch = vi.fn(async () => ({
      memories: [
        vectorMemory(`alpha-orphan-vector-${tag}`, 'observation', '{"orphan":true}', 0.01),
        vectorMemory(staleId, 'observation', `${staleBacking.content} `, 0.02),
        vectorMemory(typeMismatchId, 'entity', typeMismatchBacking.content, 0.03),
        vectorMemory(validId, 'observation', validBacking.content, 0.04),
      ],
      degraded: false,
      reasons: [],
    }));
    const originalAdvanced = manager.isAdvancedSystemsEnabled;
    const originalVectorClient = manager.vectorClient;
    manager.isAdvancedSystemsEnabled = true;
    manager.vectorClient = { searchSemanticMemories: underlyingSearch };

    try {
      const result = await manager.searchRelatedContextSemantic(
        'actual alpha semantic adapter check',
        TENANT_ALPHA,
        999,
      );

      expect(underlyingSearch).toHaveBeenCalledWith({
        query: 'actual alpha semantic adapter check',
        tenantId: TENANT_ALPHA,
        limit: 75,
      });
      expect(result.results.map((row: any) => row.id)).toEqual([validId]);
      expect(result.results[0]).toMatchObject({
        id: validId,
        memoryType: 'observation',
        semanticSimilarity: 1 / 1.04,
      });
      expect(result.degraded).toBe(true);
      expect(result.reasons).toEqual(expect.arrayContaining([
        'semantic_backing_row_missing',
        'semantic_index_backing_mismatch',
        'semantic_backing_type_mismatch',
      ]));
    } finally {
      manager.isAdvancedSystemsEnabled = originalAdvanced;
      manager.vectorClient = originalVectorClient;
    }
  });

  it('caps an actual oversized graph page and reports graph_edge_limit_reached degradation', async () => {
    const manager = server.getMemoryManager() as any;
    const db = manager.getDb();
    const tenantId = `tenant-alpha-cap-${tag}`;
    const scopeName = `alpha-cap-scope-${tag}`;
    const scopeId = `alpha-cap-scope-id-${tag}`;
    const insert = db.prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      insert.run(
        scopeId,
        tenantId,
        'entity',
        JSON.stringify({ name: scopeName, type: 'project', aliases: [], observations: [] }),
        'alpha-cap-fixture',
      );
      for (let index = 0; index < 201; index++) {
        const suffix = String(index).padStart(3, '0');
        const leafId = `alpha-cap-leaf-id-${suffix}-${tag}`;
        const leafName = `alpha-cap-leaf-${suffix}-${tag}`;
        insert.run(
          leafId,
          tenantId,
          'entity',
          JSON.stringify({ name: leafName, type: 'pattern', aliases: [], observations: [] }),
          'alpha-cap-fixture',
        );
        insert.run(
          `alpha-cap-relation-${suffix}-${tag}`,
          tenantId,
          'relation',
          JSON.stringify({
            from: scopeName,
            to: leafName,
            relationType: 'alpha_cap_link',
          }),
          'alpha-cap-fixture',
        );
      }
    });
    seed();
    manager.rebuildGraphLookupIndex(tenantId);

    const actualPage = manager.findRelatedContextRelations(scopeName, tenantId, 999);
    expect(actualPage.rows).toHaveLength(200);
    expect(actualPage.truncated).toBe(true);

    const semantic = installSemanticSearch(server, async () => ({
      results: [],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: scopeName },
        intent: 'bounded oversized alpha graph',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, requestContext(tenantId));

      expect(result.error).toBeUndefined();
      expect(result.degraded).toMatchObject({ semantic: false, graph: true });
      expect(result.degraded.reasons).toContain('graph_edge_limit_reached');
      expect(result.coverage.examinedCount).toBe(200);
      expect(result.coverage.rankedCount).toBe(200);
      expect(result.coverage.returnedCount).toBe(25);
      expect(result.coverage.truncated).toBe(true);
      expect(result.candidates).toHaveLength(25);
      expect(result.candidates.every((candidate: any) =>
        candidate.explanation.paths.every((path: any) => path.hops <= 1)
      )).toBe(true);
    } finally {
      semantic.restore();
    }
  });

  it('uses bounded currentness helpers and enriches only the top 25 ranked candidates', async () => {
    const manager = server.getMemoryManager() as any;
    const boundedObservations = vi.spyOn(manager, 'findRelatedContextObservations');
    const legacyObservations = vi.spyOn(manager, 'findObservationsByEntityOrAlias');
    const currentObservation = vi.spyOn(manager, 'getCurrentObservation');
    const semantic = installSemanticSearch(server, async () => ({
      results: limitEntities.map((entity, index) => semanticEntity(entity, 0.95 - index / 1000)),
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'top alpha enrichment boundary',
        candidateLimit: 999,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);

      expect(result.coverage.candidateLimit).toBe(25);
      expect(result.coverage.rankedCount).toBeGreaterThan(25);
      expect(result.candidates).toHaveLength(25);
      expect(legacyObservations).not.toHaveBeenCalled();
      expect(boundedObservations.mock.calls.length).toBeLessThanOrEqual(25);
      expect(boundedObservations.mock.calls.length).toBe(result.candidates.length);
      expect(boundedObservations.mock.calls.every((call: any[]) => call[2] <= 100)).toBe(true);

      const enrichedNames = boundedObservations.mock.calls.map((call: any[]) => call[0]).sort();
      const returnedNames = result.candidates.map((candidate: any) => candidate.entity.name).sort();
      expect(enrichedNames).toEqual(returnedNames);

      const candidateCurrentnessCalls = currentObservation.mock.calls.filter(
        (call: any[]) => call[0] !== names.scope,
      );
      // Candidate currentness is derived from the same bounded, alias-aware
      // page above; the canonical-only legacy resolver is used only for the
      // exact root query seed and never for candidate enrichment.
      expect(candidateCurrentnessCalls).toHaveLength(0);
    } finally {
      semantic.restore();
      currentObservation.mockRestore();
      legacyObservations.mockRestore();
      boundedObservations.mockRestore();
    }
  });

  it('expands actual vec0 KNN beyond closer rows from another tenant to retrieve the target-tenant result', async () => {
    const db = new Database(':memory:');
    const client = new SqliteVecClient(db);
    (client as any).warmEmbeddingModel = vi.fn(async () => undefined);

    try {
      await client.initialize();
      expect((client as any).extensionLoaded).toBe(true);

      const dimensions = (client as any).dimensions as number;
      const queryVector = new Array(dimensions).fill(0);
      queryVector[0] = 1;
      const targetVector = new Array(dimensions).fill(0);
      targetVector[1] = 1;
      const targetTenant = `tenant-alpha-knn-${tag}`;
      const otherTenant = `tenant-beta-knn-${tag}`;
      const targetId = `alpha-knn-target-${tag}`;
      const targetContent = `alpha target beyond initial global knn window ${tag}`;
      (client as any).createEmbedding = vi.fn(async (content: string) =>
        content === targetContent ? targetVector : queryVector
      );

      // Sixty exact matches in another tenant are all closer than the one
      // valid target-tenant row. A single global k=50/tenant-post-filter query
      // silently loses the target; bounded iterative KNN expansion finds it.
      for (let index = 0; index < 60; index++) {
        await client.storeMemory({
          id: `beta-knn-nearer-${String(index).padStart(2, '0')}-${tag}`,
          agentId: 'beta-knn-fixture',
          tenantId: otherTenant,
          type: 'observation',
          content: `beta closer vector ${index} ${tag}`,
          timestamp: Date.now() + index,
          tags: [],
          priority: 5,
          relationships: [],
        } as any);
      }
      await client.storeMemory({
        id: targetId,
        agentId: 'alpha-knn-fixture',
        tenantId: targetTenant,
        type: 'observation',
        content: targetContent,
        timestamp: Date.now() + 100,
        tags: [],
        priority: 5,
        relationships: [],
      } as any);

      const result = await client.searchSemanticMemories({
        query: 'alpha-knn-query',
        tenantId: targetTenant,
        limit: 1,
      });

      expect(result.memories.map((memory) => memory.id)).toEqual([targetId]);
      expect(result.memories[0]).toMatchObject({
        tenantId: targetTenant,
        content: targetContent,
      });
      expect(result.degraded).toBe(false);
      expect(result.reasons).toEqual([]);
    } finally {
      await client.cleanup();
      db.close();
    }
  });

  it('selects alias-addressed current state from bounded alias-aware rows and returns only its evidence', async () => {
    const candidateName = `alpha-alias-current-${tag}`;
    const candidateAlias = `alpha-alias-address-${tag}`;
    const created = await callOk(server, 'create_entities', {
      entities: [{
        name: candidateName,
        entityType: 'pattern',
        aliases: [candidateAlias],
        observations: [],
      }],
    }, alphaContext);
    expect(created.entities[0].name).toBe(candidateName);

    const old = await callOk(server, 'add_observations', {
      observations: [{
        entityName: candidateName,
        contents: ['canonical-name historical state'],
        kind: 'fact',
        canonicalFact: 'historical canonical-name fact',
        metadata: {
          evidenceRefs: ['evidence:alpha-alias-historical'],
          sourceRefs: ['source:alpha-alias-historical'],
        },
      }],
    }, alphaContext);
    const current = await callOk(server, 'add_observations', {
      observations: [{
        entityName: candidateAlias,
        contents: ['alias-addressed current state'],
        kind: 'decision',
        canonicalFact: 'alias-addressed current fact',
        supersedes: [old.observations[0].id],
        metadata: {
          evidenceRefs: ['evidence:alpha-alias-current'],
          sourceRefs: ['source:alpha-alias-current'],
        },
      }],
    }, alphaContext);
    const currentObservation = current.observations[0];
    const db = server.getMemoryManager().getDb();
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(
      '2026-01-01 00:00:00',
      old.observations[0].id,
    );
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(
      '2026-02-01 00:00:00',
      currentObservation.id,
    );
    await callOk(server, 'create_relations', {
      relations: [{ from: names.scope, to: candidateName, relationType: 'uses_alias_pattern' }],
    }, alphaContext);

    const manager = server.getMemoryManager() as any;
    const boundedObservations = vi.spyOn(manager, 'findRelatedContextObservations');
    const semantic = installSemanticSearch(server, async () => ({
      results: [semanticObservation(currentObservation, 0.93)],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'alias-aware current evidence',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.name === candidateName);

      expect(candidate).toBeDefined();
      expect(boundedObservations).toHaveBeenCalledWith(
        candidateName,
        TENANT_ALPHA,
        100,
        created.entities[0].id,
      );
      expect(candidate.explanation.currentness.currentObservation).toMatchObject({
        id: currentObservation.id,
        kind: 'decision',
        canonicalFact: 'alias-addressed current fact',
        contents: ['alias-addressed current state'],
      });
      expect(candidate.explanation.currentness.matchedObservations).toContainEqual({
        id: currentObservation.id,
        status: 'current',
        supersededBy: [],
      });
      expect(candidate.explanation.evidenceRefs).toEqual(['evidence:alpha-alias-current']);
      expect(candidate.explanation.sourceRefs).toContain('source:alpha-alias-current');
      expect(candidate.explanation.evidenceRefs).not.toContain('evidence:alpha-alias-historical');
      expect(candidate.explanation.sourceRefs).not.toContain('source:alpha-alias-historical');
    } finally {
      semantic.restore();
      boundedObservations.mockRestore();
    }
  });

  it('never cross-attributes observations through an ambiguous shared alias and reports the skipped identity', async () => {
    const entityAName = `alpha-shared-alias-owner-${tag}`;
    const entityBName = `alpha-shared-alias-canonical-${tag}`;
    const created = await callOk(server, 'create_entities', {
      entities: [
        {
          name: entityAName,
          entityType: 'pattern',
          aliases: [entityBName],
          observations: [],
        },
        {
          name: entityBName,
          entityType: 'pattern',
          aliases: [],
          observations: [],
        },
      ],
    }, alphaContext);
    const entityA = created.entities.find((entity: any) => entity.name === entityAName);
    expect(entityA).toBeDefined();

    const added = await callOk(server, 'add_observations', {
      observations: [
        {
          entityName: entityAName,
          contents: ['entity A own current state'],
          kind: 'fact',
          canonicalFact: 'entity A own fact',
          metadata: {
            evidenceRefs: ['evidence:alpha-entity-a'],
            sourceRefs: ['source:alpha-entity-a'],
          },
        },
        {
          entityName: entityBName,
          contents: ['entity B must remain isolated'],
          kind: 'decision',
          canonicalFact: 'entity B separate fact',
          metadata: {
            evidenceRefs: ['evidence:alpha-entity-b-private'],
            sourceRefs: ['source:alpha-entity-b-private'],
          },
        },
      ],
    }, alphaContext);
    const entityAObservation = added.observations.find(
      (observation: any) => observation.entityName === entityAName,
    );
    const entityBObservation = added.observations.find(
      (observation: any) => observation.entityName === entityBName,
    );
    const db = server.getMemoryManager().getDb();
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(
      '2026-01-01 00:00:00',
      entityAObservation.id,
    );
    // Make B newer so a naive alias-aware "newest row wins" implementation
    // would incorrectly promote B as A's current state.
    db.prepare('UPDATE shared_memory SET created_at = ? WHERE id = ?').run(
      '2026-02-01 00:00:00',
      entityBObservation.id,
    );
    await callOk(server, 'create_relations', {
      relations: [{ from: names.scope, to: entityAName, relationType: 'uses_shared_alias_pattern' }],
    }, alphaContext);

    const semantic = installSemanticSearch(server, async () => ({
      results: [],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'identity-safe shared alias currentness',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.id === entityA.id);

      expect(candidate).toBeDefined();
      expect(candidate.explanation.currentness.currentObservation).toMatchObject({
        id: entityAObservation.id,
        kind: 'fact',
        canonicalFact: 'entity A own fact',
        contents: ['entity A own current state'],
      });
      expect(candidate.explanation.evidenceRefs).toEqual(['evidence:alpha-entity-a']);
      expect(candidate.explanation.sourceRefs).toContain('source:alpha-entity-a');
      expect(JSON.stringify(candidate)).not.toContain(entityBObservation.id);
      expect(JSON.stringify(candidate)).not.toContain('evidence:alpha-entity-b-private');
      expect(JSON.stringify(candidate)).not.toContain('source:alpha-entity-b-private');
      expect(result.degraded).toMatchObject({ graph: true });
      expect(result.degraded.reasons).toContain('observation_identity_ambiguous_or_mismatched');
    } finally {
      semantic.restore();
    }
  });

  it('fails closed on a current state beyond the alias-key cap and reports truncation honestly', async () => {
    const candidateName = `alpha-many-aliases-${tag}`;
    const aliases = Array.from({ length: 91 }, (_, index) =>
      `alpha-many-alias-${String(index).padStart(3, '0')}-${tag}`
    );
    const lateAlias = aliases[90];
    const created = await callOk(server, 'create_entities', {
      entities: [{
        name: candidateName,
        entityType: 'pattern',
        aliases,
        observations: [],
      }],
    }, alphaContext);
    const candidateEntity = created.entities[0];

    const added = await callOk(server, 'add_observations', {
      observations: [{
        entityName: lateAlias,
        contents: ['current state stored on lexically late alias'],
        kind: 'decision',
        canonicalFact: 'late alias current fact',
        metadata: {
          evidenceRefs: ['evidence:alpha-late-alias-current'],
          sourceRefs: ['source:alpha-late-alias-current'],
        },
      }],
    }, alphaContext);
    const lateObservation = added.observations[0];
    await callOk(server, 'create_relations', {
      relations: [{ from: names.scope, to: candidateName, relationType: 'uses_many_alias_pattern' }],
    }, alphaContext);

    const semantic = installSemanticSearch(server, async () => ({
      results: [],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'bounded expanded alias lookup',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.id === candidateEntity.id);

      expect(candidate).toBeDefined();
      expect.soft(candidate.explanation.currentness.currentObservation).toBeNull();
      expect.soft(candidate.explanation.currentness.matchedObservations).toEqual([]);
      expect.soft(candidate.explanation.evidenceRefs).toEqual([]);
      expect.soft(candidate.explanation.sourceRefs).toEqual([]);
      expect.soft(JSON.stringify(candidate)).not.toContain(lateObservation.id);
      expect.soft(result.degraded).toMatchObject({ graph: true });
      expect.soft(result.degraded.reasons).toContain('entity_alias_lookup_limit_reached');
    } finally {
      semantic.restore();
    }
  });

  it('uses authoritative storage authorship and time for current-observation provenance', async () => {
    const candidateName = `alpha-provenance-authority-${tag}`;
    const created = await callOk(server, 'create_entities', {
      entities: [{ name: candidateName, entityType: 'pattern', aliases: [], observations: [] }],
    }, alphaContext);
    const candidateEntity = created.entities[0];
    const added = await callOk(server, 'add_observations', {
      observations: [{
        entityName: candidateName,
        contents: ['storage-authoritative provenance state'],
        kind: 'fact',
        canonicalFact: 'storage provenance remains authoritative',
      }],
    }, alphaContext);
    const observation = added.observations[0];
    const manager = server.getMemoryManager() as any;
    const db = manager.getDb();
    const storageRow = db.prepare(
      'SELECT content, created_by, created_at FROM shared_memory WHERE tenant_id = ? AND id = ?',
    ).get(TENANT_ALPHA, observation.id) as {
      content: string;
      created_by: string;
      created_at: string;
    };
    const tamperedPayload = JSON.parse(storageRow.content);
    tamperedPayload.addedBy = 'alpha-payload-claimed-author';
    tamperedPayload.timestamp = '2099-12-31T23:59:59.000Z';
    db.prepare('UPDATE shared_memory SET content = ? WHERE tenant_id = ? AND id = ?').run(
      JSON.stringify(tamperedPayload),
      TENANT_ALPHA,
      observation.id,
    );
    await callOk(server, 'create_relations', {
      relations: [{ from: names.scope, to: candidateName, relationType: 'uses_provenance_pattern' }],
    }, alphaContext);

    const semantic = installSemanticSearch(server, async () => ({
      results: [],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'authoritative observation provenance',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.id === candidateEntity.id);
      const provenance = candidate?.explanation.provenance.find(
        (row: any) => row.memoryId === observation.id && row.memoryType === 'observation',
      );

      expect(candidate).toBeDefined();
      expect(candidate.explanation.currentness.currentObservation).toMatchObject({
        id: observation.id,
        addedBy: 'alpha-payload-claimed-author',
        timestamp: '2099-12-31T23:59:59.000Z',
      });
      expect(provenance).toMatchObject({
        memoryId: observation.id,
        memoryType: 'observation',
        createdBy: storageRow.created_by,
        createdAt: new Date(storageRow.created_at).toISOString(),
      });
      expect(provenance.createdBy).not.toBe('alpha-payload-claimed-author');
      expect(provenance.createdAt).not.toBe('2099-12-31T23:59:59.000Z');
    } finally {
      semantic.restore();
    }
  });

  it('keeps authoritative candidate identity when its canonical name is another entity alias', async () => {
    const entityAName = `alpha-inverse-collision-a-${tag}`;
    const entityAUniqueAlias = `alpha-inverse-unique-alias-${tag}`;
    const entityBName = `alpha-inverse-collision-b-${tag}`;
    const created = await callOk(server, 'create_entities', {
      entities: [
        {
          name: entityAName,
          entityType: 'pattern',
          aliases: [entityAUniqueAlias],
          observations: [],
        },
        {
          name: entityBName,
          entityType: 'pattern',
          aliases: [entityAName],
          observations: [],
        },
      ],
    }, alphaContext);
    const entityA = created.entities.find((entity: any) => entity.name === entityAName);
    expect(entityA).toBeDefined();

    const added = await callOk(server, 'add_observations', {
      observations: [{
        entityName: entityAUniqueAlias,
        contents: ['inverse collision current state for entity A'],
        kind: 'decision',
        canonicalFact: 'inverse collision still resolves entity A',
        metadata: {
          evidenceRefs: ['evidence:alpha-inverse-a'],
          sourceRefs: ['source:alpha-inverse-a'],
        },
      }],
    }, alphaContext);
    const entityAObservation = added.observations[0];
    await callOk(server, 'create_relations', {
      relations: [{
        from: names.scope,
        to: entityAUniqueAlias,
        relationType: 'uses_unique_alias_pattern',
      }],
    }, alphaContext);

    const semantic = installSemanticSearch(server, async () => ({
      results: [],
      degraded: false,
      reasons: [],
    }));
    try {
      const result = await callOk(server, 'discover_related_context', {
        scope: { project: names.scope },
        intent: 'authoritative candidate identity through unique alias',
        candidateLimit: 25,
        graphDepth: 1,
        budget: 12000,
      }, alphaContext);
      const candidate = result.candidates.find((item: any) => item.entity.id === entityA.id);

      expect(candidate).toBeDefined();
      expect(candidate.explanation.currentness.currentObservation).toMatchObject({
        id: entityAObservation.id,
        kind: 'decision',
        canonicalFact: 'inverse collision still resolves entity A',
        contents: ['inverse collision current state for entity A'],
      });
      expect(candidate.explanation.evidenceRefs).toEqual(['evidence:alpha-inverse-a']);
      expect(candidate.explanation.sourceRefs).toContain('source:alpha-inverse-a');
    } finally {
      semantic.restore();
    }
  });
});
