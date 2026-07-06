/**
 * Policy decision point (PDP) types. The runtime calls `decide` before any
 * privileged action (workflow transitions, and later agent tool calls, MCP,
 * A2A). Deny-by-default: the engine returns allow:false unless the policy
 * explicitly permits, and every decision carries a reason for the audit log.
 */

export interface PolicySubject {
  /** OIDC sub, agent id, or "system". */
  id: string;
  roles: string[];
}

export interface PolicyResource {
  /** e.g. "workflow.transition". */
  type: string;
  /** Optional concrete resource id, e.g. "vendor_application:<uuid>". */
  id?: string;
  /** Roles that satisfy this action; empty means "any authenticated subject". */
  allowedRoles: string[];
}

export interface PolicyInput {
  subject: PolicySubject;
  /** The action being attempted, e.g. "workflow.transition:approve". */
  action: string;
  resource: PolicyResource;
  /** Extra attributes available to the policy. */
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  /** Identifier of the policy bundle that produced the decision. */
  policyId: string;
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecision>;
}
