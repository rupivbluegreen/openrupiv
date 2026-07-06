/**
 * @openrupiv/policy — deny-by-default policy decision point (PDP), OPA/Rego
 * evaluated as embedded WASM (ADR-0006). Contract: specs/phase-2-contracts.md
 * §3.
 */

export {
  AUTHZ_WASM_PATH,
  createPolicyEngine,
} from "./engine";
export type {
  PolicyDecision,
  PolicyEngine,
  PolicyInput,
  PolicyResource,
  PolicySubject,
} from "./types";
