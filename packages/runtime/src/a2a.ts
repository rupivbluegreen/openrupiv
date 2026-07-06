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
import type { AgentTaskProcedureRegistry } from "./agent-tasks";
import type { Db } from "./db";
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

async function safeAudit(deps: A2aDeps, input: Parameters<AuditStore["append"]>[0]): Promise<boolean> {
  try {
    await deps.audit.append(input);
    return true;
  } catch {
    return false;
  }
}

export function registerA2aEndpoint(app: FastifyInstance, deps: A2aDeps): void {
  const clientById = new Map(deps.config.clients.map((c) => [c.clientId, c]));
  if (clientById.size === 0) return; // deny-by-default: no registered clients = endpoint disabled

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
      securitySchemes: { oauth2: { type: "oauth2" } },
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
      await safeAudit(deps, {
        event: "a2a.auth_rejected",
        actor: "system",
        actorType: "system",
        attributes: { reason: bearer ? "invalid_token" : "missing_token" },
      });
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
  const p = (params ?? {}) as { skill?: unknown; message?: { parts?: { kind?: string; data?: unknown }[] } };
  const skill = typeof p.skill === "string" ? p.skill : undefined;
  const dataPart = p.message?.parts?.find((part) => part.kind === "data");
  const input = (dataPart?.data ?? {}) as Record<string, unknown>;

  if (!skill || !client.allowedSkills.includes(skill)) {
    return reply.send(rpcError(id, -32602, `skill ${JSON.stringify(skill)} is not allowed for client ${client.clientId}`));
  }

  const identity = { id: `a2a:${client.clientId}`, roles: [] as string[] };
  const decision = await deps.policy.decide({
    subject: identity,
    action: `a2a.skill:${skill}`,
    resource: { type: "a2a.skill", id: skill, allowedRoles: [] },
  });
  const audited = await safeAudit(deps, {
    event: "a2a.call",
    actor: identity.id,
    actorType: "agent",
    subject: skill,
    decision: decision.allow ? "allow" : "deny",
    attributes: { skill, reason: decision.reason },
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
      status = "failed";
      result = { message: error instanceof AgentTaskNotFoundError ? error.message : String(error) };
    }
    if (ctx) {
      try {
        const outcome = await procedure(ctx, input);
        await ctx.finish(outcome);
        status = outcome.reason === "proposed" ? "completed" : "failed";
        result = outcome;
      } catch (error) {
        await ctx.finish({ reason: "error", detail: { message: error instanceof Error ? error.message : String(error) } });
        status = "failed";
        result = { message: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  await deps.db.query(
    "INSERT INTO a2a_tasks (id, client_id, skill, status, result) VALUES ($1,$2,$3,$4,$5)",
    [taskId, client.clientId, skill, status, JSON.stringify(result)],
  );
  await safeAudit(deps, {
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
