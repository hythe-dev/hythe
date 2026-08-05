/**
 * Graph authorization + observation sensitivity classification.
 *
 * Extracted from MemoryManager (./index.ts). These are pure functions of the
 * request context / observation content — no database or instance state — so
 * they live on their own and are directly unit-testable. MemoryManager keeps
 * thin delegating methods for its existing public API, so callers (the server,
 * tests) are unchanged.
 */
import type { RequestContext } from '../../middleware/auth/types.js';

export interface GraphMutationAuthResult {
  authorized: boolean;
  reason?: string;
}

export interface GraphReadAuthResult {
  permissions: Set<string>;
  authorized: boolean;
  reason?: string;
}

/**
 * Authorize a knowledge-graph mutation (delete/remove/update) for the caller.
 *  - dev      → trusted
 *  - api_key  → requires graph:write or * scope (or empty scopes + legacy flag)
 *  - jwt      → admin/owner mutate anything; member mutates own rows (provenance)
 */
export function authorizeGraphMutation(
  action: string,
  context: RequestContext
): GraphMutationAuthResult {
  // Dev auth → trusted
  if (context.authType === 'dev') {
    return { authorized: true };
  }

  // API key auth → require explicit graph:write or * scope
  if (context.authType === 'api_key') {
    const scopes = context.scopes || [];
    const hasWrite = scopes.includes('*') || scopes.includes('graph:write');
    const allowLegacy = process.env.ALLOW_LEGACY_GRAPH_MUTATIONS === '1';
    if (hasWrite || (allowLegacy && scopes.length === 0)) {
      return { authorized: true };
    }
    return { authorized: false, reason: 'API key lacks graph:write scope' };
  }

  // JWT → admin/owner role can mutate anything; member role can mutate own rows (provenance check)
  if (context.authType === 'jwt') {
    if (context.roles.includes('admin') || context.roles.includes('owner')) {
      return { authorized: true };
    }
    if (context.roles.includes('member') && context.userId) {
      // Phase B: member can mutate rows they own (caller must verify row-level provenance)
      return { authorized: true, reason: 'member_provenance' };
    }
    return { authorized: false, reason: 'JWT caller requires admin, owner, or member role for graph mutations' };
  }

  return { authorized: false, reason: 'Unknown auth type' };
}

/**
 * Permission vocabulary for graph read operations:
 *   graph:view              — topology (nodes + links). Minimum to access endpoint.
 *   graph:observations:view — non-sensitive observations.
 *   graph:sensitive:view    — agent-internal/system observations.
 *   Legacy: graph:read, graph:write, * imply graph:view + graph:observations:view.
 */
export function authorizeGraphRead(
  context: RequestContext
): GraphReadAuthResult {
  const permissions = new Set<string>();

  // Dev auth → full passthrough
  if (context.authType === 'dev') {
    permissions.add('graph:view');
    permissions.add('graph:observations:view');
    permissions.add('graph:sensitive:view');
    return { permissions, authorized: true };
  }

  // API key auth → check explicit scopes
  if (context.authType === 'api_key') {
    const scopes = context.scopes || [];
    const allowLegacy = process.env.ALLOW_LEGACY_GRAPH_MUTATIONS === '1';

    // Empty scopes with legacy passthrough
    if (scopes.length === 0 && allowLegacy) {
      permissions.add('graph:view');
      permissions.add('graph:observations:view');
      permissions.add('graph:sensitive:view');
      return { permissions, authorized: true };
    }

    // Wildcard or legacy scopes imply view + observations:view
    const hasWild = scopes.includes('*');
    const hasLegacyRead = scopes.includes('graph:read');
    const hasLegacyWrite = scopes.includes('graph:write');
    if (hasWild || hasLegacyRead || hasLegacyWrite) {
      permissions.add('graph:view');
      permissions.add('graph:observations:view');
    }

    // Explicit scopes
    if (scopes.includes('graph:view')) permissions.add('graph:view');
    if (scopes.includes('graph:observations:view')) permissions.add('graph:observations:view');
    if (scopes.includes('graph:sensitive:view')) permissions.add('graph:sensitive:view');

    // Wildcard also grants sensitive
    if (hasWild) permissions.add('graph:sensitive:view');

    if (!permissions.has('graph:view')) {
      return { permissions, authorized: false, reason: 'API key lacks graph:view scope' };
    }
    return { permissions, authorized: true };
  }

  // JWT → role-based mapping
  if (context.authType === 'jwt') {
    const roles = context.roles || [];
    if (roles.includes('admin') || roles.includes('owner')) {
      permissions.add('graph:view');
      permissions.add('graph:observations:view');
      permissions.add('graph:sensitive:view');
      return { permissions, authorized: true };
    }
    if (roles.includes('member')) {
      permissions.add('graph:view');
      permissions.add('graph:observations:view');
      return { permissions, authorized: true };
    }
    if (roles.includes('viewer')) {
      permissions.add('graph:view');
      return { permissions, authorized: true };
    }
    return { permissions, authorized: false, reason: 'JWT caller requires admin, owner, member, or viewer role' };
  }

  return { permissions, authorized: false, reason: 'Unknown auth type' };
}

/**
 * Deterministic 4-step sensitivity classification for an observation row.
 * contents is string[] — any match in any entry → entire observation is sensitive.
 */
export function classifyObservationSensitivity(
  observationContent: { entityName: string; contents: string[]; messageType?: string; sensitive?: boolean }
): boolean {
  // Step 1: messageType field
  if (observationContent.messageType) {
    const mt = observationContent.messageType.toLowerCase();
    if (mt === 'system' || mt === 'internal' || mt === 'coordination') return true;
  }
  // Step 2: entity metadata sensitive flag
  if (observationContent.sensitive === true) return true;
  // Step 3: content prefix check (case-insensitive, leading-whitespace-trimmed)
  const contents = observationContent.contents || [];
  for (const entry of contents) {
    const trimmed = (typeof entry === 'string') ? entry.trimStart().toLowerCase() : '';
    if (trimmed.startsWith('[system]') || trimmed.startsWith('[internal]')) return true;
  }
  // Step 4: default non-sensitive
  return false;
}
