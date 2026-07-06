/**
 * Server assembly per specs/phase-1-contracts.md §2: loadAppDir,
 * createServer (Fastify 5), serveAppDir.
 *
 * createServer wires: cookie/formbody parsing, the auth gate (auth.ts),
 * entity CRUD, workflow transitions, SSR pages, /healthz, a typed error
 * handler, and structured request logging (with redaction; query strings are
 * never logged — they can carry OAuth codes).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import type { AgentRuntime } from "@openrupiv/agents";
import type { AuditStore } from "@openrupiv/audit";
import { createMcpClient, type McpClient } from "@openrupiv/mcp";
import { createPolicyEngine, type PolicyEngine } from "@openrupiv/policy";
import { validateSpec, type AppSpec } from "@openrupiv/spec";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminAuditRoutes } from "./admin";
import { registerAdminAgentRoutes } from "./admin-agents";
import type { AgentTaskProcedureRegistry } from "./agent-tasks";
import { createDbAuditStore } from "./audit";
import { defaultOidcProvider, registerAuth, type OidcProvider } from "./auth";
import { assertRuntimeConfig, configFromEnv, type RuntimeConfig } from "./config";
import { createPgDb, type Db } from "./db";
import { registerEntityRoutes } from "./entities";
import { RuntimeError } from "./errors";
import { createLogger, type Logger } from "./logger";
import { applyMigrations, ensureInfraTables } from "./migrate";
import { registerPages } from "./pages";
import { registerWorkflowRoutes } from "./workflows";

/**
 * Load an ADR-0004 app directory: read + validate `spec.json`. Throws
 * ERR_APP_DIR (missing/unreadable) or ERR_APP_SPEC_INVALID (bad JSON or
 * failed validateSpec, with the SpecError[] in details).
 */
export async function loadAppDir(dir: string): Promise<AppSpec> {
  const specPath = path.join(dir, "spec.json");
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      "ERR_APP_DIR",
      `cannot read app spec at ${specPath}: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      "ERR_APP_SPEC_INVALID",
      `${specPath} is not valid JSON: ${message}`,
    );
  }

  const result = validateSpec(parsed);
  if (!result.ok) {
    throw new RuntimeError(
      "ERR_APP_SPEC_INVALID",
      `${specPath} failed spec validation with ${result.errors.length} error(s)`,
      { details: result.errors },
    );
  }
  return result.spec;
}

/**
 * Load an MCP client config (@openrupiv/mcp) from a JSON file at `path`.
 * Throws ERR_CONFIG if the file is missing/unreadable, not valid JSON, or
 * does not have a `servers` array.
 */
async function loadMcpServersConfig(path: string): Promise<{ servers: import("@openrupiv/mcp").McpServerEntry[] }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      "ERR_CONFIG",
      `MCP_SERVERS_CONFIG at ${path} could not be read: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      "ERR_CONFIG",
      `MCP_SERVERS_CONFIG at ${path} is not valid JSON: ${message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { servers?: unknown }).servers)) {
    throw new RuntimeError("ERR_CONFIG", `MCP_SERVERS_CONFIG at ${path} must be a JSON object with a "servers" array`);
  }
  return parsed as { servers: import("@openrupiv/mcp").McpServerEntry[] };
}

/** Injection seams for tests (fake Db, offline OIDC, capturing logger). */
export interface ServerDeps {
  db?: Db;
  oidcProvider?: OidcProvider;
  logger?: Logger;
  /** Hash-chained audit store; defaults to one backed by `db` (audit.ts). */
  auditStore?: AuditStore;
  /** Deny-by-default PDP; defaults to the committed OPA WASM bundle (ADR-0006). */
  policyEngine?: PolicyEngine;
  /**
   * Optional: governed agent runtime + task procedures. Absent by default —
   * no real ToolSandbox ships yet (packages/sandbox, ADR-0007), so the
   * agent-trigger/proposal-listing routes are only registered when a caller
   * explicitly supplies one (tests inject a fake sandbox; there is no
   * production default to fall back to — never stub the sandbox boundary).
   */
  agents?: { runtime: AgentRuntime; procedures: AgentTaskProcedureRegistry };
  /** MCP client (consumes external MCP servers as connectors). Defaults to one built from config.mcpServersConfigPath (inert if unset). */
  mcpClient?: McpClient;
}

/** Build the Fastify server (exported for tests). Does not listen. */
export async function createServer(
  spec: AppSpec,
  config: RuntimeConfig,
  deps: ServerDeps = {},
): Promise<FastifyInstance> {
  // Security gates re-checked here so hand-built configs cannot bypass them
  // (dev-cred refusal per ADR-0002, session secret length).
  assertRuntimeConfig(config);

  const logger = deps.logger ?? createLogger();
  const db = deps.db ?? createPgDb(config.databaseUrl);
  const ownsDb = deps.db === undefined;
  const auditStore = deps.auditStore ?? createDbAuditStore(db, logger);
  const policyEngine = deps.policyEngine ?? (await createPolicyEngine());
  const mcpClient =
    deps.mcpClient ??
    (await createMcpClient(
      config.mcpServersConfigPath ? await loadMcpServersConfig(config.mcpServersConfigPath) : { servers: [] },
      { policy: policyEngine, audit: auditStore },
    ));

  const app = Fastify({ logger: false });

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) {
      if (error.statusCode >= 500) {
        logger.error(
          { event: "http.error", code: error.code, err: error },
          "request failed",
        );
      } else {
        logger.warn(
          { event: "http.rejected", code: error.code, statusCode: error.statusCode },
          error.message,
        );
      }
      void reply.code(error.statusCode).send(error.toBody());
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      logger.error({ event: "http.error", err: error }, "unhandled error");
      void reply
        .code(500)
        .send({ error: "ERR_INTERNAL", message: "internal server error" });
      return;
    }
    // Fastify-level 4xx (bad JSON body, unsupported media type, ...).
    const message =
      error instanceof Error ? error.message : "bad request";
    void reply.code(statusCode).send({ error: "ERR_BAD_REQUEST", message });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: "ERR_NOT_FOUND",
      message: `no route ${request.method} ${request.url.split("?")[0] ?? request.url}`,
    });
  });

  app.get("/healthz", async (_request, reply) => {
    await reply.send({ ok: true });
  });

  registerAuth(
    app,
    config,
    logger,
    deps.oidcProvider ?? defaultOidcProvider(config, logger),
    spec.app.roles ?? [],
    auditStore,
  );
  registerEntityRoutes(app, spec, db, logger, auditStore);
  registerWorkflowRoutes(app, spec, db, logger, policyEngine, auditStore);
  registerAdminAuditRoutes(app, {
    audit: auditStore,
    policy: policyEngine,
    logger,
    appRoles: spec.app.roles ?? [],
  });
  if (deps.agents) {
    registerAdminAgentRoutes(app, {
      runtime: deps.agents.runtime,
      procedures: deps.agents.procedures,
      policy: policyEngine,
      audit: auditStore,
      logger,
      appRoles: spec.app.roles ?? [],
    });
  }
  registerPages(app, spec, db, logger);

  // Structured request log. Never the query string (OAuth codes/states),
  // never headers (cookies/authorization) — redaction is still applied on
  // top as a second line of defense.
  app.addHook("onResponse", (request, reply, done) => {
    logger.info(
      {
        event: "http.request",
        method: request.method,
        path: (request.raw.url ?? "").split("?")[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        sub: request.session?.sub,
      },
      "request completed",
    );
    done();
  });

  if (ownsDb) {
    app.addHook("onClose", async () => {
      await db.end();
    });
  }

  // The MCP client is always either constructed here or injected by a test —
  // unlike `db`, there is no "caller owns it" case to guard against.
  app.addHook("onClose", async () => {
    await mcpClient.close();
  });

  return app;
}

/**
 * Apply app migrations + runtime infra tables, then listen. The Compose
 * runtime service runs exactly this via bin/serve.mjs with APP_DIR set.
 */
export async function serveAppDir(
  dir: string,
  config?: RuntimeConfig,
): Promise<void> {
  const cfg = config ?? configFromEnv();
  const logger = createLogger();
  const spec = await loadAppDir(dir);
  const db = createPgDb(cfg.databaseUrl);

  try {
    await ensureInfraTables(db);
    await applyMigrations(db, path.join(dir, "migrations"), logger);
  } catch (error) {
    await db.end();
    throw error;
  }

  const app = await createServer(spec, cfg, { db, logger });
  app.addHook("onClose", async () => {
    await db.end();
  });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  logger.info(
    {
      event: "server.started",
      app: spec.app.slug,
      port: cfg.port,
      baseUrl: cfg.baseUrl,
      devMode: cfg.devMode,
    },
    "runtime serving app",
  );
}
