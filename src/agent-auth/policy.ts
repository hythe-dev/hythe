import type {
  AgentAuthDecision,
  AgentAuthMode,
  AgentCredentialValidation,
  AgentPrincipalState,
} from './types.js';

export interface AgentAuthPolicyInput {
  mode: AgentAuthMode;
  claimedAgentId?: string | null;
  credentialPresented: boolean;
  validation: AgentCredentialValidation;
  claimedPrincipalState?: AgentPrincipalState | null;
}

/**
 * Decide whether an agent-owned operation may proceed. An invalid presented
 * credential never falls back to shared-key identity. In mixed mode an
 * enforced or disabled exact principal is downgrade-resistant.
 */
export function decideAgentAuthorization(input: AgentAuthPolicyInput): AgentAuthDecision {
  if (input.credentialPresented) {
    if (!input.validation.valid) {
      return {
        allowed: false,
        boundAgentId: null,
        credentialId: input.validation.credentialId,
        scopes: [],
        legacy: false,
        auditOnly: false,
        reason: 'invalid_credential',
      };
    }

    const { principal, credential } = input.validation;
    if (principal.enforcementState === 'disabled') {
      return {
        allowed: false,
        boundAgentId: null,
        credentialId: credential.credentialId,
        scopes: [],
        legacy: false,
        auditOnly: false,
        reason: 'principal_disabled',
      };
    }
    if (input.claimedAgentId != null && input.claimedAgentId !== principal.agentId) {
      return {
        allowed: false,
        boundAgentId: null,
        credentialId: credential.credentialId,
        scopes: [],
        legacy: false,
        auditOnly: false,
        reason: 'claimed_identity_mismatch',
      };
    }
    return {
      allowed: true,
      boundAgentId: principal.agentId,
      credentialId: credential.credentialId,
      scopes: credential.scopes,
      legacy: false,
      auditOnly: input.mode === 'observe',
      reason: 'credential_bound',
    };
  }

  if (input.mode === 'required') {
    return {
      allowed: false,
      boundAgentId: null,
      credentialId: null,
      scopes: [],
      legacy: false,
      auditOnly: false,
      reason: 'credential_required',
    };
  }

  // Disabled principals are permanently reserved in every rollout mode;
  // observe may audit an enforced principal, but it must never resurrect a
  // deliberately disabled identity through a legacy assertion.
  if (input.claimedPrincipalState === 'disabled') {
    return {
      allowed: false,
      boundAgentId: null,
      credentialId: null,
      scopes: [],
      legacy: false,
      auditOnly: false,
      reason: 'principal_disabled',
    };
  }

  if (input.mode === 'mixed' && input.claimedPrincipalState === 'enforced') {
    return {
      allowed: false,
      boundAgentId: null,
      credentialId: null,
      scopes: [],
      legacy: false,
      auditOnly: false,
      reason: 'credential_required',
    };
  }

  return {
    allowed: true,
    boundAgentId: input.claimedAgentId ?? null,
    credentialId: null,
    scopes: [],
    legacy: true,
    auditOnly: input.mode === 'observe',
    reason: input.mode === 'observe' ? 'legacy_observed' : 'legacy_unclaimed',
  };
}
