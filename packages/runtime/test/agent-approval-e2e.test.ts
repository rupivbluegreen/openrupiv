import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, createDemoProcedures, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
import { FakeAuditStore } from "./helpers/fakeAgentAuditStore";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";
import { buildTestServer, sessionCookieFor } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingWithAgentSpec;

describe("acceptance criterion 5: an agent proposes a vendor approval; a human must satisfy the HITL gate", () => {
  it("agent proposal + 1 human approval leaves the transition pending; a 2nd distinct human approval commits it", async () => {
    const db = new FakeDb();
    const sandbox = new FakeToolSandbox();
    const audit = new FakeAuditStore();
    const admin = { cookie: sessionCookieFor({ sub: "u-admin", roles: ["admin"] }) };
    const reviewer1 = { cookie: sessionCookieFor({ sub: "u-reviewer-1", roles: ["reviewer"] }) };
    const reviewer2 = { cookie: sessionCookieFor({ sub: "u-reviewer-2", roles: ["reviewer"] }) };

    const agentRuntime = createAgentRuntime(spec, {
      db: db as never,
      policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
      audit,
      sandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    const server = await buildTestServer(spec, db, { agents: { runtime: agentRuntime, procedures: createDemoProcedures(db as never) } });

    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status: "in_review",
    });
    const applicationId = String(row["id"]);
    // The sandboxed read-vendor-application tool returns a low-risk verdict,
    // so the agent proposes approval.
    sandbox.queueResult({ ok: true, output: { risk: "low", reasons: ["no blocking risk signals"] }, durationMs: 1 });

    // 1. Agent proposes.
    const trigger = await server.app.inject({
      method: "POST",
      url: `/admin/agents/${VENDOR_RISK_REVIEW_TASK}/run`,
      headers: admin,
      payload: { recordId: applicationId },
    });
    expect(trigger.statusCode).toBe(202);
    expect(trigger.json().reason).toBe("proposed");

    // 1a. "policy-checked, audited": the agent's read-vendor-application
    // tool call must have been policy-checked (policy.decide called, its
    // allow/deny outcome recorded) via a real, inspectable AuditStore
    // (FakeAuditStore) -- not an inline stub that discards its input. If the
    // old inline stub were swapped back in, `audit.records` would stay
    // empty and this assertion would fail.
    const toolCallEvents = audit.records.filter((r) => r.event === "agent.tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      decision: "allow",
      attributes: expect.objectContaining({ task: VENDOR_RISK_REVIEW_TASK, tool: "read-vendor-application" }),
    });

    // `propose()` (packages/agents/src/runtime.ts) writes `agent_proposals`
    // and its `agent.transition_proposed` audit record in the SAME db
    // transaction via `appendInTransaction`, i.e. straight to the audit_log
    // table through the `db` handle -- NOT through the injected `audit`
    // dependency. So this event is only inspectable via `db.auditRows()`
    // (mirrors packages/agents/test/agent-runtime.test.ts's "writes
    // agent_proposals + agent.transition_proposed atomically" test). If the
    // old inline stub were swapped back in this would still pass (it never
    // touched propose()'s audit path either way) -- but it proves the
    // "audited" half of the acceptance criterion for the propose leg, real
    // and inspectable, in this package's own e2e test rather than relying on
    // @openrupiv/agents' unit test alone.
    const proposedEvents = db.auditRows().filter((r) => r["event"] === "agent.transition_proposed");
    expect(proposedEvents).toHaveLength(1);
    expect(proposedEvents[0]).toMatchObject({
      // Same agent identity that made the (already-asserted) tool call above.
      actor: toolCallEvents[0]?.actor,
      actor_type: "agent",
      subject: `vendor_application:${applicationId}`,
    });
    expect(proposedEvents[0]?.["attributes"]).toMatchObject({
      workflow: "vendor-approval",
      transition: "approve",
    });

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
    const proposals = list.json().proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ recordId: applicationId, transition: "approve" });
  });
});
