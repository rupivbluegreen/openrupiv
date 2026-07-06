import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@openrupiv/agents";
import { fixtures } from "@openrupiv/spec";
import { DEMO_REGISTERED_TOOLS, DEMO_TASK_PROCEDURES, VENDOR_RISK_REVIEW_TASK } from "../src/agent-tasks";
import { FakeDb } from "./helpers/fakeDb";
import { FakeToolSandbox } from "./helpers/fakeToolSandbox";
import { buildTestServer } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingWithAgentSpec;

async function buildA2aServer(db: FakeDb, sandbox: FakeToolSandbox) {
  const agentRuntime = createAgentRuntime(spec, {
    db: db as never,
    policy: { decide: async () => ({ allow: true, reason: "test", policyId: "test" }) },
    audit: { append: async (i: unknown) => ({ ...(i as object), seq: 1, timestamp: "t", hash: "h", prevHash: "p" }) } as never,
    sandbox,
    tools: DEMO_REGISTERED_TOOLS,
  });
  process.env["OPENRUPIV_TEST_A2A_SECRET"] = "test-a2a-shared-secret";
  return buildTestServer(spec, db, {
    agents: { runtime: agentRuntime, procedures: DEMO_TASK_PROCEDURES },
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

  it("a skill outside allowedSkills is rejected", async () => {
    const server = await buildA2aServer(new FakeDb(), new FakeToolSandbox());
    const res = await server.app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer test-a2a-shared-secret", "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { skill: "not-allowed", message: { parts: [] } } },
    });
    const body = res.json();
    expect(body.error).toBeDefined();
  });
});
