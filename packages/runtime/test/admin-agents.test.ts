import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import type { AuditRecordInput } from "@openrupiv/audit";
import { fixtures } from "@openrupiv/spec";
import type { AgentTaskProcedureRegistry } from "../src/agent-tasks";
import { DEMO_REGISTERED_TOOLS, DEMO_TASK_PROCEDURES, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
import { FakeAuditStore } from "./helpers/fakeAgentAuditStore";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";
import { buildTestServer, sessionCookieFor, type TestServer } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingWithAgentSpec;
const admin = { cookie: sessionCookieFor({ sub: "u-admin", roles: ["admin"] }) };
const outsider = { cookie: sessionCookieFor({ sub: "u-outsider", roles: [] }) };

describe("admin agent routes", () => {
  let db: FakeDb;
  let sandbox: FakeToolSandbox;
  let server: TestServer;
  let applicationId: string;

  beforeEach(async () => {
    db = new FakeDb();
    sandbox = new FakeToolSandbox();
    const agentRuntime = createAgentRuntime(spec, {
      db: db as unknown as Parameters<typeof createAgentRuntime>[1]["db"],
      policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
      audit: {
        append: async (i: AuditRecordInput) => ({ ...i, seq: 1, timestamp: "t", hash: "h", prevHash: "p" }),
      } as never,
      sandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    server = await buildTestServer(spec, db, {
      agents: { runtime: agentRuntime, procedures: DEMO_TASK_PROCEDURES },
    });
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status: "in_review",
    });
    applicationId = String(row["id"]);
    sandbox.queueResult({ ok: true, output: { id: applicationId, status: "in_review" }, durationMs: 1 });
  });

  it("403s for a non-admin", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: outsider,
      payload: { recordId: applicationId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("runs the task, proposes, and lists the proposal for an admin", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: admin,
      payload: { recordId: applicationId },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "completed", reason: "proposed" });

    const list = await server.app.inject({
      method: "GET",
      url: "/admin/agent-proposals",
      headers: admin,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ recordId: applicationId, transition: "approve" });
  });

  it("404s for a task name not declared in the spec", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/admin/agents/does-not-exist/run",
      headers: admin,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("501s ERR_AGENT_PROCEDURE_UNREGISTERED for a task declared in the spec with no registered procedure on this deployment, and still finishes the audit trail", async () => {
    const unregisteredDb = new FakeDb();
    const unregisteredSandbox = new FakeToolSandbox();
    const agentAudit = new FakeAuditStore();
    const agentRuntime = createAgentRuntime(spec, {
      db: unregisteredDb as unknown as Parameters<typeof createAgentRuntime>[1]["db"],
      policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
      audit: agentAudit,
      sandbox: unregisteredSandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    // Empty procedures registry: `vendor-risk-review` IS declared in the
    // spec (so runtime.contextFor succeeds and emits agent.task_started),
    // but this deployment has no procedure registered for it -- the 501
    // (ERR_AGENT_PROCEDURE_UNREGISTERED) path, distinct from the 404 (task
    // not declared in the spec at all) covered above.
    const emptyProcedures: AgentTaskProcedureRegistry = {};
    const unregisteredServer = await buildTestServer(spec, unregisteredDb, {
      agents: { runtime: agentRuntime, procedures: emptyProcedures },
    });
    const row = unregisteredDb.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status: "in_review",
    });
    const recordId = String(row["id"]);

    const res = await unregisteredServer.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: admin,
      payload: { recordId },
    });
    expect(res.statusCode).toBe(501);

    // Audit-trail completeness: contextFor() above already emitted
    // agent.task_started before the procedure lookup failed, so this 501
    // path must still call ctx.finish() -- otherwise that started record
    // would never get a matching finished record.
    const started = agentAudit.records.filter((r) => r.event === "agent.task_started");
    const finished = agentAudit.records.filter((r) => r.event === "agent.task_finished");
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
  });

  it("an agent proposal does not count toward the 4-eyes distinct-approver requirement", async () => {
    await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: admin,
      payload: { recordId: applicationId },
    });
    const reviewer = { cookie: sessionCookieFor({ sub: "u-reviewer", roles: ["reviewer"] }) };
    const approve = await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${applicationId}/transitions/approve`,
      headers: reviewer,
    });
    // One human approval + one agent proposal must NOT satisfy count:2 — still pending.
    expect(approve.json()).toMatchObject({ status: "pending", approvals: 1, required: 2 });
  });
});

describe("finding admin-agents-role-namespace-collision: an app-declared role must never satisfy the platform agent.trigger check", () => {
  // Mirrors admin-audit.test.ts's "audit-role-namespace-collision" test: an
  // app spec that (perhaps unwisely, but validly) declares its own domain
  // role named literally "admin" — nothing in validateSpec reserves this
  // name for the platform, so admin-agents.ts's authorize() must strip any
  // role also declared by the app spec from the subject's effective role
  // set before it ever reaches the PDP, even on a literal string match.
  const collidingSpec = {
    ...fixtures.vendorOnboardingWithAgentSpec,
    app: {
      ...fixtures.vendorOnboardingWithAgentSpec.app,
      roles: [...(fixtures.vendorOnboardingWithAgentSpec.app.roles ?? []), "admin"],
    },
  };

  it("a session holding ONLY the app-granted 'admin' role (not a platform-sourced one) is DENIED agent.trigger", async () => {
    const db = new FakeDb();
    const sandbox = new FakeToolSandbox();
    const agentRuntime = createAgentRuntime(collidingSpec, {
      db: db as unknown as Parameters<typeof createAgentRuntime>[1]["db"],
      policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
      audit: {
        append: async (i: AuditRecordInput) => ({ ...i, seq: 1, timestamp: "t", hash: "h", prevHash: "p" }),
      } as never,
      sandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    const server = await buildTestServer(collidingSpec, db, {
      agents: { runtime: agentRuntime, procedures: DEMO_TASK_PROCEDURES },
    });
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status: "in_review",
    });
    const recordId = String(row["id"]);
    // This user's ENTIRE role set is exactly what the app spec declares —
    // indistinguishable, at the string level, from a genuine platform
    // "admin". It must still be denied.
    const appAdmin = { cookie: sessionCookieFor({ sub: "u-app-admin", roles: ["admin"] }) };

    const res = await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: appAdmin,
      payload: { recordId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });
  });
});
