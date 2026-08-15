import type { RequestContext } from '../middleware/auth/types.js';
import { AgentCredentialStore } from './credential-store.js';
import { decideAgentAuthorization } from './policy.js';
import {
  recordAgentAuthDenial,
  recordAgentAuthInvocation,
} from '../observability/metrics.js';

type ActingField = 'agentId' | 'from';

interface BindingRule {
  field: ActingField;
  scope: string;
}

const AGENT_ID_RULES = new Map<string, BindingRule>([
  ['create_entities', { field: 'agentId', scope: 'memory:write' }],
  ['add_observations', { field: 'agentId', scope: 'memory:write' }],
  ['create_relations', { field: 'agentId', scope: 'memory:write' }],
  ['compact_memory', { field: 'agentId', scope: 'memory:read' }],
  ['delete_entity', { field: 'agentId', scope: 'memory:admin' }],
  ['remove_observations', { field: 'agentId', scope: 'memory:admin' }],
  ['update_observation', { field: 'agentId', scope: 'memory:admin' }],
  ['delete_observations_by_entity', { field: 'agentId', scope: 'memory:admin' }],
  ['record_learning', { field: 'agentId', scope: 'memory:write' }],
  ['set_preferences', { field: 'agentId', scope: 'memory:write' }],
  ['get_individual_memory', { field: 'agentId', scope: 'memory:read' }],
  ['get_agent_context', { field: 'agentId', scope: 'memory:read' }],
  ['begin_session', { field: 'agentId', scope: 'state:write' }],
  ['end_session', { field: 'agentId', scope: 'state:write' }],
  ['checkpoint', { field: 'agentId', scope: 'state:write' }],
  ['resume', { field: 'agentId', scope: 'state:read' }],
  ['get_ai_messages', { field: 'agentId', scope: 'message:read' }],
  ['get_message_detail', { field: 'agentId', scope: 'message:read' }],
  ['mark_messages_read', { field: 'agentId', scope: 'message:read' }],
  ['archive_messages', { field: 'agentId', scope: 'message:read' }],
  ['register_agent', { field: 'agentId', scope: 'agent:self' }],
  ['unregister_agent', { field: 'agentId', scope: 'agent:self' }],
  ['send_ai_message', { field: 'from', scope: 'message:send' }],
]);

// These operations do not carry an acting identity field, but when a caller
// presents an agent credential its authority must still be the intersection
// of the base credential and the agent credential. Observe/mixed retain an
// explicit base-only compatibility path; required mode rejects omitted proof.
const AGENT_SCOPE_ONLY_RULES = new Map<string, string>([
  ['search_entities', 'memory:read'],
  ['discover_related_context', 'memory:read'],
  ['get_entity_detail', 'memory:read'],
  ['get_current_observation', 'memory:read'],
  ['get_entity_neighborhood', 'memory:read'],
  ['search_nodes', 'memory:read'],
  ['read_graph', 'memory:read'],
  ['get_entity_backlinks', 'memory:read'],
  ['get_agent_status', 'agent:self'],
  ['set_agent_identity', 'agent:admin'],
  ['gc_agent_registrations', 'agent:admin'],
  ['get_user_profile', 'profile:read'],
  ['update_user_profile', 'profile:write'],
  ['translate_path', 'system:read'],
]);

export class AgentAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = 'AgentAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function hasScope(scopes: readonly string[], required: string): boolean {
  if (scopes.includes('*') || scopes.includes(required)) return true;
  const separator = required.indexOf(':');
  return separator > 0 && scopes.includes(`${required.slice(0, separator)}:*`);
}

function hasBaseScope(context: RequestContext, required: string): boolean {
  // Local development, role-based operators, and the legacy single deployment
  // key are already trusted base authorities. Persisted tenant keys and
  // ordinary JWTs must carry the operation scope explicitly.
  if (context.authType === 'dev') return true;
  if (context.roles.includes('admin') || context.roles.includes('owner')) return true;
  if (context.authType === 'api_key' && context.apiKeyId == null) return true;
  return hasScope(context.scopes, required);
}

export function assertAgentCredentialScope(
  context: RequestContext,
  required: string,
): void {
  const principal = context.agentPrincipal;
  if (principal == null) {
    if (context.agentAuthMode === 'required') {
      recordAgentAuthDenial(context.agentAuthMode, 'credential_required');
      throw new AgentAuthorizationError(
        'AGENT_CREDENTIAL_REQUIRED',
        `Agent credential with scope ${required} is required in required mode`,
        401,
      );
    }
    return;
  }
  if (!hasScope(principal.scopes, required)) {
    recordAgentAuthDenial(context.agentAuthMode, 'scope_required');
    throw new AgentAuthorizationError(
      'AGENT_SCOPE_REQUIRED',
      `Agent credential lacks required scope ${required}`,
      403,
    );
  }
  if (!hasBaseScope(context, required)) {
    recordAgentAuthDenial(context.agentAuthMode, 'base_scope_required');
    throw new AgentAuthorizationError(
      'BASE_SCOPE_REQUIRED',
      `Base credential lacks required scope ${required}`,
      403,
    );
  }
}

function exactClaim(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    throw new AgentAuthorizationError('AGENT_ID_INVALID', `${label} is not a valid exact agent identity`, 400);
  }
  return value;
}

/**
 * Authoritative server-side binding for every operation whose agentId/from is
 * an actor or owner. Target/filter fields are deliberately not included.
 */
export function bindAgentInvocation(
  name: string,
  args: unknown,
  context: RequestContext,
  store: AgentCredentialStore,
): Record<string, unknown> {
  const rule = AGENT_ID_RULES.get(name);
  if (!rule) {
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new AgentAuthorizationError('INVALID_ARGUMENTS', 'Tool arguments must be an object', 400);
    }
    const requiredScope = AGENT_SCOPE_ONLY_RULES.get(name);
    if (requiredScope != null) {
      assertAgentCredentialScope(context, requiredScope);
      if (context.agentPrincipal != null) {
        recordAgentAuthInvocation(context.agentAuthMode, 'credential');
      }
    }
    return { ...((args ?? {}) as Record<string, unknown>) };
  }
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new AgentAuthorizationError('INVALID_ARGUMENTS', 'Tool arguments must be an object', 400);
  }

  const input = { ...((args ?? {}) as Record<string, unknown>) };
  const claim = exactClaim(input[rule.field], `${name}.${rule.field}`);
  const principal = context.agentPrincipal;
  const claimedState = claim == null
    ? null
    : store.getPrincipal(context.tenantId, claim)?.enforcementState ?? null;
  const validation = principal == null
    ? { valid: false as const, reason: 'missing' as const, credentialId: null }
    : {
        valid: true as const,
        principal: {
          tenantId: context.tenantId,
          agentId: principal.agentId,
          displayName: null,
          enforcementState: principal.enforcementState,
          createdAt: '',
          createdBy: '',
          promotedAt: null,
          promotedBy: null,
          disabledAt: null,
          disabledBy: null,
        },
        credential: {
          credentialId: principal.credentialId,
          tenantId: context.tenantId,
          agentId: principal.agentId,
          scopes: principal.scopes,
          status: 'active' as const,
          notBefore: '',
          expiresAt: null,
          lastUsedAt: null,
          createdAt: '',
          createdBy: '',
          revokedAt: null,
          revokedBy: null,
          replacedBy: null,
        },
      };

  const decision = decideAgentAuthorization({
    mode: context.agentAuthMode,
    claimedAgentId: claim,
    credentialPresented: context.agentCredentialPresented,
    validation,
    claimedPrincipalState: claimedState,
  });
  if (!decision.allowed) {
    recordAgentAuthDenial(context.agentAuthMode, decision.reason);
    throw new AgentAuthorizationError(
      `AGENT_${decision.reason.toUpperCase()}`,
      'Agent identity is not authorized for this operation',
      decision.reason === 'credential_required' ? 401 : 403,
    );
  }

  const effectiveAgentId = decision.boundAgentId ?? claim;
  if (effectiveAgentId == null) {
    // Observe is deliberately non-breaking: it inventories legacy calls that
    // still rely on handler defaults. Mixed/required remove that ambiguity.
    if (context.agentAuthMode === 'observe' && decision.legacy) {
      recordAgentAuthInvocation(context.agentAuthMode, 'legacy');
      return input;
    }
    recordAgentAuthDenial(context.agentAuthMode, 'agent_id_required');
    throw new AgentAuthorizationError(
      'AGENT_ID_REQUIRED',
      `${name} requires an explicit agent identity or valid agent credential`,
      401,
    );
  }
  if (!decision.legacy) assertAgentCredentialScope(context, rule.scope);

  input[rule.field] = effectiveAgentId;
  recordAgentAuthInvocation(
    context.agentAuthMode,
    decision.legacy ? 'legacy' : 'credential',
  );
  return input;
}

export function bindMessageResourceRecipient(
  uri: string,
  context: RequestContext,
  store: AgentCredentialStore,
): void {
  const prefix = 'engram://message/';
  if (!uri.startsWith(prefix)) {
    if (uri.startsWith('engram://snapshot/') || uri.startsWith('engram://handoff/')) {
      assertAgentCredentialScope(context, 'state:read');
    }
    return;
  }
  const segments = uri.slice(prefix.length).split('/');
  if (segments.length !== 3) {
    throw new AgentAuthorizationError('MESSAGE_RESOURCE_INVALID', 'Message resource URI is not recipient-bound', 400);
  }
  let recipient: string;
  try {
    recipient = decodeURIComponent(segments[1]);
  } catch {
    throw new AgentAuthorizationError('MESSAGE_RESOURCE_INVALID', 'Message resource recipient is invalid', 400);
  }
  bindAgentInvocation(
    'get_ai_messages',
    { agentId: recipient },
    context,
    store,
  );
}

export const AGENT_BOUND_TOOL_NAMES = Object.freeze([...AGENT_ID_RULES.keys()]);
