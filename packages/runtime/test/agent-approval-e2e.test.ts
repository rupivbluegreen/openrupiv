import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, DEMO_TASK_PROCEDURES, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";
import { buildTestServer, sessionCookieFor } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingWithAgentSpec;

describe("acceptance criterion 5: an agent proposes a vendor approval; a human must satisfy the HITL gate", () => {
  it("agent proposal + 1 human approval leaves the transition pending; a 2nd distinct human approval commits it", async () => {
    const db = new FakeDb();
    const sandbox = new FakeToolSandbox();
    const admin = { cookie: sessionCookieFor({ sub: "u-admin", roles: ["admin"] }) };
    const reviewer1 = { cookie: sessionCookieFor({ sub: "u-reviewer-1", roles: ["reviewer"] }) };
    const reviewer2 = { cookie: sessionCookieFor({ sub: "u-reviewer-2", roles: ["reviewer"] }) };

    const agentRuntime = createAgentRuntime(spec, {
      db: db as never,
      policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
      audit: { append: async (i: unknown) => ({ ...(i as object), seq: 1, timestamp: "t", hash: "h", prevHash: "p" }) } as never,
      sandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    const server = await buildTestServer(spec, db, { agents: { runtime: agentRuntime, procedures: DEMO_TASK_PROCEDURES } });

    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status: "in_review",
    });
    const applicationId = String(row["id"]);
    sandbox.queueResult({ ok: true, output: { id: applicationId, status: "in_review" }, durationMs: 1 });

    // 1. Agent proposes.
    const trigger = await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: admin,
      payload: { recordId: applicationId },
    });
    expect(trigger.statusCode).toBe(202);
    expect(trigger.json().reason).toBe("proposed");

    // 2. The agent proposal must NOT count toward the 4-eyes requirement:
    // one human approval afterward is still only 1 of 2.
    const firstHumanApproval = await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${applicationId}/transitions/approve`,
      headers: reviewer1,
    });
    expect(firstHumanApproval.json()).toMatchObject({ status: "pending", approvals: 1, required: 2 });

    // 3. A second, DISTINCT human approver completes it.
    const secondHumanApproval = await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${applicationId}/transitions/approve`,
      headers: reviewer2,
    });
    expect(secondHumanApproval.json()).toMatchObject({ status: "transitioned", state: "approved" });

    // 4. The proposal is listed and auditable.
    const list = await server.app.inject({ method: "GET", url: "/admin/agent-proposals", headers: admin });
    expect(list.json().proposals).toHaveLength(1);
  });
});
