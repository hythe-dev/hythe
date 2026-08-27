import type Database from 'better-sqlite3';
import type { ScopeRef, ResolvedScope } from '../eng4/contracts.js';
import { resolveScope, type EntityDirectory } from '../eng4/resolver.js';
import type { SearchResult } from '../types/memory.js';

export const RELATED_CONTEXT_LIMITS = Object.freeze({
  defaultCandidateLimit: 10,
  maxCandidateLimit: 25,
  defaultGraphDepth: 1,
  maxGraphDepth: 2,
  maxGraphEdges: 200,
  defaultBudget: 3000,
  minBudget: 256,
  maxBudget: 12000,
  maxSemanticSeeds: 75,
});

export interface RelatedContextParams {
  scope: ScopeRef;
  intent: string;
  candidateLimit?: number;
  graphDepth?: number;
  budget?: number;
}

export interface RelatedContextSemanticSearch {
  results: SearchResult[];
  degraded: boolean;
  reasons: string[];
}

export interface RelatedContextDirectory extends EntityDirectory {
  getDb(): Database.Database;
  getEntityDefinition(entityId: string, tenantId: string): string | null;
  getCurrentObservation(entityName: string, tenantId: string, windowSize?: number): {
    current: any | null;
  };
  findRelatedContextRelations(entityName: string, tenantId: string, limit: number, expectedEntityId?: string): {
    rows: any[];
    truncated: boolean;
    degradedReason?: string;
    degradedReasons?: string[];
  };
  findRelatedContextObservations(entityName: string, tenantId: string, limit: number, expectedEntityId?: string): {
    rows: any[];
    truncated: boolean;
    degradedReason?: string;
    degradedReasons?: string[];
  };
  isConfidentialMessageSearchItem(memoryType: unknown, content: unknown): boolean;
  isConfidentialGraphRow(memoryType: unknown, content: unknown, tenantId: string): boolean;
  searchRelatedContextSemantic(query: string, tenantId: string, limit: number): Promise<RelatedContextSemanticSearch>;
}

interface EntityInfo {
  id: string;
  name: string;
  entityType: string | null;
}

interface SemanticMatch {
  memoryId: string;
  memoryType: string;
  similarity: number | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface GraphPath {
  hops: number;
  nodes: string[];
  edges: Array<{
    id: string;
    relationType: string;
    from: string;
    to: string;
    createdBy: string | null;
    createdAt: string | null;
  }>;
}

interface CandidateAccumulator {
  entity: EntityInfo;
  semanticMatches: SemanticMatch[];
  paths: GraphPath[];
}

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(parsed), maximum));
};

const clampScore = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(parsed, 1));
};

const roundScore = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const parseContent = (value: unknown): any | null => {
  if (value == null) return null;
  if (typeof value === 'object') {
    const original = (value as any).original;
    if (typeof original === 'string') {
      try { return JSON.parse(original); } catch { return null; }
    }
    return value;
  }
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};

const asIsoString = (value: unknown): string | null => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const compactText = (value: unknown, maximum = 500): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
};

const exactString = (value: unknown, maximum: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
};

const collectReferences = (values: unknown[]): { references: string[]; omitted: number } => {
  const refs = new Set<string>();
  let omitted = 0;
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      const exact = exactString(value, 300);
      if (exact) refs.add(exact);
      else if (value.trim()) omitted++;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of ['id', 'uri', 'url', 'handle', 'ref']) {
        if (typeof (value as any)[key] === 'string') add((value as any)[key]);
      }
    }
  };
  for (const value of values) add(value);
  const sorted = [...refs].sort();
  if (sorted.length > 20) omitted += sorted.length - 20;
  return { references: sorted.slice(0, 20), omitted };
};

const emptyCoverage = (
  candidateLimit: number,
  graphDepth: number,
  requestedBudget: number,
  budget: number,
) => ({
  examinedCount: 0,
  rankedCount: 0,
  returnedCount: 0,
  candidateLimit,
  graphDepth,
  requestedBudget,
  budget,
  budgetClamped: requestedBudget !== budget,
  tokenEstimate: 0,
  truncated: false,
  omittedReason: 'none' as 'none' | 'limit' | 'budget',
});

function entityFromId(
  directory: RelatedContextDirectory,
  tenantId: string,
  entityId: string,
): EntityInfo | null {
  const row = directory.getDb().prepare(
    `SELECT content
     FROM shared_memory
     WHERE tenant_id = ? AND id = ? AND memory_type = 'entity' AND json_valid(content)
     LIMIT 1`,
  ).get(tenantId, entityId) as { content: string } | undefined;
  if (!row) return null;
  const payload = parseContent(row.content);
  if (!payload || directory.isConfidentialMessageSearchItem('entity', payload)) return null;
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return null;
  return {
    id: entityId,
    name,
    entityType: exactString(payload.entityType ?? payload.type, 200),
  };
}

function semanticEntityReferences(memoryType: string, payload: any): string[] {
  if (!payload || typeof payload !== 'object') return [];
  if (memoryType === 'entity') return typeof payload.name === 'string' ? [payload.name] : [];
  if (memoryType === 'observation') return typeof payload.entityName === 'string' ? [payload.entityName] : [];
  if (memoryType === 'relation') {
    return [payload.from, payload.to].filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function uniqueEntityForReference(
  directory: RelatedContextDirectory,
  tenantId: string,
  reference: string,
  cache: Map<string, EntityInfo | null>,
): EntityInfo | null {
  const cacheKey = reference.trim();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
  const candidates = directory.resolveEntityCandidatesExact(reference, tenantId);
  const distinctIds = [...new Set(candidates.map((candidate) => candidate.id))];
  const resolved = distinctIds.length === 1
    ? entityFromId(directory, tenantId, distinctIds[0])
    : null;
  cache.set(cacheKey, resolved);
  return resolved;
}

function currentnessForCandidate(
  directory: RelatedContextDirectory,
  tenantId: string,
  candidate: CandidateAccumulator,
) {
  const observationPage = directory.findRelatedContextObservations(
    candidate.entity.name,
    tenantId,
    100,
    candidate.entity.id,
  );
  const rows = observationPage.rows;

  const supersededBy = new Map<string, Set<string>>();
  const knownIds = new Set<string>();
  const parsedRows: Array<{ row: any; payload: any }> = [];
  for (const row of rows) {
    const payload = parseContent(row.content);
    if (!payload || typeof payload !== 'object') continue;
    const rowId = String(row.id);
    knownIds.add(rowId);
    parsedRows.push({ row, payload });
    const supersedes = Array.isArray(payload?.metadata?.supersedes)
      ? payload.metadata.supersedes
      : (Array.isArray(payload?.supersedes) ? payload.supersedes : []);
    for (const superseded of supersedes) {
      if (typeof superseded !== 'string' || !superseded.trim()) continue;
      const owners = supersededBy.get(superseded) ?? new Set<string>();
      owners.add(String(row.id));
      supersededBy.set(superseded, owners);
    }
  }

  // The bounded page is canonical+alias aware. Resolve currentness from that
  // same evidence window so an observation stored under an exact registered
  // alias cannot disappear merely because the entity's canonical name differs.
  const currentEntry = parsedRows.find(({ row }) => !supersededBy.has(String(row.id)))
    ?? parsedRows[0]
    ?? null;
  const resolvedCurrent = currentEntry ? {
    id: String(currentEntry.row.id),
    entityName: currentEntry.payload.entityName ?? candidate.entity.name,
    timestamp: currentEntry.payload.timestamp || currentEntry.row.created_at,
    createdAt: currentEntry.row.created_at,
    addedBy: currentEntry.payload.addedBy || currentEntry.row.created_by,
    kind: currentEntry.payload.metadata?.kind ?? null,
    canonicalFact: currentEntry.payload.metadata?.canonicalFact ?? null,
    contents: Array.isArray(currentEntry.payload.contents) ? currentEntry.payload.contents : [],
    metadata: currentEntry.payload.metadata && typeof currentEntry.payload.metadata === 'object'
      ? currentEntry.payload.metadata
      : {},
    storageCreatedBy: exactString(currentEntry.row.created_by, 100),
    storageCreatedAt: asIsoString(currentEntry.row.created_at),
  } : null;

  const matchedObservationIds = [...new Set(candidate.semanticMatches
    .filter((match) => match.memoryType === 'observation')
    .map((match) => match.memoryId))];
  const matchedObservations = matchedObservationIds.map((id) => {
    const superseders = [...(supersededBy.get(id) ?? [])].sort();
    const status = id === resolvedCurrent?.id
      ? 'current'
      : superseders.length > 0
        ? 'superseded'
        : knownIds.has(id) ? 'historical' : 'unknown';
    return { id, status, supersededBy: superseders };
  });

  const metadata = resolvedCurrent?.metadata && typeof resolvedCurrent.metadata === 'object'
    ? resolvedCurrent.metadata
    : {};
  const rawCanonicalFact = typeof resolvedCurrent?.canonicalFact === 'string'
    ? resolvedCurrent.canonicalFact.trim()
    : '';
  const rawContents: string[] = (Array.isArray(resolvedCurrent?.contents) ? resolvedCurrent.contents : [])
    .filter((content: unknown): content is string => typeof content === 'string' && content.trim().length > 0);
  const currentObservation = resolvedCurrent ? {
    id: String(resolvedCurrent.id),
    timestamp: asIsoString(resolvedCurrent.timestamp ?? resolvedCurrent.createdAt),
    addedBy: exactString(resolvedCurrent.addedBy, 100),
    kind: exactString(resolvedCurrent.kind, 100),
    canonicalFact: compactText(rawCanonicalFact, 500),
    contents: rawContents
      .map((content: unknown) => compactText(content, 500))
      .filter((content: string | null): content is string => content !== null)
      .slice(0, 3),
    previewTruncated: rawCanonicalFact.length > 500
      || rawContents.length > 3
      || rawContents.some((content) => content.trim().length > 500),
  } : null;

  const evidence = collectReferences([
    metadata.evidenceRefs,
    metadata.evidence,
    metadata.citations,
    metadata.references,
  ]);
  const sources = collectReferences([
    metadata.sourceRefs,
    metadata.sources,
    metadata.source,
  ]);
  const contradictions = collectReferences([
    metadata.contradictions,
    metadata.contradicts,
    metadata.contradictionOf,
  ]);

  return {
    currentness: { currentObservation, matchedObservations },
    currentProvenance: resolvedCurrent ? {
      createdBy: resolvedCurrent.storageCreatedBy,
      createdAt: resolvedCurrent.storageCreatedAt,
    } : null,
    evidenceRefs: evidence.references,
    sourceRefs: sources.references,
    contradictions: contradictions.references,
    referenceCoverage: {
      evidenceOmitted: evidence.omitted,
      sourcesOmitted: sources.omitted,
      contradictionsOmitted: contradictions.omitted,
    },
    degradedReasons: [
      ...(observationPage.degradedReasons
        ?? (observationPage.degradedReason ? [observationPage.degradedReason] : [])),
      ...(observationPage.truncated ? ['observation_window_truncated'] : []),
    ],
  };
}

export async function performRelatedContextDiscovery(
  directory: RelatedContextDirectory,
  tenantId: string,
  params: RelatedContextParams,
): Promise<Record<string, any>> {
  const intent = typeof params?.intent === 'string' ? params.intent.trim() : '';
  if (!intent) throw new Error('Missing required field: `intent`');
  const scope = params?.scope;
  if (!scope || typeof scope !== 'object') throw new Error('Missing required field: `scope`');

  const requestedCandidateLimit = Number.isFinite(Number(params.candidateLimit))
    ? Math.floor(Number(params.candidateLimit))
    : RELATED_CONTEXT_LIMITS.defaultCandidateLimit;
  const candidateLimit = clampInteger(
    requestedCandidateLimit,
    RELATED_CONTEXT_LIMITS.defaultCandidateLimit,
    1,
    RELATED_CONTEXT_LIMITS.maxCandidateLimit,
  );
  const graphDepth = clampInteger(
    params.graphDepth,
    RELATED_CONTEXT_LIMITS.defaultGraphDepth,
    1,
    RELATED_CONTEXT_LIMITS.maxGraphDepth,
  );
  const requestedBudget = Number.isFinite(Number(params.budget))
    ? Math.floor(Number(params.budget))
    : RELATED_CONTEXT_LIMITS.defaultBudget;
  const budget = clampInteger(
    requestedBudget,
    RELATED_CONTEXT_LIMITS.defaultBudget,
    RELATED_CONTEXT_LIMITS.minBudget,
    RELATED_CONTEXT_LIMITS.maxBudget,
  );

  const resolvedScope: ResolvedScope = resolveScope(directory, tenantId, scope);
  const coverage = emptyCoverage(candidateLimit, graphDepth, requestedBudget, budget);
  const baseEnvelope = {
    schemaVersion: 1,
    resolvedScope,
    candidates: [] as any[],
    degraded: { semantic: false, graph: false, reasons: [] as string[] },
    coverage,
    writesPerformed: 0,
  };

  if (!resolvedScope.scopeKey) {
    const ambiguous = (resolvedScope.ambiguousCandidates?.length ?? 0) > 0;
    return {
      ...baseEnvelope,
      error: {
        code: ambiguous ? 'SCOPE_AMBIGUOUS' : 'SCOPE_NOT_FOUND',
        message: ambiguous
          ? 'The exact scope reference resolves to multiple entities.'
          : 'The exact scope reference was not found.',
        ...(ambiguous ? { candidates: resolvedScope.ambiguousCandidates } : {}),
      },
    };
  }

  const rootIds = [...new Set([resolvedScope.projectId, resolvedScope.taskId]
    .filter((value): value is string => typeof value === 'string'))];
  const rootEntities = rootIds
    .map((id) => entityFromId(directory, tenantId, id))
    .filter((entity): entity is EntityInfo => entity !== null);
  if (rootEntities.length !== rootIds.length) {
    return {
      ...baseEnvelope,
      error: {
        code: 'SCOPE_NOT_FOUND',
        message: 'The resolved scope entity is no longer readable.',
      },
    };
  }

  // The semantic query is the caller's intent, verbatim. Mixing in scope
  // names, definitions, or the scope's own current observations makes the
  // nearest neighbors the scope's own rows, which are then discarded as root
  // matches — the intent stops conditioning the ranking at all. Scope
  // conditioning comes from the graph leg and root filtering, not the query.
  const semanticQuery = intent.slice(0, 4000);

  const candidateMap = new Map<string, CandidateAccumulator>();
  const entityReferenceCache = new Map<string, EntityInfo | null>();
  for (const entity of rootEntities) entityReferenceCache.set(entity.name, entity);
  const rootIdSet = new Set(rootIds);
  let examinedCount = 0;

  const ensureCandidate = (entity: EntityInfo): CandidateAccumulator | null => {
    if (rootIdSet.has(entity.id)) return null;
    const existing = candidateMap.get(entity.id);
    if (existing) return existing;
    const created = { entity, semanticMatches: [], paths: [] };
    candidateMap.set(entity.id, created);
    return created;
  };

  const semanticAttachBudget = Math.min(
    RELATED_CONTEXT_LIMITS.maxSemanticSeeds,
    Math.max(candidateLimit * 3, candidateLimit),
  );
  // Fetch the full seed window regardless of the attach budget: hits on the
  // root scope entity are filtered below without consuming the budget, so a
  // scope with many of its own observations near the query cannot starve the
  // attachable seeds behind them.
  const semanticFetchLimit = RELATED_CONTEXT_LIMITS.maxSemanticSeeds;
  let semanticSearch: RelatedContextSemanticSearch;
  const semanticTimeoutMs = clampInteger(
    process.env.RELATED_CONTEXT_SEARCH_TIMEOUT_MS,
    4000,
    50,
    30000,
  );
  let semanticTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    semanticSearch = await Promise.race([
      directory.searchRelatedContextSemantic(semanticQuery, tenantId, semanticFetchLimit),
      new Promise<RelatedContextSemanticSearch>((_, reject) => {
        semanticTimer = setTimeout(
          () => reject(new Error(`semantic discovery exceeded ${semanticTimeoutMs}ms`)),
          semanticTimeoutMs,
        );
      }),
    ]);
  } catch {
    semanticSearch = {
      results: [],
      degraded: true,
      reasons: ['semantic_backend_failed'],
    };
  } finally {
    if (semanticTimer) clearTimeout(semanticTimer);
  }

  let semanticSeedsAttached = 0;
  let semanticSeedsRootFiltered = 0;
  for (const result of semanticSearch.results.slice(0, semanticFetchLimit)) {
    if (semanticSeedsAttached >= semanticAttachBudget) break;
    examinedCount++;
    const memoryType = String(result.memoryType || '').trim().toLowerCase();
    if (!['entity', 'observation', 'relation'].includes(memoryType)) continue;
    const payload = parseContent(result.content);
    if (!payload || directory.isConfidentialGraphRow(memoryType, payload, tenantId)) continue;
    const similarity = clampScore(result.semanticSimilarity);
    let attached = false;
    let rootTouched = false;
    for (const reference of semanticEntityReferences(memoryType, payload)) {
      const entity = uniqueEntityForReference(directory, tenantId, reference, entityReferenceCache);
      if (!entity) continue;
      if (rootIdSet.has(entity.id)) {
        rootTouched = true;
        continue;
      }
      const candidate = ensureCandidate(entity);
      if (!candidate) continue;
      attached = true;
      if (!candidate.semanticMatches.some((match) => match.memoryId === result.id)) {
        candidate.semanticMatches.push({
          memoryId: String(result.id),
          memoryType,
          similarity,
          createdBy: exactString(result.source?.replace(/^sqlite-vec:/, ''), 100),
          createdAt: asIsoString(result.timestamp),
        });
      }
    }
    if (attached) semanticSeedsAttached++;
    else if (rootTouched) semanticSeedsRootFiltered++;
  }
  // Backend success with zero candidate attribution is a starved leg, not a
  // healthy one. Say so instead of letting the ranking silently degenerate to
  // graph adjacency.
  const semanticStarved = semanticSearch.results.length > 0 && semanticSeedsAttached === 0;
  const semanticDegraded = semanticSearch.degraded || semanticStarved;
  const semanticReasons = semanticStarved
    ? [...semanticSearch.reasons, semanticSeedsRootFiltered > 0
        ? 'semantic_seeds_root_scope_only'
        : 'semantic_seeds_unattributable']
    : [...semanticSearch.reasons];

  let graphDegraded = false;
  const graphReasons: string[] = [];
  const scannedRelationIds = new Set<string>();
  const bestHop = new Map<string, number>(rootEntities.map((entity) => [entity.id, 0]));
  const queue = rootEntities.map((entity) => ({ entity, path: null as GraphPath | null }));

  try {
    while (queue.length > 0 && scannedRelationIds.size < RELATED_CONTEXT_LIMITS.maxGraphEdges) {
      const state = queue.shift()!;
      const stateHop = bestHop.get(state.entity.id) ?? 0;
      if (stateHop >= graphDepth) continue;
      const remainingEdges = RELATED_CONTEXT_LIMITS.maxGraphEdges - scannedRelationIds.size;
      const relationPage = directory.findRelatedContextRelations(
        state.entity.name,
        tenantId,
        remainingEdges,
        state.entity.id,
      );
      const relationDegradedReasons = relationPage.degradedReasons
        ?? (relationPage.degradedReason ? [relationPage.degradedReason] : []);
      if (relationDegradedReasons.length > 0) {
        graphDegraded = true;
        graphReasons.push(...relationDegradedReasons);
      }
      if (relationPage.truncated) {
        graphDegraded = true;
        graphReasons.push('graph_edge_limit_reached');
      }
      const rows = relationPage.rows;
      for (const row of rows) {
        const relationId = String(row.id || '');
        if (!relationId || scannedRelationIds.has(relationId)) continue;
        if (scannedRelationIds.size >= RELATED_CONTEXT_LIMITS.maxGraphEdges) break;
        scannedRelationIds.add(relationId);
        examinedCount++;
        const payload = parseContent(row.content);
        if (!payload || directory.isConfidentialGraphRow('relation', payload, tenantId)) continue;
        if (typeof payload.from !== 'string' || typeof payload.to !== 'string') continue;
        const fromEntity = uniqueEntityForReference(directory, tenantId, payload.from, entityReferenceCache);
        const toEntity = uniqueEntityForReference(directory, tenantId, payload.to, entityReferenceCache);
        if (!fromEntity || !toEntity) continue;
        const other = fromEntity.id === state.entity.id
          ? toEntity
          : (toEntity.id === state.entity.id ? fromEntity : null);
        if (!other || other.id === state.entity.id) continue;
        const relationType = exactString(payload.relationType, 200);
        if (!relationType) continue;

        const edge = {
          id: relationId,
          relationType,
          from: fromEntity.name,
          to: toEntity.name,
          createdBy: exactString(row.created_by, 100),
          createdAt: asIsoString(row.created_at),
        };
        const path: GraphPath = state.path
          ? {
              hops: state.path.hops + 1,
              nodes: [...state.path.nodes, other.name],
              edges: [...state.path.edges, edge],
            }
          : {
              hops: 1,
              nodes: [state.entity.name, other.name],
              edges: [edge],
            };

        if (!rootIdSet.has(other.id)) {
          const candidate = ensureCandidate(other);
          if (candidate && candidate.paths.length < 3 && !candidate.paths.some((known) =>
            known.edges.map((knownEdge) => knownEdge.id).join('|') === path.edges.map((pathEdge) => pathEdge.id).join('|')
          )) {
            candidate.paths.push(path);
          }
        }

        const nextHop = stateHop + 1;
        const previousHop = bestHop.get(other.id);
        if (nextHop < graphDepth && (previousHop === undefined || nextHop < previousHop)) {
          bestHop.set(other.id, nextHop);
          queue.push({ entity: other, path });
        }
      }
    }
    if (queue.length > 0 && scannedRelationIds.size >= RELATED_CONTEXT_LIMITS.maxGraphEdges) {
      graphDegraded = true;
      graphReasons.push('graph_edge_limit_reached');
    }
  } catch {
    graphDegraded = true;
    graphReasons.push('graph_discovery_failed');
  }

  const scored = [...candidateMap.values()].map((candidate) => {
    candidate.semanticMatches.sort((left, right) =>
      (right.similarity ?? -1) - (left.similarity ?? -1)
      || left.memoryId.localeCompare(right.memoryId)
    );
    candidate.paths.sort((left, right) =>
      left.hops - right.hops
      || left.edges.map((edge) => edge.id).join('|').localeCompare(right.edges.map((edge) => edge.id).join('|'))
    );
    const semanticValues = candidate.semanticMatches
      .map((match) => match.similarity)
      .filter((value): value is number => value !== null);
    const semantic = semanticValues.length > 0 ? Math.max(...semanticValues) : null;
    const graph = candidate.paths.length > 0
      ? Math.max(...candidate.paths.map((path) => 1 / path.hops))
      : 0;

    return {
      candidate,
      semantic,
      graph: roundScore(graph),
      combined: roundScore(0.7 * (semantic ?? 0) + 0.3 * graph),
    };
  }).sort((left, right) =>
    right.combined - left.combined
    || (right.semantic ?? -1) - (left.semantic ?? -1)
    || right.graph - left.graph
    || left.candidate.entity.id.localeCompare(right.candidate.entity.id)
  );

  const limited = scored.slice(0, candidateLimit).map((scoredCandidate, index) => {
    const { candidate, semantic, graph, combined } = scoredCandidate;
    const currentness = currentnessForCandidate(directory, tenantId, candidate);
    for (const reason of currentness.degradedReasons) {
      graphDegraded = true;
      graphReasons.push(reason);
    }
    const provenanceMap = new Map<string, any>();
    for (const match of candidate.semanticMatches.slice(0, 5)) {
      provenanceMap.set(`memory:${match.memoryId}`, {
        memoryId: match.memoryId,
        memoryType: match.memoryType,
        createdBy: match.createdBy,
        createdAt: match.createdAt,
      });
    }
    for (const path of candidate.paths.slice(0, 3)) {
      for (const edge of path.edges) {
        provenanceMap.set(`relation:${edge.id}`, {
          memoryId: edge.id,
          memoryType: 'relation',
          createdBy: edge.createdBy,
          createdAt: edge.createdAt,
        });
      }
    }
    if (currentness.currentness.currentObservation) {
      const current = currentness.currentness.currentObservation;
      provenanceMap.set(`observation:${current.id}`, {
        memoryId: current.id,
        memoryType: 'observation',
        createdBy: currentness.currentProvenance?.createdBy ?? null,
        createdAt: currentness.currentProvenance?.createdAt ?? null,
      });
    }

    return {
      rank: 0,
      entity: candidate.entity,
      scores: {
        semantic,
        graph,
        combined,
      },
      explanation: {
        semanticMatches: candidate.semanticMatches.slice(0, 5).map(({ memoryId, memoryType, similarity }) => ({
          memoryId,
          memoryType,
          similarity,
        })),
        paths: candidate.paths.slice(0, 3).map((path) => ({
          hops: path.hops,
          nodes: path.nodes,
          edges: path.edges.map(({ id, relationType, from, to }) => ({ id, relationType, from, to })),
        })),
        currentness: currentness.currentness,
        evidenceRefs: currentness.evidenceRefs,
        sourceRefs: currentness.sourceRefs,
        contradictions: currentness.contradictions,
        referenceCoverage: currentness.referenceCoverage,
        provenance: [...provenanceMap.values()].slice(0, 12),
      },
    };
  });

  limited.forEach((candidate, index) => { candidate.rank = index + 1; });
  const reasons = [...new Set([...semanticReasons, ...graphReasons])].sort();
  const result = {
    ...baseEnvelope,
    candidates: limited,
    degraded: {
      semantic: semanticDegraded,
      graph: graphDegraded,
      reasons,
    },
    coverage: {
      ...coverage,
      examinedCount,
      rankedCount: scored.length,
      returnedCount: limited.length,
      truncated: scored.length > limited.length,
      omittedReason: scored.length > limited.length ? 'limit' as const : 'none' as const,
    },
  };
  result.coverage.tokenEstimate = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}
