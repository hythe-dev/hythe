export type AgentPrincipalState = 'staged' | 'enforced' | 'disabled';
export type AgentCredentialStatus = 'active' | 'revoked';
export type AgentAuthMode = 'observe' | 'mixed' | 'required';

export interface AgentPrincipal {
  tenantId: string;
  agentId: string;
  displayName: string | null;
  enforcementState: AgentPrincipalState;
  createdAt: string;
  createdBy: string;
  promotedAt: string | null;
  promotedBy: string | null;
  disabledAt: string | null;
  disabledBy: string | null;
}

export interface AgentCredential {
  credentialId: string;
  tenantId: string;
  agentId: string;
  scopes: string[];
  status: AgentCredentialStatus;
  notBefore: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  replacedBy: string | null;
}

export type AgentCredentialFailure =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'hash_mismatch'
  | 'revoked'
  | 'not_yet_valid'
  | 'expired'
  | 'tenant_mismatch'
  | 'principal_disabled';

export type AgentCredentialValidation =
  | {
      valid: true;
      principal: AgentPrincipal;
      credential: AgentCredential;
    }
  | {
      valid: false;
      reason: AgentCredentialFailure;
      credentialId: string | null;
    };

export interface AgentAuthDecision {
  allowed: boolean;
  boundAgentId: string | null;
  credentialId: string | null;
  scopes: string[];
  legacy: boolean;
  auditOnly: boolean;
  reason:
    | 'credential_bound'
    | 'legacy_observed'
    | 'legacy_unclaimed'
    | 'credential_required'
    | 'claimed_identity_mismatch'
    | 'invalid_credential'
    | 'principal_disabled';
}
