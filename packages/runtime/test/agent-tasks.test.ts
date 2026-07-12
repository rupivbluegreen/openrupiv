import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, createDemoProcedures, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeAuditStore } from "./helpers/fakeAgentAuditStore";
import { FakeDb } from "./helpers/fakeDb";
import { FakePolicy } from "./helpers/fakeAgentsPolicy";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";

describe("vendor-risk-review procedure", () => {
  function setup() {
    const spec = fixtures.vendorOnboardingWithAgentSpec;
    // The runtime FakeDb handles both the entity read the procedure now does
    // and the agent_proposals insert propose() does.
    const db = new FakeDb();
    const audit = new FakeAuditStore();
    const policy = new FakePolicy();
    const sandbox = new FakeToolSandbox();
    const runtime = createAgentRuntime(spec, { db: db as never, policy, audit, sandbox, tools: DEMO_REGISTERED_TOOLS });
    const procedures = createDemoProcedures(db as never);
    return { spec, db, audit, policy, sandbox, runtime, procedures };
  }

  it("passes the pre-fetched record's fields to the jail and proposes on a low-risk verdict", async () => {
    const { runtime, sandbox, db, procedures } = setup();
    const row = db.seedRow("vendor_application", { justification: "strategic supplier", annual_spend: 5000, status: "in_review" });
    const recordId = String(row["id"]);
    sandbox.queueResult({ ok: true, output: { risk: "low", reasons: ["no blocking risk signals"] }, durationMs: 1 });

    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await procedures[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId });
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
    // The runtime read the record; the jail receives its fields, never an id to fetch.
    expect(sandbox.calls[0]?.input).toEqual({ annualSpend: 5000, justification: "strategic supplier", status: "in_review" });
  });

  it("declines (no proposal) on a high-risk verdict", async () => {
    const { runtime, sandbox, db, procedures } = setup();
    const row = db.seedRow("vendor_application", { justification: "x", annual_spend: 250_000, status: "in_review" });
    const recordId = String(row["id"]);
    sandbox.queueResult({ ok: true, output: { risk: "high", reasons: ["annualSpend exceeds threshold"] }, durationMs: 1 });

    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await procedures[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId });
    await ctx.finish(outcome);

    expect(outcome.reason).toBe("declined_high_risk");
    expect(await runtime.listProposals({ workflow: "vendor-approval" })).toHaveLength(0);
  });

  it("returns invalid_input for a non-UUID recordId, without calling the sandbox", async () => {
    const { runtime, sandbox, procedures } = setup();
    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await procedures[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId: "not-a-uuid" });
    await ctx.finish(outcome);
    expect(outcome.reason).toBe("invalid_input");
    expect(sandbox.calls).toHaveLength(0);
  });

  it("returns read_failed when the record does not exist, never calling the jail", async () => {
    const { runtime, sandbox, procedures } = setup();
    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await procedures[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId: randomUUID() });
    await ctx.finish(outcome);
    expect(outcome.reason).toBe("read_failed");
    expect(sandbox.calls).toHaveLength(0);
  });

  it("returns read_failed when the sandbox reports a violation, and does not propose", async () => {
    const { runtime, sandbox, db, procedures } = setup();
    const row = db.seedRow("vendor_application", { justification: "j", annual_spend: 1, status: "in_review" });
    const recordId = String(row["id"]);
    sandbox.queueResult({ ok: false, reason: "violation", violation: "network_egress", message: "blocked", durationMs: 1 });
    const ctx = runtime.contextFor(VENDOR_RISK_REVIEW_TASK);
    const outcome = await procedures[VENDOR_RISK_REVIEW_TASK]!(ctx, { recordId });
    await ctx.finish(outcome);
    expect(outcome.reason).toBe("read_failed");
    expect(await runtime.listProposals({ workflow: "vendor-approval" })).toHaveLength(0);
  });
});
