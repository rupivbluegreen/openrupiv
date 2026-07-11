/**
 * Supervisor HTTP server (ADR-0007, "Supervisor API"): exactly two routes.
 * `POST /v1/execute` is the only route a tool-calling client ever reaches;
 * `GET /healthz` is unauthenticated (Compose healthchecks, not tool
 * callers, hit it) and reports the boot canary's result. If the canary
 * failed, `/v1/execute` refuses every request with a typed 503 — there is
 * no fallback execution path.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CanaryResult } from "./canary";
import { ExecutionSemaphore, SandboxAtCapacityError } from "./concurrency";
import { resolveEntrypoint, EntrypointResolutionError } from "./entrypoint";
import { runJail, type JailOutcome, type RunJailInput } from "./jail-executor";
import { createLogger, type Logger } from "./logger";
import { extractRunId } from "./run-id";
import { tokensMatch } from "./token-auth";
import { cleanupWorkspace, createWorkspace } from "./workspace";

export interface ServerDeps {
  token: string;
  workspaceRoot: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  canaryResult: CanaryResult;
  logger?: Logger;
  runJailFn?: (input: RunJailInput) => Promise<JailOutcome>;
  concurrency?: { maxConcurrent: number; maxQueueDepth: number };
}

interface ExecuteRequestBody {
  runId?: unknown;
  tool?: unknown;
  input?: unknown;
  limits?: {
    wallClockMs?: unknown;
    memoryBytes?: unknown;
    maxOutputBytes?: unknown;
  };
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger();
  const runJailFn = deps.runJailFn ?? runJail;
  const semaphore = new ExecutionSemaphore(
    deps.concurrency?.maxConcurrent ?? 4,
    deps.concurrency?.maxQueueDepth ?? 8,
  );
  const app = Fastify({ logger: false });

  app.get("/healthz", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(deps.canaryResult.ok ? 200 : 503);
    return reply.send({ ok: deps.canaryResult.ok, assertions: deps.canaryResult.assertions, at: deps.canaryResult.at });
  });

  app.post("/v1/execute", async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request.headers.authorization);
    if (!bearer || !tokensMatch(bearer, deps.token)) {
      logger.warn({ event: "sandbox.auth_rejected", reason: bearer ? "invalid_token" : "missing_token" }, "rejected /v1/execute request");
      reply.code(401);
      return reply.send({ error: "ERR_SANDBOX_UNAUTHORIZED" });
    }

    if (!deps.canaryResult.ok) {
      reply.code(503);
      return reply.send({ error: "ERR_SANDBOX_UNHEALTHY", assertions: deps.canaryResult.assertions });
    }

    const body = request.body as ExecuteRequestBody;
    const runId = typeof body.runId === "string" ? extractRunId(`/${body.runId}`) : null;
    if (!runId) {
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_RUN_ID" });
    }

    const tool = typeof body.tool === "string" ? body.tool : null;
    let entrypointPath: string;
    try {
      if (!tool) throw new EntrypointResolutionError(String(tool), "missing");
      entrypointPath = resolveEntrypoint(tool, deps.toolRoot);
    } catch (err) {
      logger.warn({ event: "sandbox.entrypoint_rejected", tool, reason: errorMessage(err) }, "rejected tool entrypoint");
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_TOOL" });
    }

    const limits = {
      wallClockMs: Number(body.limits?.wallClockMs ?? 0),
      memoryBytes: Number(body.limits?.memoryBytes ?? 0),
      maxOutputBytes: Number(body.limits?.maxOutputBytes ?? 0),
    };
    if (!isPositiveFiniteLimit(limits.wallClockMs) || !isPositiveFiniteLimit(limits.memoryBytes) || !isPositiveFiniteLimit(limits.maxOutputBytes)) {
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_LIMITS" });
    }

    let release: () => void;
    try {
      release = await semaphore.acquire();
    } catch (err) {
      if (err instanceof SandboxAtCapacityError) {
        logger.warn({ event: "sandbox.at_capacity" }, "rejected /v1/execute: at capacity");
        reply.code(503);
        return reply.send({ error: "ERR_SANDBOX_AT_CAPACITY" });
      }
      throw err;
    }

    // release() must run on every path from here on (409, success, or any
    // throw) -- the slot is never leaked. Nested inside: cleanupWorkspace
    // must run ONLY for a workspace this request actually created. A
    // duplicate concurrent runId must never let request B delete request
    // A's still-active jail workspace (see workspace.ts's createWorkspace:
    // EEXIST means someone else already owns this runId's directory).
    try {
      let workspaceHostPath: string;
      try {
        workspaceHostPath = await createWorkspace(runId, deps.workspaceRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          logger.warn({ event: "sandbox.run_id_in_use", runId }, "rejected /v1/execute: runId already in flight");
          reply.code(409);
          return reply.send({ error: "ERR_SANDBOX_RUN_ID_IN_USE" });
        }
        throw err;
      }

      // We own this workspace now; its cleanup -- and only its cleanup --
      // is ours to run.
      try {
        const outcome = await runJailFn({
          entrypointPath,
          workspaceHostPath,
          pythonRoot: deps.pythonRoot,
          toolRoot: deps.toolRoot,
          seccompBpfPath: deps.seccompBpfPath,
          limits,
        });
        reply.code(200);
        return reply.send(outcome);
      } finally {
        await cleanupWorkspace(runId, deps.workspaceRoot, logger);
      }
    } finally {
      release();
    }
  });

  return app;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rejects 0, NaN/Infinity, and negatives -- every sandbox limit must be a
 * genuine positive, finite bound. `!x` alone (the prior check) let negative
 * values like `wallClockMs: -1` through, since `-1` is truthy. */
function isPositiveFiniteLimit(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}
