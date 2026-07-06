/**
 * Shared test scaffolding: a capturing logger, a RuntimeConfig for tests,
 * server construction with injected fakes, and session-cookie forging that
 * exercises the REAL signing/verification path.
 */

import type { AgentRuntime } from "@openrupiv/agents";
import type { AuditStore } from "@openrupiv/audit";
import { createPolicyEngine, type PolicyEngine } from "@openrupiv/policy";
import type { AppSpec } from "@openrupiv/spec";
import type { FastifyInstance } from "fastify";
import type { AgentTaskProcedureRegistry } from "../../src/agent-tasks";
import type { OidcProvider } from "../../src/auth";
import type { RuntimeConfig } from "../../src/config";
import type { Db } from "../../src/db";
import type { Logger } from "../../src/logger";
import { createServer } from "../../src/server";
import {
  SESSION_COOKIE_NAME,
  createSession,
  signPayload,
} from "../../src/session";

export const TEST_SESSION_SECRET =
  "unit-test-session-secret-0123456789abcdef";

export interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

/** Captures raw (pre-serialization) log calls for assertions. */
export class CapturingLogger implements Logger {
  readonly entries: CapturedLog[] = [];

  debug(fields: Record<string, unknown>, msg: string): void {
    this.entries.push({ level: "debug", fields, msg });
  }
  info(fields: Record<string, unknown>, msg: string): void {
    this.entries.push({ level: "info", fields, msg });
  }
  warn(fields: Record<string, unknown>, msg: string): void {
    this.entries.push({ level: "warn", fields, msg });
  }
  error(fields: Record<string, unknown>, msg: string): void {
    this.entries.push({ level: "error", fields, msg });
  }

  find(event: string): CapturedLog | undefined {
    return this.entries.find((e) => e.fields["event"] === event);
  }
  findAll(event: string): CapturedLog[] {
    return this.entries.filter((e) => e.fields["event"] === event);
  }
}

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    databaseUrl: "postgres://unused:unused@db.invalid:5432/unused",
    oidc: {
      issuer: "https://idp.test",
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
      rolesClaim: "roles",
      ...(overrides.oidc ?? {}),
    },
    sessionSecret: TEST_SESSION_SECRET,
    baseUrl: "http://localhost:3000",
    port: 3000,
    devMode: true,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== "oidc"),
    ),
  } as RuntimeConfig;
}

/** OidcProvider that must never be reached in a test. */
export const unreachableOidcProvider: OidcProvider = {
  getConfiguration(): never {
    throw new Error("test attempted real OIDC discovery");
  },
};

/**
 * The REAL policy engine (committed OPA WASM bundle), loaded once per test
 * file — RBAC tests exercise the actual PDP, not a stub.
 */
let enginePromise: Promise<PolicyEngine> | undefined;
export function sharedPolicyEngine(): Promise<PolicyEngine> {
  enginePromise ??= createPolicyEngine();
  return enginePromise;
}

export interface TestServer {
  app: FastifyInstance;
  logger: CapturingLogger;
  config: RuntimeConfig;
}

export async function buildTestServer(
  spec: AppSpec,
  db: Db,
  options: {
    config?: RuntimeConfig;
    oidcProvider?: OidcProvider;
    /** Injected audit store; default: the real Db-backed store over `db`. */
    auditStore?: AuditStore;
    /** Injected PDP; default: the real WASM engine (shared per test file). */
    policyEngine?: PolicyEngine;
    /** Optional: governed agent runtime + task procedures (admin-agents.ts routes). */
    agents?: { runtime: AgentRuntime; procedures: AgentTaskProcedureRegistry };
  } = {},
): Promise<TestServer> {
  const logger = new CapturingLogger();
  const config = options.config ?? testConfig();
  const app = await createServer(spec, config, {
    db,
    logger,
    oidcProvider: options.oidcProvider ?? unreachableOidcProvider,
    ...(options.auditStore ? { auditStore: options.auditStore } : {}),
    policyEngine: options.policyEngine ?? (await sharedPolicyEngine()),
    ...(options.agents ? { agents: options.agents } : {}),
  });
  return { app, logger, config };
}

/**
 * Forge a session cookie the same way /auth/callback would issue it — the
 * server then verifies it through the real HMAC path.
 */
export function sessionCookieFor(
  identity: { sub: string; email?: string; roles?: string[] },
  secret: string = TEST_SESSION_SECRET,
): string {
  const session = createSession({
    sub: identity.sub,
    email: identity.email,
    roles: identity.roles ?? [],
  });
  return `${SESSION_COOKIE_NAME}=${signPayload(session, secret, "session")}`;
}
