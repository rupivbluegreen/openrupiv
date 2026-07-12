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
import type { Db } from "./db";
import { isUuid, quoteIdent } from "./naming";

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
 * The one real `RegisteredTool` v1 ships: the `read-vendor-application` tool
 * implemented at `packages/sandbox/tools/read-vendor-application/main.py`, run
 * inside the ADR-0007 bwrap jail. `entrypoint` is a bare name that resolves to
 * `/opt/sandbox-tools/<entrypoint>/main.py` in the sidecar image (no `builtin:`
 * prefix — that would be rejected by the sidecar's bare-name entrypoint rule).
 *
 * Because the jail has NO network/DB access, this tool cannot fetch anything:
 * the trusted runtime (`vendorRiskReview` below) reads the record and passes
 * its risk-relevant fields as `input`; the tool computes a deterministic risk
 * verdict from that data alone. (The tool NAME is a little imprecise post-
 * reshape — the runtime does the read — but is kept to match the spec's
 * declared `tools: ["read-vendor-application"]` and avoid churning the golden
 * spec corpus; a rename is a cosmetic follow-up.)
 */
export const READ_VENDOR_APPLICATION_TOOL: RegisteredTool = {
  name: "read-vendor-application",
  description: "Assess a pre-fetched VendorApplication record's onboarding risk (deterministic; runs sandboxed with no network/DB).",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      annualSpend: { type: ["number", "null"] },
      justification: { type: ["string", "null"] },
      status: { type: ["string", "null"] },
    },
    additionalProperties: false,
  },
  entrypoint: "read-vendor-application",
};

export const DEMO_REGISTERED_TOOLS: RegisteredTool[] = [READ_VENDOR_APPLICATION_TOOL];

const VENDOR_APPLICATION_TABLE = "vendor_application";

async function vendorRiskReview(ctx: AgentContext, input: Record<string, unknown>, db: Db): Promise<AgentTaskOutcome> {
  const recordId = input["recordId"];
  if (typeof recordId !== "string" || !isUuid(recordId)) {
    return { reason: "invalid_input", detail: { message: "recordId must be a UUID" } };
  }

  // The jail has no DB access, so the trusted runtime reads the record here
  // and hands the risk-relevant fields to the sandboxed tool. Exact SQL shape
  // matches entities.ts's single-record read.
  const res = await db.query(`SELECT * FROM ${quoteIdent(VENDOR_APPLICATION_TABLE)} WHERE id = $1`, [recordId]);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { reason: "read_failed", detail: { message: `no ${VENDOR_APPLICATION_TABLE} record ${JSON.stringify(recordId)}` } };
  }

  const toolResult = await ctx.callTool({
    tool: "read-vendor-application",
    input: {
      annualSpend: (row["annual_spend"] as number | null | undefined) ?? null,
      justification: (row["justification"] as string | null | undefined) ?? null,
      status: (row["status"] as string | null | undefined) ?? null,
    },
  });
  if (!toolResult.ok) {
    return { reason: "read_failed", detail: { code: toolResult.code, message: toolResult.message } };
  }

  const verdict = (toolResult.output ?? {}) as { risk?: unknown; reasons?: unknown };
  if (verdict.risk !== "low") {
    // A high-risk (or malformed) verdict is a correct NON-proposing outcome:
    // the task ran and declined to recommend approval. isSuccessOutcome treats
    // only "proposed" as success, so this is reported as a non-success run
    // whose detail carries the actual verdict.
    return { reason: "declined_high_risk", detail: { risk: verdict.risk ?? null, reasons: verdict.reasons ?? null } };
  }

  const proposal = await ctx.propose({
    entityTable: VENDOR_APPLICATION_TABLE,
    recordId,
    workflow: "vendor-approval",
    transition: "approve",
    rationale: "Automated risk review found no blocking signals; recommending approval for human sign-off.",
  });
  return { reason: "proposed", detail: { proposalId: proposal.id, risk: verdict.risk } };
}

/**
 * Build the demo procedure registry closed over `db` — `vendorRiskReview`
 * needs to read the VendorApplication record (the sandboxed tool cannot),
 * which the static registry could not provide.
 */
export function createDemoProcedures(db: Db): AgentTaskProcedureRegistry {
  return {
    [VENDOR_RISK_REVIEW_TASK]: (ctx, input) => vendorRiskReview(ctx, input, db),
  };
}
