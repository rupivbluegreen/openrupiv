/**
 * Admin agent-trigger + proposal-listing routes:
 *   POST /admin/agents/:task/run   — run a spec-declared agent task's fixed procedure
 *   GET  /admin/agent-proposals    — list agent_proposals (specs/phase-2-contracts.md §4, open question 6)
 *
 * AUTHORIZATION — human maintainer review required (CLAUDE.md). Gated the
 * same way as /admin/audit (admin.ts): a session, a PDP decision (audited,
 * allow AND deny, fail-closed), platform-level roles not sourced from the
 * app spec.
 */
import type { AgentRuntime } from "@openrupiv/agents";
import { AgentTaskNotFoundError } from "@openrupiv/agents";
import type { PolicyEngine } from "@openrupiv/policy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isSuccessOutcome, type AgentTaskProcedureRegistry } from "./agent-tasks";
import { appendOrFail } from "./audit";
import type { AuditStore } from "@openrupiv/audit";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";
import { isUuid } from "./naming";

export const AGENT_TRIGGER_ROLES: readonly string[] = ["admin"];

export interface AdminAgentsDeps {
  runtime: AgentRuntime;
  procedures: AgentTaskProcedureRegistry;
  policy: PolicyEngine;
  audit: AuditStore;
  logger: Logger;
  /**
   * Roles the ACTIVE APP SPEC declares (`spec.app.roles`) for its own domain
   * purposes. Excluded from the subject's effective role set for the
   * `agent.trigger` decision below — see admin.ts's "audit-role-namespace-collision" finding.
   */
  appRoles: readonly string[];
}

async function authorize(
  request: FastifyRequest,
  deps: AdminAgentsDeps,
  appRoleSet: ReadonlySet<string>,
  taskName: string,
): Promise<void> {
  const session = request.session;
  if (!session) {
    throw new RuntimeError("ERR_UNAUTHENTICATED", "authentication required", { statusCode: 401 });
  }
  // Namespace-collision fix (see admin.ts's "audit-role-namespace-collision"
  // finding): strip any role also declared by the app spec from the
  // subject's EFFECTIVE role set before asking the PDP — an app can never
  // make its own declared role satisfy this platform check this way, even
  // on a literal string match like "admin". AGENT_TRIGGER_ROLES itself is
  // never touched.
  const platformRoles = session.roles.filter((role) => !appRoleSet.has(role));
  const decision = await deps.policy.decide({
    subject: { id: session.sub, roles: platformRoles },
    action: "agent.trigger",
    resource: { type: "agent.task", id: taskName, allowedRoles: [...AGENT_TRIGGER_ROLES] },
  });
  await appendOrFail(deps.audit, deps.logger, {
    event: "policy.decision",
    actor: session.sub,
    actorType: "human",
    subject: `agent_task:${taskName}`,
    decision: decision.allow ? "allow" : "deny",
    attributes: { action: "agent.trigger", allowedRoles: [...AGENT_TRIGGER_ROLES], policyId: decision.policyId, reason: decision.reason },
  });
  if (!decision.allow) {
    throw new RuntimeError(
      "ERR_FORBIDDEN_ROLE",
      `triggering agent task ${JSON.stringify(taskName)} requires one of roles ${JSON.stringify(AGENT_TRIGGER_ROLES)}`,
      { statusCode: 403, details: { requiredRoles: AGENT_TRIGGER_ROLES, reason: decision.reason } },
    );
  }
}

export function registerAdminAgentRoutes(app: FastifyInstance, deps: AdminAgentsDeps): void {
  const { appRoles } = deps;
  const appRoleSet = new Set(appRoles);

  app.post<{ Params: { task: string }; Body: Record<string, unknown> }>(
    "/admin/agents/:task/run",
    async (request, reply) => {
      const taskName = request.params.task;
      await authorize(request, deps, appRoleSet, taskName);

      // Check the task is declared in the spec FIRST (404 if not) — only a
      // task that exists in the spec but lacks a registered procedure on
      // this deployment is ERR_AGENT_PROCEDURE_UNREGISTERED (501); see that
      // error code's doc comment in errors.ts.
      let ctx;
      try {
        ctx = deps.runtime.contextFor(taskName);
      } catch (error) {
        if (error instanceof AgentTaskNotFoundError) {
          throw new RuntimeError("ERR_NOT_FOUND", error.message, { statusCode: 404 });
        }
        throw error;
      }

      const procedure = deps.procedures[taskName];
      if (!procedure) {
        // contextFor() above already emitted agent.task_started; finish()
        // here so that record always has a matching agent.task_finished,
        // even on this "never actually ran" 501 path.
        await ctx.finish({
          reason: "error",
          detail: { message: `no registered procedure for task ${JSON.stringify(taskName)}` },
        });
        throw new RuntimeError(
          "ERR_AGENT_PROCEDURE_UNREGISTERED",
          `agent task ${JSON.stringify(taskName)} has no registered procedure on this deployment`,
          { statusCode: 501 },
        );
      }

      let outcome;
      try {
        outcome = await procedure(ctx, request.body ?? {});
      } catch (error) {
        await ctx.finish({ reason: "error", detail: { message: error instanceof Error ? error.message : String(error) } });
        throw error;
      }
      await ctx.finish(outcome);
      const status = isSuccessOutcome(outcome) ? "completed" : "failed";
      await reply.code(202).send({ status, ...outcome });
    },
  );

  app.get<{ Querystring: { workflow?: string; recordId?: string } }>(
    "/admin/agent-proposals",
    async (request, reply) => {
      await authorize(request, deps, appRoleSet, "*");
      // `agent_proposals.record_id` is `uuid` typed -- a non-UUID string
      // reaching Postgres raises an uncaught "invalid input syntax for type
      // uuid" error, surfacing as a generic 500 instead of a clean 400
      // (finding "admin-agent-proposals-recordId-validation"; same bug
      // class as a2a.ts's GetTask id check). `workflow` is a plain text
      // field and needs no such guard.
      if (request.query.recordId !== undefined && !isUuid(request.query.recordId)) {
        throw new RuntimeError("ERR_VALIDATION", "recordId must be a UUID", { statusCode: 400 });
      }
      const proposals = await deps.runtime.listProposals({
        ...(request.query.workflow !== undefined ? { workflow: request.query.workflow } : {}),
        ...(request.query.recordId !== undefined ? { recordId: request.query.recordId } : {}),
      });
      await reply.send({ proposals });
    },
  );
}
