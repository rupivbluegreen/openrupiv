import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import type { AuditRecordInput } from "@openrupiv/audit";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, DEMO_TASK_PROCEDURES, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
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
