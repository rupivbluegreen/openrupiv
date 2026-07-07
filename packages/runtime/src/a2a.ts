/**
 * A2A v1.0 endpoint (specs/phase-2-contracts.md §6): agent card discovery +
 * a minimal JSON-RPC 2.0 SendMessage/GetTask surface in front of the §4
 * agent runtime. Mirrors @openrupiv/mcp/src/server.ts's hand-rolled
 * dispatcher style — every request independently authenticated, policy- and
 * audit-gated before dispatch.
 *
 * PROPOSED interim bearer verification (flag for maintainer sign-off, see
 * this plan's header): a shared secret per registered client, named by an
 * env var (never the raw secret in config), NOT the OAuth client-credentials
 * grant the contract's open question 11 describes — implementing a real
 * token endpoint is out of scope for this wiring stage.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentRuntime } from "@openrupiv/agents";
import { AgentTaskNotFoundError } from "@openrupiv/agents";
import type { PolicyEngine } from "@openrupiv/policy";
import type { AppSpec } from "@openrupiv/spec";
import type { AuditStore } from "@openrupiv/audit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isSuccessOutcome, type AgentTaskOutcome, type AgentTaskProcedureRegistry } from "./agent-tasks";
import { auditBestEffort } from "./audit";
import { createRejectedCookieLimiter } from "./auth";
import type { Db } from "./db";
import { isUuid } from "./naming";
import type { Logger } from "./logger";

export const A2A_PROTOCOL_VERSION = "1.0";

export interface A2aClientEntry {
  clientId: string;
  displayName?: string;
  allowedSkills: string[];
  /** Env var NAME holding this client's shared bearer secret — never the value itself. */
  bearerTokenEnv: string;
}

export interface A2aConfig {
  clients: A2aClientEntry[];
  agentCardRequireAuth: boolean;
}

export interface A2aDeps {
  spec: AppSpec;
  config: A2aConfig;
  agentRuntime: AgentRuntime;
  procedures: AgentTaskProcedureRegistry;
  policy: PolicyEngine;
  audit: AuditStore;
  db: Db;
  logger: Logger;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function verifyA2aClient(bearer: string, clients: A2aClientEntry[]): A2aClientEntry | null {
  for (const client of clients) {
    const secret = process.env[client.bearerTokenEnv];
    if (secret && constantTimeEquals(bearer, secret)) return client;
  }
  return null;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0" as const, id: (id as string | number | null) ?? null, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: (id as string | number | null) ?? null, error: { code, message } };
}

export function registerA2aEndpoint(app: FastifyInstance, deps: A2aDeps): void {
  const clientById = new Map(deps.config.clients.map((c) => [c.clientId, c]));
  if (clientById.size === 0) return; // deny-by-default: no registered clients = endpoint disabled

  // Finding "a2a-unauth-unbounded-audit-writes": bounds how often a
  // rejected/missing A2A bearer durably audits `a2a.auth_rejected`,
  // independent of request rate -- the exact same bug class already fixed
  // for auth.ts's session cookie (`createRejectedCookieLimiter`) and
  // @openrupiv/mcp's `/mcp` bearer (`createRejectedTokenLimiter`), just
  // missed for A2A in that same commit. `createRejectedCookieLimiter`'s
  // algorithm is generic over "rejected credential value" despite its
  // cookie-flavored name -- reused directly here since a2a.ts lives in the
  // same package as auth.ts (no cross-package seam needed, unlike the MCP
  // case).
  const rejectedAuthLimiter = createRejectedCookieLimiter();

  app.get("/.well-known/agent-card.json", async (request: FastifyRequest, reply: FastifyReply) => {
    if (deps.config.agentCardRequireAuth) {
      const bearer = extractBearer(request.headers.authorization);
      if (!bearer || !verifyA2aClient(bearer, deps.config.clients)) {
        reply.code(401);
        return reply.send({ error: "unauthorized" });
      }
    }
    const skills = (deps.spec.agents ?? []).map((task) => ({ name: task.name, description: task.description ?? "" }));
    return reply.send({
      name: deps.spec.app.name,
      description: deps.spec.app.description ?? "",
      version: deps.spec.app.version,
      skills,
      // Finding "a2a-card-oauth2-mismatch": the endpoint's ACTUAL mechanism
      // is a per-client shared secret compared with `timingSafeEqual` (see
      // this file's header comment), not the OAuth 2.0 client-credentials
      // grant -- advertising `oauth2` here would send a real A2A client
      // down a discovery-driven flow that doesn't exist on this deployment.
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Shared secret per registered client (interim; see this package's README \"Interim, PROPOSED bearer-verification choices\" section for the planned OAuth 2.0 client-credentials migration).",
        },
      },
      url: "/a2a/v1",
    });
  });

  app.post("/a2a/v1", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } | undefined;
    const id = body?.id ?? null;

    const versionHeader = request.headers["a2a-version"];
    if (versionHeader !== A2A_PROTOCOL_VERSION) {
      reply.code(400);
      return reply.send(rpcError(id, -32000, `missing or unsupported A2A-Version header; expected "${A2A_PROTOCOL_VERSION}"`));
    }

    const bearer = extractBearer(request.headers.authorization);
    const client = bearer ? verifyA2aClient(bearer, deps.config.clients) : null;
    if (!client) {
      const reason = bearer ? "invalid_token" : "missing_token";
      // Always logged, at full fidelity, regardless of path or the
      // durable-append rate limit below -- only the audit-chain write (and
      // its chain-tail lock) is bounded, never the observability signal
      // (mirrors auth.ts's rejectedCookieLimiter usage).
      deps.logger.warn({ event: "a2a.auth_rejected", reason }, "A2A bearer rejected");
      // No credential value to hash for the missing-token case -- use the
      // empty-string sentinel so repeated no-bearer-at-all requests dedup
      // against each other exactly like a repeated bad token would (mirrors
      // rate-limit.ts's mcp equivalent).
      if (rejectedAuthLimiter.shouldAppend(bearer ?? "")) {
        await auditBestEffort(deps.audit, deps.logger, {
          event: "a2a.auth_rejected",
          actor: "system",
          actorType: "system",
          attributes: { reason },
        });
      }
      reply.code(401);
      return reply.send(rpcError(id, -32001, "Unauthorized"));
    }

    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      reply.code(400);
      return reply.send(rpcError(id, -32600, "Invalid Request"));
    }

    switch (body.method) {
      case "SendMessage":
        return handleSendMessage(body.params, id, client, deps, reply);
      case "GetTask":
        return handleGetTask(body.params, id, client, deps, reply);
      default:
        return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
    }
  });
}

async function handleSendMessage(
  params: unknown,
  id: unknown,
  client: A2aClientEntry,
  deps: A2aDeps,
  reply: FastifyReply,
) {
  const p = (params ?? {}) as { skill?: unknown; message?: { parts?: unknown } };
  const skill = typeof p.skill === "string" ? p.skill : undefined;
  // `params.message.parts` is caller-controlled: a truthy non-array (e.g. a
  // string, a number, a bare object) does not short-circuit the optional
  // chain above, but `.find` is not a function on those values -- guard with
  // Array.isArray before calling it (finding "a2a-sendMessage-parts-throw")
  // so a malformed value degrades to "no data part" instead of an unhandled
  // TypeError surfacing as a raw 500.
  const parts = Array.isArray(p.message?.parts)
    ? (p.message.parts as { kind?: string; data?: unknown }[])
    : [];
  const dataPart = parts.find((part) => part.kind === "data");
  const input = (dataPart?.data ?? {}) as Record<string, unknown>;

  const identity = { id: `a2a:${client.clientId}`, roles: [] as string[] };

  if (!skill || !client.allowedSkills.includes(skill)) {
    const audited = await auditBestEffort(deps.audit, deps.logger, {
      event: "a2a.call",
      actor: identity.id,
      actorType: "agent",
      ...(skill !== undefined ? { subject: skill } : {}),
      decision: "deny",
      attributes: { skill: skill ?? null, reason: "skill_not_allowed" },
    });
    if (!audited) {
      return reply.send(rpcError(id, -32000, "audit unavailable"));
    }
    return reply.send(rpcError(id, -32602, `skill ${JSON.stringify(skill)} is not allowed for client ${client.clientId}`));
  }

  const decision = await deps.policy.decide({
    subject: identity,
    action: `a2a.skill:${skill}`,
    resource: { type: "a2a.skill", id: skill, allowedRoles: [] },
  });
  const audited = await auditBestEffort(deps.audit, deps.logger, {
    event: "a2a.call",
    actor: identity.id,
    actorType: "agent",
    subject: skill,
    decision: decision.allow ? "allow" : "deny",
    // `policyId` (finding "a2a-policy-decision-convention"): every other PDP
    // decision point in this runtime (admin-agents.ts's `authorize()`)
    // records `policyId` alongside the allow/deny reason so forensic
    // analysts can trace which rule decided -- this combined `a2a.call`
    // event mirrors @openrupiv/mcp's own single-event `mcp.serve_call`
    // design (see packages/mcp/src/server.ts), just previously dropped
    // `policyId` from its attributes.
    attributes: { skill, reason: decision.reason, policyId: decision.policyId },
  });
  if (!audited) {
    return reply.send(rpcError(id, -32000, "audit unavailable"));
  }
  if (!decision.allow) {
    return reply.send(rpcError(id, -32001, `Forbidden: ${decision.reason}`));
  }

  const procedure = deps.procedures[skill];
  const taskId = randomUUID();
  let status: "completed" | "failed" = "completed";
  let result: unknown = null;

  if (!procedure) {
    status = "failed";
    result = { message: `skill ${JSON.stringify(skill)} has no registered procedure on this deployment` };
  } else {
    let ctx;
    try {
      ctx = deps.agentRuntime.contextFor(skill);
    } catch (error) {
      if (error instanceof AgentTaskNotFoundError) {
        result = { message: error.message };
      } else {
        deps.logger.error(
          { event: "a2a.task_lookup_failed", skill, clientId: client.clientId, err: error },
          "A2A contextFor lookup failed unexpectedly",
        );
        // Same scrubbing posture as the procedure-execution catch below: the
        // real detail is logged server-side only; the external, potentially
        // adversarial A2A caller only ever sees a generic message, mirroring
        // server.ts's ERR_INTERNAL scrubbing for unexpected errors.
        result = { message: "task lookup failed" };
      }
      status = "failed";
    }
    if (ctx) {
      // `ctx.finish()` is a non-idempotent audit append (packages/agents/src/
      // runtime.ts): the orchestrator must call it EXACTLY ONCE per run.
      // `outcome` stays `undefined` unless `procedure()` returns without
      // throwing, so the success-path `ctx.finish(outcome)` below is
      // reached only once, and is deliberately OUTSIDE this try/catch --
      // mirroring admin-agents.ts's equivalent handler -- so that if IT
      // itself throws, control does NOT fall into the catch block below and
      // call ctx.finish() a second time for the same run.
      let outcome: AgentTaskOutcome | undefined;
      try {
        outcome = await procedure(ctx, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error(
          { event: "a2a.task_failed", skill, clientId: client.clientId, err: error },
          "A2A task procedure failed unexpectedly",
        );
        // The real detail stays in the internal lifecycle/audit record
        // (ctx.finish); the external, potentially adversarial A2A caller only
        // ever sees a generic message, mirroring server.ts's ERR_INTERNAL
        // scrubbing for unexpected errors.
        await ctx.finish({ reason: "error", detail: { message } });
        status = "failed";
        result = { message: "task execution failed" };
      }
      if (outcome !== undefined) {
        await ctx.finish(outcome);
        status = isSuccessOutcome(outcome) ? "completed" : "failed";
        result = outcome;
      }
    }
  }

  await deps.db.query(
    "INSERT INTO a2a_tasks (id, client_id, skill, status, result) VALUES ($1,$2,$3,$4,$5)",
    [taskId, client.clientId, skill, status, JSON.stringify(result)],
  );
  // Deliberately best-effort, return value ignored: unlike the two earlier
  // `a2a.call` appends (which fail closed BEFORE the task runs), the task
  // has already executed by this point -- side effects like ctx.propose()
  // may already be committed. Failing the HTTP response here would tell the
  // caller the task didn't run when it genuinely did, so the real outcome
  // below is always returned regardless of whether this append lands.
  // `auditBestEffort` itself logs the full event at error level on failure,
  // so nothing is silently lost even though the response doesn't change.
  await auditBestEffort(deps.audit, deps.logger, {
    event: "a2a.result",
    actor: identity.id,
    actorType: "agent",
    subject: skill,
    attributes: { taskId, status },
  });

  return reply.send(rpcResult(id, { id: taskId, status: { state: status }, result }));
}

async function handleGetTask(params: unknown, id: unknown, client: A2aClientEntry, deps: A2aDeps, reply: FastifyReply) {
  const p = (params ?? {}) as { id?: unknown };
  const taskId = typeof p.id === "string" ? p.id : undefined;
  if (!taskId) {
    return reply.send(rpcError(id, -32602, "Invalid params: id is required"));
  }
  // `a2a_tasks.id` is `uuid` typed -- a non-UUID string reaching Postgres
  // raises an uncaught "invalid input syntax for type uuid" error, surfacing
  // as a generic 500 instead of a clean JSON-RPC -32602 (mirrors the
  // recordId check in agent-tasks.ts's vendorRiskReview procedure).
  if (!isUuid(taskId)) {
    return reply.send(rpcError(id, -32602, "Invalid params: id must be a UUID"));
  }
  const res = await deps.db.query("SELECT * FROM a2a_tasks WHERE id = $1 AND client_id = $2", [taskId, client.clientId]);
  const row = res.rows[0];
  if (!row) {
    return reply.send(rpcError(id, -32001, "task not found"));
  }
  return reply.send(
    rpcResult(id, {
      id: row["id"],
      status: { state: row["status"] },
      result: typeof row["result"] === "string" ? JSON.parse(row["result"] as string) : row["result"],
    }),
  );
}
