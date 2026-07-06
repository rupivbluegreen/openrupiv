/**
 * WASM-backed policy engine (ADR-0006). Loads the committed OPA bundle
 * (policy/authz.wasm) and evaluates it in-process — no sidecar, no network
 * hop, air-gap friendly. Deny-by-default is enforced HERE, in the wrapper,
 * not left to the policy: any evaluation error, missing result, or
 * non-boolean allow becomes a deny.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import type { PolicyDecision, PolicyEngine, PolicyInput } from "./types";

const POLICY_ID = "openrupiv.authz";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Committed compiled bundle; rebuild with `pnpm --filter @openrupiv/policy build:policy`. */
export const AUTHZ_WASM_PATH = path.resolve(here, "../policy/authz.wasm");

/** The Rego entrypoint's input shape (snake_case, matching authz.rego). */
interface RegoInput {
  subject: { id: string; roles: string[] };
  action: string;
  resource: { type: string; id?: string; allowed_roles: string[] };
  context: Record<string, unknown>;
}

function toRegoInput(input: PolicyInput): RegoInput {
  return {
    subject: { id: input.subject.id, roles: input.subject.roles },
    action: input.action,
    resource: {
      type: input.resource.type,
      ...(input.resource.id !== undefined ? { id: input.resource.id } : {}),
      allowed_roles: input.resource.allowedRoles,
    },
    context: input.context ?? {},
  };
}

interface LoadedPolicy {
  setData(data: unknown): void;
  evaluate(input: unknown): Array<{ result?: unknown }>;
}

/**
 * Create a PDP from a compiled WASM bundle. Defaults to the committed
 * authz.wasm; a caller may supply an alternative bundle path (e.g. a custom
 * org policy). The bundle is loaded once and reused.
 */
export async function createPolicyEngine(
  opts: { wasmPath?: string } = {},
): Promise<PolicyEngine> {
  const wasmPath = opts.wasmPath ?? AUTHZ_WASM_PATH;
  const wasm = await readFile(wasmPath);
  const policy = (await loadPolicy(wasm)) as LoadedPolicy;
  policy.setData({});

  return {
    async decide(input: PolicyInput): Promise<PolicyDecision> {
      try {
        const resultSet = policy.evaluate(toRegoInput(input));
        const decision = resultSet?.[0]?.result as
          | { allow?: unknown; reason?: unknown }
          | undefined;
        // Deny-by-default: anything other than an explicit boolean true denies.
        const allow = decision?.allow === true;
        const reason =
          typeof decision?.reason === "string"
            ? decision.reason
            : allow
              ? "allowed"
              : "denied by default (no matching policy result)";
        return { allow, reason, policyId: POLICY_ID };
      } catch (err) {
        // A policy that fails to evaluate must FAIL CLOSED, never open.
        const message = err instanceof Error ? err.message : String(err);
        return {
          allow: false,
          reason: `policy evaluation error (fail-closed): ${message}`,
          policyId: POLICY_ID,
        };
      }
    },
  };
}
