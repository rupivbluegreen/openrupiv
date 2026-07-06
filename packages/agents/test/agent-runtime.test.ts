import { describe, expect, it } from "vitest";
import { AgentTaskNotFoundError, AgentToolUnregisteredError, DEFAULT_SANDBOX_LIMITS, createAgentRuntime } from "../src/index";
import type { AgentTaskDef, RegisteredTool } from "../src/types";
import { FakeAuditStore } from "./helpers/fakeAuditStore";
import { FakeDb } from "./helpers/fakeDb";
import { FakePolicy } from "./helpers/fakePolicy";
import { FakeSandbox } from "./helpers/fakeSandbox";
import { ECHO_TOOL, buildSpec } from "./helpers/fixtures";

interface SetupOptions {
  task?: Partial<AgentTaskDef>;
  tools?: RegisteredTool[];
  allow?: (input: unknown) => boolean;
}

function setup(opts: SetupOptions = {}) {
  const task: AgentTaskDef = {
    name: "onboard-vendor",
    tools: ["echo"],
    proposes: [{ workflow: "vendor-approval", transition: "approve" }],
    ...opts.task,
  };
  const spec = buildSpec([task]);
  const db = new FakeDb();
  const audit = new FakeAuditStore();
  const policy = new FakePolicy(opts.allow ? { allow: opts.allow } : {});
  const sandbox = new FakeSandbox();
  const tools = opts.tools ?? [ECHO_TOOL];
  const runtime = createAgentRuntime(spec, { db, policy, audit, sandbox, tools });
  return { spec, task, db, audit, policy, sandbox, tools, runtime };
}

describe("contextFor", () => {
  it("throws AgentTaskNotFoundError for an unknown task", () => {
    const { runtime } = setup();
    expect(() => runtime.contextFor("does-not-exist")).toThrow(AgentTaskNotFoundError);
  });

  it("still works with no spec.agents at all (an empty AgentRuntime)", () => {
    const spec = buildSpec([]);
    const runtime = createAgentRuntime(spec, {
      db: new FakeDb(),
      policy: new FakePolicy(),
      audit: new FakeAuditStore(),
      sandbox: new FakeSandbox(),
      tools: [],
    });
    expect(() => runtime.contextFor("anything")).toThrow(AgentTaskNotFoundError);
  });

  it("throws AgentToolUnregisteredError at construction if a task's tools allowlist names an unregistered tool", () => {
    const task: AgentTaskDef = { name: "onboard-vendor", tools: ["echo", "ghost-tool"] };
    const spec = buildSpec([task]);
    expect(() =>
      createAgentRuntime(spec, {
        db: new FakeDb(),
        policy: new FakePolicy(),
        audit: new FakeAuditStore(),
        sandbox: new FakeSandbox(),
        tools: [ECHO_TOOL],
      }),
    ).toThrow(AgentToolUnregisteredError);
  });

  it("constructs the reserved agent identity (agent:<task>@<slug>) with empty roles", () => {
    const { runtime, spec } = setup();
    const ctx = runtime.contextFor("onboard-vendor");
    expect(ctx.identity).toEqual({ id: `agent:onboard-vendor@${spec.app.slug}`, roles: [] });
    expect(ctx.task.name).toBe("onboard-vendor");
  });

  it("emits agent.task_started", () => {
    const { runtime, audit } = setup();
    runtime.contextFor("onboard-vendor");
    const started = audit.records.filter((r) => r.event === "agent.task_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actor: "agent:onboard-vendor@vendor-onboarding",
      actorType: "agent",
      attributes: { task: "onboard-vendor" },
    });
  });
});

describe("callTool enforcement order", () => {
  it("step 1: denies a tool absent from the allowlist, even if wholly unregistered -- before any other check", async () => {
    const { runtime, policy, audit } = setup({ task: { tools: [] } });
    const ctx = runtime.contextFor("onboard-vendor");
    const before = audit.records.length;

    const result = await ctx.callTool({ tool: "totally-unregistered", input: {} });

    expect(result).toEqual({
      ok: false,
      code: "ERR_TOOL_NOT_ALLOWED",
      message: expect.stringContaining("totally-unregistered"),
    });
    expect(policy.calls).toHaveLength(0);
    expect(audit.records.length).toBe(before);
  });

  it("step 2: allowlisted but unregistered tools are caught at construction time (fail-fast)", () => {
    // This scenario is now impossible at runtime because the fail-fast check
    // in createAgentRuntime catches it at construction time. This test verifies
    // that the fail-fast check works.
    const task: AgentTaskDef = { name: "onboard-vendor", tools: ["ghost"] };
    const spec = buildSpec([task]);
    expect(() =>
      createAgentRuntime(spec, {
        db: new FakeDb(),
        policy: new FakePolicy(),
        audit: new FakeAuditStore(),
        sandbox: new FakeSandbox(),
        tools: [ECHO_TOOL],
      }),
    ).toThrow(AgentToolUnregisteredError);
  });

  it("step 2b: denies input that fails the tool's JSON Schema -- before policy/audit", async () => {
    const { runtime, policy, audit } = setup();
    const ctx = runtime.contextFor("onboard-vendor");
    const before = audit.records.length;

    const result = await ctx.callTool({ tool: "echo", input: { wrongField: 1 } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ERR_TOOL_INPUT");
    }
    expect(policy.calls).toHaveLength(0);
    expect(audit.records.length).toBe(before);
  });

  it("step 3/4: a policy deny is still audited (decision: deny) BEFORE returning ERR_POLICY_DENIED, and the sandbox is never called", async () => {
    const { runtime, policy, audit, sandbox } = setup({ allow: () => false });
    const ctx = runtime.contextFor("onboard-vendor");

    const result = await ctx.callTool({ tool: "echo", input: { message: "hi" } });

    expect(result).toEqual({ ok: false, code: "ERR_POLICY_DENIED", message: expect.any(String) });
    expect(policy.calls).toHaveLength(1);
    expect(sandbox.calls).toHaveLength(0);

    const toolCallEvents = audit.records.filter((r) => r.event === "agent.tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]?.decision).toBe("deny");
  });

  it("step 4: an audit-append failure prevents execution and returns ERR_AUDIT_UNAVAILABLE (even though policy allows)", async () => {
    const { runtime, audit, sandbox } = setup({ allow: () => true });
    audit.failNextAppend(/^agent\.tool_call$/);
    const ctx = runtime.contextFor("onboard-vendor");

    const result = await ctx.callTool({ tool: "echo", input: { message: "hi" } });

    expect(result).toEqual({
      ok: false,
      code: "ERR_AUDIT_UNAVAILABLE",
      message: expect.any(String),
    });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("step 5/6: a full success round-trip audits tool_call THEN tool_result, and passes workspaceDir/limits through unchanged", async () => {
    const { runtime, audit, sandbox } = setup({ allow: () => true });
    sandbox.setDefaultResult({ ok: true, output: { echoed: "hi" }, durationMs: 12 });
    const ctx = runtime.contextFor("onboard-vendor");

    const result = await ctx.callTool({
      tool: "echo",
      input: { message: "hi", secretToken: "shh-do-not-log-me" },
    });

    expect(result).toEqual({ ok: true, output: { echoed: "hi" } });

    expect(sandbox.calls).toHaveLength(1);
    const call = sandbox.calls[0];
    expect(call?.tool.name).toBe("echo");
    expect(call?.input).toEqual({ message: "hi", secretToken: "shh-do-not-log-me" });
    expect(call?.limits).toEqual(DEFAULT_SANDBOX_LIMITS);
    expect(call?.workspaceDir).toMatch(
      /^\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const relevant = audit.records.filter((r) => r.event.startsWith("agent.tool_"));
    expect(relevant.map((r) => r.event)).toEqual(["agent.tool_call", "agent.tool_result"]);
    expect(relevant[0]?.decision).toBe("allow");
    expect(relevant[1]?.decision).toBe("allow");

    // Never the raw input/output -- only digests + byte sizes.
    for (const record of relevant) {
      const serialized = JSON.stringify(record.attributes);
      expect(serialized).not.toContain("shh-do-not-log-me");
      expect(serialized).not.toContain("echoed");
    }
    expect(relevant[0]?.attributes?.["inputDigest"]).toEqual(expect.any(String));
    expect(relevant[0]?.attributes?.["inputBytes"]).toEqual(expect.any(Number));
    expect(relevant[1]?.attributes?.["outputDigest"]).toEqual(expect.any(String));
    expect(relevant[1]?.attributes?.["outcome"]).toBe("ok");
    expect(relevant[1]?.attributes?.["durationMs"]).toBe(12);
  });

  it("honors a configured workspaceRoot instead of the /workspaces default", async () => {
    const task: AgentTaskDef = { name: "onboard-vendor", tools: ["echo"] };
    const spec = buildSpec([task]);
    const sandbox = new FakeSandbox();
    sandbox.setDefaultResult({ ok: true, output: {}, durationMs: 1 });
    const runtime = createAgentRuntime(spec, {
      db: new FakeDb(),
      policy: new FakePolicy({ allow: () => true }),
      audit: new FakeAuditStore(),
      sandbox,
      tools: [ECHO_TOOL],
      workspaceRoot: "/custom-workspace-root",
    });
    const ctx = runtime.contextFor("onboard-vendor");

    await ctx.callTool({ tool: "echo", input: { message: "hi" } });

    expect(sandbox.calls[0]?.workspaceDir).toMatch(
      /^\/custom-workspace-root\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("maps sandbox violation/limit/tool_error results to the matching ToolCallResult codes, and audits the outcome", async () => {
    const { runtime, audit, sandbox } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    sandbox.queueResult({
      ok: false,
      reason: "violation",
      violation: "network_egress",
      message: "blocked egress attempt",
      durationMs: 3,
    });
    expect(await ctx.callTool({ tool: "echo", input: { message: "a" } })).toEqual({
      ok: false,
      code: "ERR_SANDBOX_VIOLATION",
      message: "blocked egress attempt",
    });

    sandbox.queueResult({
      ok: false,
      reason: "limit",
      limit: "wall_clock",
      message: "wall clock exceeded",
      durationMs: 30_000,
    });
    expect(await ctx.callTool({ tool: "echo", input: { message: "b" } })).toEqual({
      ok: false,
      code: "ERR_SANDBOX_LIMIT",
      message: "wall clock exceeded",
    });

    sandbox.queueResult({ ok: false, reason: "tool_error", message: "tool crashed", durationMs: 2 });
    expect(await ctx.callTool({ tool: "echo", input: { message: "c" } })).toEqual({
      ok: false,
      code: "ERR_TOOL_FAILED",
      message: "tool crashed",
    });

    const outcomes = audit.records
      .filter((r) => r.event === "agent.tool_result")
      .map((r) => r.attributes?.["outcome"]);
    expect(outcomes).toEqual(["violation", "limit", "tool_error"]);
  });
});

describe("propose()", () => {
  it("writes agent_proposals + agent.transition_proposed atomically (same transaction)", async () => {
    const { runtime, db, audit } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    const proposal = await ctx.propose({
      entityTable: "vendor_application",
      recordId: "11111111-1111-1111-1111-111111111111",
      workflow: "vendor-approval",
      transition: "approve",
      rationale: "checks out",
    });

    expect(proposal.agentId).toBe(ctx.identity.id);
    expect(db.proposalRows()).toHaveLength(1);
    expect(db.proposalRows()[0]).toMatchObject({ id: proposal.id, agent_id: ctx.identity.id });

    const proposedEvents = db.auditRows().filter((r) => r["event"] === "agent.transition_proposed");
    expect(proposedEvents).toHaveLength(1);
    expect(proposedEvents[0]).toMatchObject({ actor: ctx.identity.id, actor_type: "agent" });

    // propose() no longer infers task completion -- finish() (tested below)
    // is the sole, explicit source of agent.task_finished.
    expect(audit.records.filter((r) => r.event === "agent.task_finished")).toHaveLength(0);
  });

  it("rolls back BOTH the proposal insert and the audit append if the audit append fails (atomic, fail-closed)", async () => {
    const { runtime, db } = setup({ allow: () => true });
    db.failNextMatching(/^INSERT INTO audit_log/);
    const ctx = runtime.contextFor("onboard-vendor");

    await expect(
      ctx.propose({
        entityTable: "vendor_application",
        recordId: "22222222-2222-2222-2222-222222222222",
        workflow: "vendor-approval",
        transition: "approve",
        rationale: "x",
      }),
    ).rejects.toThrow();

    expect(db.proposalRows()).toHaveLength(0);
    expect(db.auditRows()).toHaveLength(0);
  });

  it("never issues SQL naming workflow_approvals or any other table -- propose() cannot change entity/workflow state", async () => {
    const { runtime, db } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    await ctx.propose({
      entityTable: "vendor_application",
      recordId: "33333333-3333-3333-3333-333333333333",
      workflow: "vendor-approval",
      transition: "approve",
      rationale: "x",
    });

    for (const stmt of db.statements) {
      expect(stmt.text).not.toMatch(/workflow_approvals/);
    }
  });
});

describe("finish()", () => {
  it("emits exactly one agent.task_finished with the given reason, independent of propose()", async () => {
    const { runtime, audit } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    await ctx.finish({ reason: "no_action_needed" });

    const finished = audit.records.filter((r) => r.event === "agent.task_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      actor: ctx.identity.id,
      actorType: "agent",
      attributes: { task: "onboard-vendor", reason: "no_action_needed" },
    });
  });

  it("carries optional detail through to the audit attributes", async () => {
    const { runtime, audit } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    await ctx.finish({ reason: "error", detail: { errorCode: "ERR_TOOL_FAILED" } });

    const finished = audit.records.filter((r) => r.event === "agent.task_finished");
    expect(finished[0]?.attributes?.["detail"]).toEqual({ errorCode: "ERR_TOOL_FAILED" });
  });

  it("is fail-closed: a failing audit append throws, so callers know the guarantee wasn't met", async () => {
    const { runtime, audit } = setup({ allow: () => true });
    audit.failNextAppend(/^agent\.task_finished$/);
    const ctx = runtime.contextFor("onboard-vendor");

    await expect(ctx.finish({ reason: "done" })).rejects.toThrow();
  });

  it("gives a one-event-per-run guarantee even for a run that never calls propose() or callTool", async () => {
    const { runtime, audit } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    await ctx.finish({ reason: "read_only_run_completed" });

    expect(audit.records.filter((r) => r.event === "agent.task_started")).toHaveLength(1);
    expect(audit.records.filter((r) => r.event === "agent.task_finished")).toHaveLength(1);
  });
});

describe("listProposals", () => {
  it("filters by workflow and recordId, independently and together", async () => {
    const { runtime } = setup({ allow: () => true });
    const ctx = runtime.contextFor("onboard-vendor");

    const a = await ctx.propose({
      entityTable: "vendor_application",
      recordId: "11111111-1111-1111-1111-111111111111",
      workflow: "wf-a",
      transition: "approve",
      rationale: "a",
    });
    const b = await ctx.propose({
      entityTable: "vendor_application",
      recordId: "22222222-2222-2222-2222-222222222222",
      workflow: "wf-b",
      transition: "approve",
      rationale: "b",
    });
    const c = await ctx.propose({
      entityTable: "vendor_application",
      recordId: "11111111-1111-1111-1111-111111111111",
      workflow: "wf-b",
      transition: "approve",
      rationale: "c",
    });

    const all = await runtime.listProposals();
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const byWorkflow = await runtime.listProposals({ workflow: "wf-b" });
    expect(byWorkflow.map((p) => p.id).sort()).toEqual([b.id, c.id].sort());

    const byRecord = await runtime.listProposals({
      recordId: "11111111-1111-1111-1111-111111111111",
    });
    expect(byRecord.map((p) => p.id).sort()).toEqual([a.id, c.id].sort());

    const byBoth = await runtime.listProposals({
      workflow: "wf-b",
      recordId: "11111111-1111-1111-1111-111111111111",
    });
    expect(byBoth).toEqual([c]);
  });
});
