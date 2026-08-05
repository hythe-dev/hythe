/**
 * ENG-4 exact scope + identity resolver (sub-step 2(a), design D3 —
 * approved contract layer @ 89fc422).
 *
 * Resolution is EXACT/CANONICAL ONLY: canonical entity names and registered
 * aliases via the store's proven lookup path (graph_lookup_keys kinds
 * canonical_name/alias with findEntitiesByNameOrAlias fallback — the same
 * machinery get_entity_detail uses). Substring and semantic matching are
 * FORBIDDEN here (spec A3; the legacy LOWER-LIKE path is dead in resume).
 *
 * Fail-closed rules (contract-tested):
 * - Unknown ref → ids null, scopeKey null (absence explicit, never an error dump).
 * - Ambiguous ref (multiple distinct entity ids) → scopeKey null +
 *   ambiguousCandidates; a storage key is NEVER synthesized.
 * - scopeKey derivation is deterministic from resolved UUIDs only.
 *
 * The resolver depends on a NARROW injected surface (EntityDirectory), not
 * on the MemoryManager class — the god-file grows only by the two thin
 * public wrappers that implement this interface.
 */
import type { ResolvedScope, ScopeRef, ScopeKey } from './contracts.js';

export interface EntityCandidate {
  /** Stable entity UUID. */
  id: string;
  /** Canonical entity name. */
  name: string;
  matchedBy: 'canonical_name' | 'alias';
}

/** Narrow query surface the resolver needs — implemented by MemoryManager. */
export interface EntityDirectory {
  /** EXACT canonical-name/alias candidates within one tenant. */
  resolveEntityCandidatesExact(name: string, tenantId: string): EntityCandidate[];
  /** Canonical agent family for an asserted agent id. */
  resolveCanonicalAgent(agentId: string): { canonical: string; aliases: string[] };
}

/** Deterministic storage scope key from resolved entity UUIDs (never names). */
export function deriveScopeKey(projectId: string | null, taskId: string | null): ScopeKey | null {
  if (projectId && taskId) return `p:${projectId}|t:${taskId}`;
  if (projectId) return `p:${projectId}`;
  if (taskId) return `t:${taskId}`;
  return null;
}

/** Strict inverse of deriveScopeKey — null for anything malformed. */
export function parseScopeKey(scopeKey: string): { projectId: string | null; taskId: string | null } | null {
  const both = /^p:([^|]+)\|t:([^|]+)$/.exec(scopeKey);
  if (both) return { projectId: both[1], taskId: both[2] };
  const project = /^p:([^|]+)$/.exec(scopeKey);
  if (project) return { projectId: project[1], taskId: null };
  const task = /^t:([^|]+)$/.exec(scopeKey);
  if (task) return { projectId: null, taskId: task[1] };
  return null;
}

interface RefResolution {
  id: string | null;
  aliasesMatched: string[];
  ambiguous: string[];
}

function resolveRef(directory: EntityDirectory, tenantId: string, ref: string): RefResolution {
  const candidates = directory.resolveEntityCandidatesExact(ref, tenantId);
  const distinctIds = [...new Set(candidates.map((c) => c.id))];
  if (distinctIds.length === 0) return { id: null, aliasesMatched: [], ambiguous: [] };
  if (distinctIds.length > 1) {
    return {
      id: null,
      aliasesMatched: [],
      ambiguous: [...new Set(candidates.map((c) => c.name))].sort(),
    };
  }
  return {
    id: distinctIds[0],
    aliasesMatched: candidates.some((c) => c.matchedBy === 'alias') ? [ref] : [],
    ambiguous: [],
  };
}

export function resolveScope(
  directory: EntityDirectory,
  tenantId: string,
  ref: ScopeRef
): ResolvedScope {
  const projectRes = 'project' in ref && ref.project ? resolveRef(directory, tenantId, ref.project) : null;
  const taskRes = 'task' in ref && ref.task ? resolveRef(directory, tenantId, ref.task) : null;

  const ambiguousCandidates = [
    ...(projectRes?.ambiguous ?? []),
    ...(taskRes?.ambiguous ?? []),
  ];

  const projectId = projectRes?.id ?? null;
  const taskId = taskRes?.id ?? null;

  // Fail closed: any requested-but-unresolved or ambiguous part means NO
  // storage key — a partially-resolved scope must never mint a key.
  const projectOk = projectRes === null || projectRes.id !== null;
  const taskOk = taskRes === null || taskRes.id !== null;
  const scopeKey: ScopeKey | null = projectOk && taskOk ? deriveScopeKey(projectId, taskId) : null;

  const resolved: ResolvedScope = {
    projectId,
    taskId,
    scopeKey,
    aliasesMatched: [...(projectRes?.aliasesMatched ?? []), ...(taskRes?.aliasesMatched ?? [])],
  };
  if (ambiguousCandidates.length > 0) resolved.ambiguousCandidates = ambiguousCandidates;
  return resolved;
}
