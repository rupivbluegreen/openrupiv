import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, DEMO_TASK_PROCEDURES, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeAuditStore } from "./helpers/fakeAgentAuditStore";
import { FakeDb as FakeAgentsDb } from "./helpers/fakeAgentsDb";
import { FakePolicy } from "./helpers/fakeAgentsPolicy";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";

describe("DEMO_TASK_PROCEDURES.vendor-risk-review", () => {
  function setup() {
    const spec = fixtures.vendorOnboardingWithAgentSpec;
    const db = new FakeAgentsDb();
    const audit = new FakeAuditStore();
    const policy = new FakePolicy();
    const sandbox = new FakeToolSandbox();
    const runtime = createAgentRuntime(spec, {
      db,
      policy,
      audit,
      sandbox,
      tools: DEMO_REGISTERED_TOOLS,
    });
    return { spec, db, audit, policy, sandbox, runtime };
  }

  it("proposes the approve transition after reading the vendor application", async () => {
    const { runtime, sandbox } = setup();
    const recordId = randomUUID();
    sandbox.queueResult({ ok: true, output: { id: recordId, status: "in_review" }, durationMs: 1 });

    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await DEMO_TASK_PROCEDURES[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId });
    await ctx.finish(outcome);

    expect(outcome.reason).toBe("proposed");
    const proposals = await runtime.listProposals({ workflow: "vendor-approval" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      entityTable: "vendor_application",
      recordId,
      workflow: "vendor-approval",
      transition: "approve",
    });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.tool.name).toBe("read-vendor-application");
  });

  it("returns reason=invalid_input for a non-UUID recordId, without calling the sandbox", async () => {
    const { runtime, sandbox } = setup();
    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await DEMO_TASK_PROCEDURES[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId: "not-a-uuid" });
    await ctx.finish(outcome);
    expect(outcome.reason).toBe("invalid_input");
    expect(sandbox.calls).toHaveLength(0);
  });

  it("returns reason=read_failed when the sandbox reports a violation, and does not propose", async () => {
    const { runtime, sandbox } = setup();
    const recordId = randomUUID();
    sandbox.queueResult({ ok: false, reason: "violation", violation: "network_egress", message: "blocked", durationMs: 1 });
    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await DEMO_TASK_PROCEDURES[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId });
    await ctx.finish(outcome);
    expect(outcome.reason).toBe("read_failed");
    const proposals = await runtime.listProposals({ workflow: "vendor-approval" });
    expect(proposals).toHaveLength(0);
  });
});
