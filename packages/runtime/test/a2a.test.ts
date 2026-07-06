import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { rowToRecord, type AuditRecord } from "@openrupiv/audit";
import { fixtures } from "@openrupiv/spec";
import {
  DEMO_REGISTERED_TOOLS,
  DEMO_TASK_PROCEDURES,
  VENDOR_RISK_REVIEW_TASK,
  type AgentTaskProcedureRegistry,
} from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";
import { buildTestServer } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingWithAgentSpec;

function auditRecords(db: FakeDb): AuditRecord[] {
  return db.auditRows().map(rowToRecord);
}

async function buildA2aServer(db: FakeDb, sandbox: FakeToolSandbox, procedures: AgentTaskProcedureRegistry = DEMO_TASK_PROCEDURES) {
  const agentRuntime = createAgentRuntime(spec, {
    db: db as never,
    policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
    audit: { append: async (i: unknown) => ({ ...(i as object), seq: 1, timestamp: "t", hash: "h", prevHash: "p" }) } as never,
    sandbox,
    tools: DEMO_REGISTERED_TOOLS,
  });
  process.env["OPENRUPIV_TEST_A2A_SECRET"] = "test-a2a-shared-secret";
  return buildTestServer(spec, db, {
    agents: { runtime: agentRuntime, procedures },
    a2a: {
      clients: [{ clientId: "partner-agent", allowedSkills: [VENDOR_RISK_REVIEW_TASK], bearerTokenEnv: "OPENRUPIV_TEST_A2A_SECRET" }],
      agentCardRequireAuth: false,
    },
  });
}

describe("A2A endpoint", () => {
  it("serves the public agent card", async () => {
    const server = await buildA2aServer(new FakeDb(), new FakeToolSandbox());
    const res = await server.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().skills.map((s: { name: string }) => s.name)).toContain(VENDOR_RISK_REVIEW_TASK);
  });

  it("rejects a request missing the A2A-Version header", async () => {
    const server = await buildA2aServer(new FakeDb(), new FakeToolSandbox());
    const res = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret" },
      payload: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unregistered client bearer", async () => {
    const server = await buildA2aServer(new FakeDb(), new FakeToolSandbox());
    const res = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer wrong-secret", "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it("SendMessage dispatches the skill and GetTask retrieves the same task for that client", async () => {
    const db = new FakeDb();
    const row = db.seedRow("vendor_application", { vendor_id: randomUUID(), justification: "j", annual_spend: 1, status: "in_review" });
    const recordId = String(row["id"]);
    const sandbox = new FakeToolSandbox();
    sandbox.queueResult({ ok: true, output: { id: recordId, status: "in_review" }, durationMs: 1 });
    const server = await buildA2aServer(db, sandbox);

    const send = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret", "a2a-version": "1.0" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { skill: VENDOR_RISK_REVIEW_TASK, message: { parts: [{ kind: "data", data: { recordId } }] } },
      },
    });
    expect(send.statusCode).toBe(200);
    const taskId = send.json().result.id;
    expect(send.json().result.status.state).toBe("completed");

    const get = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret", "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: taskId } },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().result.id).toBe(taskId);
  });

  it("a skill outside allowedSkills is rejected AND the rejection is audited (decision: deny)", async () => {
    const db = new FakeDb();
    const server = await buildA2aServer(db, new FakeToolSandbox());
    const res = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret", "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { skill: "not-allowed", message: { parts: [] } } },
    });
    const body = res.json();
    expect(body.error).toBeDefined();

    const calls = auditRecords(db).filter((r) => r.event === "a2a.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actor: "a2a:partner-agent",
      actorType: "agent",
      subject: "not-allowed",
      decision: "deny",
      attributes: { skill: "not-allowed", reason: "skill_not_allowed" },
    });
  });

  it("an unexpected procedure error returns a generic message to the external caller, logs the real error server-side, and still records the real detail on the internal task", async () => {
    const db = new FakeDb();
    const boom = new Error("dsn=postgres://user:hunter2@internal-db.corp/secret-schema");
    const throwingProcedures: AgentTaskProcedureRegistry = {
      [VENDOR_RISK_REVIEW_TASK]: async () => {
        throw boom;
      },
    };
    const server = await buildA2aServer(db, new FakeToolSandbox(), throwingProcedures);

    const res = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret", "a2a-version": "1.0" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { skill: VENDOR_RISK_REVIEW_TASK, message: { parts: [{ kind: "data", data: {} }] } },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.status.state).toBe("failed");
    // The external caller must never see the raw error text.
    expect(body.result.result.message).toBe("task execution failed");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain(boom.message);

    // The real error IS logged server-side for operators (checked on the
    // fields directly — JSON.stringify on a bare Error drops `.message`
    // since it's non-enumerable, so this must not go through JSON first).
    const logged = server.logger.find("a2a.task_failed");
    expect(logged).toBeDefined();
    expect(logged?.fields["err"]).toBe(boom);
    expect((logged?.fields["err"] as Error).message).toContain("hunter2");

    // The a2a_tasks row persisted for this client mirrors the SAME scrubbed
    // result the caller received (not the raw error).
    const taskId = body.result.id as string;
    const taskRows = db.rows("a2a_tasks");
    const stored = taskRows.find((r) => r["id"] === taskId);
    expect(stored?.["status"]).toBe("failed");
    expect(JSON.stringify(stored?.["result"])).not.toContain("hunter2");
  });
});
