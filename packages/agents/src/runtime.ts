/**
 * `createAgentRuntime` -- see specs/phase-2-contracts.md §4.
 *
 * `callTool` enforcement order, every step fails closed (mirrors
 * `workflows.ts`'s style: typed results, no partial side effects):
 *   1. `task.tools` allowlist               -> ERR_TOOL_NOT_ALLOWED
 *   2. registered tool + `inputSchema`       -> ERR_TOOL_UNKNOWN / ERR_TOOL_INPUT
 *   3. `policy.decide`                       -> (deny recorded below, not yet returned)
 *   4. audit `agent.tool_call` BEFORE exec   -> ERR_AUDIT_UNAVAILABLE if the append
 *      itself fails; a policy DENY is still audited here, THEN returned as
 *      ERR_POLICY_DENIED (audit-then-return, never audit-only-on-allow)
 *   5. `sandbox.execute`
 *   6. audit `agent.tool_result` AFTER (best-effort -- see README.md
 *      "Best-effort after-audit"; only step 4's BEFORE append is fail-closed)
 *
 * See README.md for the design notes on three places this file had to
 * interpret an underspecified corner of the §4 contract: the
 * `agent.task_started`/`agent.task_finished` lifecycle boundary, the fixed
 * `SandboxLimits`/`workspaceDir` defaults (createAgentRuntime's `deps` has
 * no channel to override them), and the `AppSpec.agents` v0.1/v0.2 type gap.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { appendInTransaction } from "@openrupiv/audit";
import type { AuditStore } from "@openrupiv/audit";
import type { PolicyEngine } from "@openrupiv/policy";
import type { AppSpec } from "@openrupiv/spec";
import { AgentTaskNotFoundError } from "./errors";
import { digestValue } from "./hashing";
import { AGENT_PROPOSALS_DDL } from "./migration";
import type {
  AgentContext,
  AgentIdentity,
  AgentProposal,
  AgentRuntime,
  AgentTaskDef,
  Db,
  Queryable,
  RegisteredTool,
  SandboxExecuteResult,
  SandboxLimits,
  ToolCallRequest,
  ToolCallResult,
  ToolSandbox,
} from "./types";

export { AGENT_PROPOSALS_DDL };

/**
 * ADR-0007's fixed defaults (30s / 256MiB / 1MiB). The §4 contract requires
 * `SandboxLimits` be populated with *some* value -- the concrete numbers are
 * ADR-0007's call, reproduced here because `createAgentRuntime`'s `deps`
 * (as literally specified) has no field to inject an override. See
 * README.md "Sandbox limits and workspaceDir are fixed in this package".
 */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  wallClockMs: 30_000,
  memoryBytes: 268_435_456,
  maxOutputBytes: 1_048_576,
};

/**
 * Per ADR-0007 ("`runId` handling"), `workspaceDir`'s value is opaque beyond
 * its final path segment: the real sandbox (`createSidecarSandbox`)
 * extracts and re-validates that segment as a `runId` and creates/deletes
 * the actual host directory itself. This package never touches the
 * filesystem for it -- it only needs to hand the sandbox a fresh,
 * per-call identifier in the shape the contract's field name promises.
 */
const WORKSPACE_ROOT = "/workspaces";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapSandboxResult(result: SandboxExecuteResult): ToolCallResult {
  if (result.ok) return { ok: true, output: result.output };
  if (result.reason === "violation") {
    return { ok: false, code: "ERR_SANDBOX_VIOLATION", message: result.message };
  }
  if (result.reason === "limit") {
    return { ok: false, code: "ERR_SANDBOX_LIMIT", message: result.message };
  }
  return { ok: false, code: "ERR_TOOL_FAILED", message: result.message };
}

/** Never the raw output -- just enough shape to digest a stable summary of it. */
function outputForDigest(result: SandboxExecuteResult): unknown {
  if (result.ok) return result.output;
  if (result.reason === "violation") {
    return { reason: result.reason, violation: result.violation, message: result.message };
  }
  if (result.reason === "limit") {
    return { reason: result.reason, limit: result.limit, message: result.message };
  }
  return { reason: result.reason, message: result.message };
}

function rowToProposal(row: Record<string, unknown>): AgentProposal {
  const createdAt = row["created_at"];
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    entityTable: String(row["entity_table"]),
    recordId: String(row["record_id"]),
    workflow: String(row["workflow"]),
    transition: String(row["transition"]),
    rationale: String(row["rationale"]),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}

export interface CreateAgentRuntimeDeps {
  /** Structural seam -- see types.ts's `Db` doc comment. */
  db: Db;
  policy: PolicyEngine;
  audit: AuditStore;
  sandbox: ToolSandbox;
  tools: RegisteredTool[];
  clock?: () => string;
}

export function createAgentRuntime(
  spec: AppSpec,
  deps: CreateAgentRuntimeDeps,
): AgentRuntime {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const toolsByName = new Map(deps.tools.map((t) => [t.name, t]));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map<string, ValidateFunction>();

  function validatorFor(tool: RegisteredTool): ValidateFunction {
    let v = validators.get(tool.name);
    if (!v) {
      v = ajv.compile(tool.inputSchema);
      validators.set(tool.name, v);
    }
    return v;
  }

  const tasksByName = new Map<string, AgentTaskDef>();
  // See README.md "Spec v0.1/v0.2 type gap": @openrupiv/spec's current
  // AppSpec type still types `agents` with the reserved v0.1 shape (name +
  // description only, `additionalProperties: false` in its JSON Schema).
  // The §4 contract says createAgentRuntime "can assume it receives an
  // already-validated AppSpec" -- i.e. once @openrupiv/spec lands its v0.2
  // schema bump, a real `tools`/`proposes`-bearing value will structurally
  // match `AgentTaskDef` below even though today's imported TS type doesn't
  // expose those fields. This cast is the deliberate bridge; it is not
  // silently unsafe because nothing downstream trusts absent `tools` as
  // anything other than "may call no tools" (deny-by-default).
  for (const raw of spec.agents ?? []) {
    const task = raw as unknown as AgentTaskDef;
    tasksByName.set(task.name, task);
  }

  async function callTool(
    identity: AgentIdentity,
    task: AgentTaskDef,
    req: ToolCallRequest,
  ): Promise<ToolCallResult> {
    // 1. allowlist -- deny-by-default: absent/empty `tools` = no calls at all.
    if (!(task.tools ?? []).includes(req.tool)) {
      return {
        ok: false,
        code: "ERR_TOOL_NOT_ALLOWED",
        message: `task ${JSON.stringify(task.name)} may not call tool ${JSON.stringify(req.tool)}`,
      };
    }

    // 2. registered tool + input schema (JSON Schema draft 2020-12, via ajv).
    const tool = toolsByName.get(req.tool);
    if (!tool) {
      return {
        ok: false,
        code: "ERR_TOOL_UNKNOWN",
        message: `no registered tool named ${JSON.stringify(req.tool)}`,
      };
    }
    const validate = validatorFor(tool);
    if (!validate(req.input)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ");
      return {
        ok: false,
        code: "ERR_TOOL_INPUT",
        message: `input for tool ${JSON.stringify(req.tool)} failed schema validation: ${detail}`,
      };
    }

    // 3. policy.decide -- deny-by-default PDP; the decision is recorded in
    // step 4 regardless of outcome, and only returned to the caller after.
    const decision = await deps.policy.decide({
      subject: { id: identity.id, roles: identity.roles },
      action: `agent.tool:${req.tool}`,
      resource: { type: "agent.tool", id: req.tool, allowedRoles: [] },
      context: { task: task.name },
    });

    // 4. audit `agent.tool_call` BEFORE execution -- fail-closed: an append
    // failure here means the tool is NOT executed, independent of the
    // policy decision. Attributes carry a digest + byte size of the
    // canonicalized input, never the raw value.
    const { digest: inputDigest, bytes: inputBytes } = digestValue(req.input);
    try {
      await deps.audit.append({
        event: "agent.tool_call",
        actor: identity.id,
        actorType: "agent",
        decision: decision.allow ? "allow" : "deny",
        attributes: {
          task: task.name,
          tool: req.tool,
          inputDigest,
          inputBytes,
          policyReason: decision.reason,
          policyId: decision.policyId,
        },
      });
    } catch (err) {
      return {
        ok: false,
        code: "ERR_AUDIT_UNAVAILABLE",
        message: `audit append failed before tool execution: ${errorMessage(err)}`,
      };
    }

    if (!decision.allow) {
      return { ok: false, code: "ERR_POLICY_DENIED", message: decision.reason };
    }

    // 5. sandbox.execute -- workspaceDir/limits are this package's only
    // contribution to the sandbox boundary; see README.md.
    const workspaceDir = path.posix.join(WORKSPACE_ROOT, randomUUID());
    const result = await deps.sandbox.execute({
      tool,
      input: req.input,
      workspaceDir,
      limits: DEFAULT_SANDBOX_LIMITS,
    });

    // 6. audit `agent.tool_result` AFTER -- best-effort (see README.md
    // "Best-effort after-audit"): the tool has already executed by this
    // point, and the §4 contract's fail-closed requirement names only the
    // BEFORE append in step 4.
    const { digest: outputDigest, bytes: outputBytes } = digestValue(
      outputForDigest(result),
    );
    try {
      await deps.audit.append({
        event: "agent.tool_result",
        actor: identity.id,
        actorType: "agent",
        decision: result.ok ? "allow" : "deny",
        attributes: {
          task: task.name,
          tool: req.tool,
          outcome: result.ok ? "ok" : result.reason,
          durationMs: result.durationMs,
          outputDigest,
          outputBytes,
        },
      });
    } catch {
      // Best-effort; the caller still gets the real tool outcome below.
    }

    return mapSandboxResult(result);
  }

  async function propose(
    identity: AgentIdentity,
    task: AgentTaskDef,
    p: Omit<AgentProposal, "id" | "agentId" | "createdAt">,
  ): Promise<AgentProposal> {
    // HITL: insert `agent_proposals` + audit `agent.transition_proposed` in
    // the SAME transaction, fail-closed and atomic. Never touches
    // `workflow_approvals` or any entity table -- there is no code path to
    // either (this package has no dependency on @openrupiv/runtime or any
    // workflow logic; see README.md "propose() cannot reach workflow state").
    const proposal = await deps.db.transaction(async (tx: Queryable) => {
      const id = randomUUID();
      const createdAt = clock();
      await tx.query(
        "INSERT INTO agent_proposals (id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, identity.id, p.entityTable, p.recordId, p.workflow, p.transition, p.rationale, createdAt],
      );
      await appendInTransaction(
        tx,
        {
          event: "agent.transition_proposed",
          actor: identity.id,
          actorType: "agent",
          subject: `${p.entityTable}:${p.recordId}`,
          attributes: {
            task: task.name,
            workflow: p.workflow,
            transition: p.transition,
            proposalId: id,
          },
        },
        { clock },
      );
      const created: AgentProposal = {
        id,
        agentId: identity.id,
        entityTable: p.entityTable,
        recordId: p.recordId,
        workflow: p.workflow,
        transition: p.transition,
        rationale: p.rationale,
        createdAt,
      };
      return created;
    });

    // Lifecycle: see README.md "Lifecycle boundaries" -- `propose()` is the
    // one clearly-terminal signal `AgentContext` exposes, so a successful
    // proposal also emits `agent.task_finished`. Awaited (unlike
    // `task_started` in `contextFor`, which is synchronous) but best-effort:
    // a failure here must not undo the already-committed proposal.
    try {
      await deps.audit.append({
        event: "agent.task_finished",
        actor: identity.id,
        actorType: "agent",
        attributes: { task: task.name, reason: "proposal_submitted", proposalId: proposal.id },
      });
    } catch {
      // best-effort; see README.md.
    }

    return proposal;
  }

  function contextFor(taskName: string): AgentContext {
    const task = tasksByName.get(taskName);
    if (!task) {
      throw new AgentTaskNotFoundError(taskName);
    }
    const identity: AgentIdentity = { id: `agent:${taskName}@${spec.app.slug}`, roles: [] };

    // Lifecycle: see README.md "Lifecycle boundaries". `contextFor` is
    // SYNCHRONOUS per the §4 contract (`contextFor(taskName): AgentContext`,
    // not `Promise<AgentContext>`), so there is no way to fail closed on
    // this append from here -- best-effort, fire-and-forget.
    void deps.audit
      .append({
        event: "agent.task_started",
        actor: identity.id,
        actorType: "agent",
        attributes: { task: taskName },
      })
      .catch(() => {
        // best-effort; see README.md.
      });

    return {
      identity,
      task,
      callTool: (req) => callTool(identity, task, req),
      propose: (p) => propose(identity, task, p),
    };
  }

  async function listProposals(
    opts: { workflow?: string; recordId?: string } = {},
  ): Promise<AgentProposal[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.workflow !== undefined) {
      params.push(opts.workflow);
      conditions.push(`workflow = $${params.length}`);
    }
    if (opts.recordId !== undefined) {
      params.push(opts.recordId);
      conditions.push(`record_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const res = await deps.db.query(
      `SELECT id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at FROM agent_proposals${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return res.rows.map(rowToProposal);
  }

  return { contextFor, listProposals };
}
