/**
 * Agent task-procedure registry — the "deterministic script" behind each
 * spec-declared agent task (specs/phase-2-contracts.md §4, open question 1:
 * "the decision loop is deterministic-script-only"). Mirrors the existing
 * RegisteredTool[] static in-code registry pattern (§4, open question 2): a
 * hardcoded, ship-time-fixed mapping from task name to procedure, populated
 * at process startup. PROPOSED design — flagged for maintainer review
 * alongside the rest of this wiring (human-only review path).
 */
import type { AgentContext, RegisteredTool } from "@openrupiv/agents";
import { isUuid } from "./naming";

export interface AgentTaskOutcome {
  reason: string;
  detail?: Record<string, unknown>;
}

/**
 * The one shared decision point for "did this task run succeed" (finding
 * "admin-a2a-outcome-status-mismatch": the admin trigger route and the A2A
 * `SendMessage` handler used to derive `status` independently and
 * disagreed for the identical outcome). `"proposed"` is `vendorRiskReview`'s
 * only success `reason` — its other reasons (`"invalid_input"`,
 * `"read_failed"`) and the generic `"error"` reason used by both callers'
 * unexpected-throw paths are all failures. Both `admin-agents.ts` and
 * `a2a.ts` must call this instead of each re-deriving the same check.
 */
export function isSuccessOutcome(outcome: AgentTaskOutcome): boolean {
  return outcome.reason === "proposed";
}

/** A task's fixed procedure: drives zero or more callTool/propose calls. The caller (admin route or A2A dispatch) invokes ctx.finish(outcome) afterward — the procedure itself never calls finish(). */
export type AgentTaskProcedure = (
  ctx: AgentContext,
  input: Record<string, unknown>,
) => Promise<AgentTaskOutcome>;

export type AgentTaskProcedureRegistry = Record<string, AgentTaskProcedure>;

export const VENDOR_RISK_REVIEW_TASK = "vendor-risk-review";

/**
 * Read-only tool declaration for the demo task. This is a DECLARATION only
 * (name/description/inputSchema/entrypoint) — per specs/phase-2-contracts.md
 * §4 open question 2, the actual implementation behind `entrypoint` runs
 * exclusively inside the ADR-0007 sandbox boundary, which does not exist in
 * this codebase yet (packages/sandbox, a separate later stage). There is
 * deliberately no handler function here.
 */
export const READ_VENDOR_APPLICATION_TOOL: RegisteredTool = {
  name: "read-vendor-application",
  description: "Read-only: fetch a VendorApplication record's current state and key attributes by id.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  entrypoint: "builtin:read-vendor-application",
};

export const DEMO_REGISTERED_TOOLS: RegisteredTool[] = [READ_VENDOR_APPLICATION_TOOL];

async function vendorRiskReview(ctx: AgentContext, input: Record<string, unknown>): Promise<AgentTaskOutcome> {
  const recordId = input["recordId"];
  if (typeof recordId !== "string" || !isUuid(recordId)) {
    return { reason: "invalid_input", detail: { message: "recordId must be a UUID" } };
  }

  const readResult = await ctx.callTool({ tool: "read-vendor-application", input: { id: recordId } });
  if (!readResult.ok) {
    return { reason: "read_failed", detail: { code: readResult.code, message: readResult.message } };
  }

  const proposal = await ctx.propose({
    entityTable: "vendor_application",
    recordId,
    workflow: "vendor-approval",
    transition: "approve",
    rationale:
      "Automated risk review found no blocking signals in the current record state; recommending approval for human sign-off.",
  });
  return { reason: "proposed", detail: { proposalId: proposal.id } };
}

export const DEMO_TASK_PROCEDURES: AgentTaskProcedureRegistry = {
  [VENDOR_RISK_REVIEW_TASK]: vendorRiskReview,
};
