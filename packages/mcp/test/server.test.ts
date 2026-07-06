import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicySubject } from "@openrupiv/policy";
import { registerMcpServer } from "../src/server";
import { MCP_PROTOCOL_REVISION, type ExposedCapability } from "../src/types";
import { allowAllPolicyEngine, createFakeAuditStore, denyActionPolicyEngine, withFailingAppend } from "./helpers/fakes";

const KNOWN_SUBJECTS: Record<string, PolicySubject> = {
  "valid-token": { id: "u1", roles: ["reviewer"] },
  "other-user-token": { id: "u2", roles: [] },
};

async function verifyToken(bearer: string): Promise<PolicySubject | null> {
  return KNOWN_SUBJECTS[bearer] ?? null;
}

function readOnlyCapability(overrides: Partial<ExposedCapability> = {}): ExposedCapability {
  return {
    name: "workflow-status-read",
    description: "read-only workflow status",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    allowedRoles: [],
    handler: async (args) => ({ id: args["id"], status: "approved" }),
    ...overrides,
  };
}

async function postMcp(
  app: FastifyInstance,
  body: Record<string, unknown>,
  opts: { bearer?: string } = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      ...(opts.bearer !== undefined ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    payload: body,
  });
  return res;
}

describe("registerMcpServer", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = Fastify();
  });
  afterEach(async () => {
    await app.close();
  });

  it("missing bearer -> 401, audited as mcp.serve_rejected, no capability leaked", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [readOnlyCapability()], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.statusCode).toBe(401);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ event: "mcp.serve_rejected", attributes: { reason: "missing_token" } });
  });

  it("invalid bearer -> 401, audited as mcp.serve_rejected", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [readOnlyCapability()], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { bearer: "garbage" });
    expect(res.statusCode).toBe(401);
    expect(audit.records[0]).toMatchObject({ event: "mcp.serve_rejected", attributes: { reason: "invalid_token" } });
  });

  it("initialize with a supported revision succeeds", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_REVISION } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_REVISION);
  });

  it("initialize with an unsupported revision -> rejected, audited as mcp.serve_rejected", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.data.code).toBe("ERR_MCP_PROTOCOL");
    expect(audit.records[0]).toMatchObject({
      event: "mcp.serve_rejected",
      attributes: { reason: "unsupported_protocol_version" },
    });
  });

  it("tools/list only returns capabilities the subject's policy check allows", async () => {
    const audit = createFakeAuditStore();
    const readCap = readOnlyCapability({ name: "read-cap", allowedRoles: [] });
    const adminCap = readOnlyCapability({ name: "admin-cap", allowedRoles: ["admin"] });
    const policy = denyActionPolicyEngine("mcp.serve:admin-cap");
    registerMcpServer(app, { capabilities: [readCap, adminCap], policy, audit, verifyToken });
    await app.ready();

    const res = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { bearer: "valid-token" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["read-cap"]);
    // tools/list itself is not audited as mcp.serve_call/mcp.serve_result (see server.ts doc comment).
    expect(audit.records).toHaveLength(0);
  });

  it("full inbound tools/call round trip: mcp.serve_call then mcp.serve_result, in order, digests not raw values", async () => {
    const audit = createFakeAuditStore();
    const cap = readOnlyCapability();
    registerMcpServer(app, { capabilities: [cap], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "workflow-status-read", arguments: { id: "abc-123" } } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent).toEqual({ id: "abc-123", status: "approved" });

    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({ event: "mcp.serve_call", decision: "allow", subject: "workflow-status-read" });
    expect(audit.records[1]).toMatchObject({ event: "mcp.serve_result", subject: "workflow-status-read", attributes: { outcome: "ok" } });

    const beforeAttrs = JSON.stringify(audit.records[0]?.attributes ?? {});
    expect(beforeAttrs).toMatch(/argsDigest/);
    expect(beforeAttrs).not.toContain("abc-123");
    const afterAttrs = JSON.stringify(audit.records[1]?.attributes ?? {});
    expect(afterAttrs).toMatch(/contentDigest/);
  });

  it("tools/call for an unknown capability -> JSON-RPC error, audited as mcp.serve_call decision deny", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [readOnlyCapability()], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "does-not-exist", arguments: {} } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(audit.records[0]).toMatchObject({ event: "mcp.serve_call", decision: "deny", attributes: { code: "capability_unknown" } });
  });

  it("tools/call denied by policy -> handler never invoked, audited decision deny", async () => {
    const audit = createFakeAuditStore();
    let handlerCalled = false;
    const cap = readOnlyCapability({
      handler: async () => {
        handlerCalled = true;
        return {};
      },
    });
    const policy = denyActionPolicyEngine("mcp.serve:workflow-status-read");
    registerMcpServer(app, { capabilities: [cap], policy, audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow-status-read", arguments: { id: "x" } } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.data.code).toBe("ERR_MCP_POLICY_DENIED");
    expect(handlerCalled).toBe(false);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ event: "mcp.serve_call", decision: "deny" });
  });

  it("audit-append failure before the handler -> handler never invoked, fails closed", async () => {
    const base = createFakeAuditStore();
    const audit = withFailingAppend(base, () => true);
    let handlerCalled = false;
    const cap = readOnlyCapability({
      handler: async () => {
        handlerCalled = true;
        return {};
      },
    });
    registerMcpServer(app, { capabilities: [cap], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow-status-read", arguments: { id: "x" } } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.data.code).toBe("ERR_MCP_AUDIT_UNAVAILABLE");
    expect(handlerCalled).toBe(false);
  });

  it("AFTER-append failure only: the real response is still returned (best-effort), BEFORE record survives, no 500", async () => {
    const base = createFakeAuditStore();
    // Fail only the 2nd append (the AFTER mcp.serve_result) -- the BEFORE
    // append (index 0) must succeed so this isolates the AFTER-only path,
    // unlike the unconditional-failure test above which only ever exercises
    // the BEFORE-failure fail-closed path.
    const audit = withFailingAppend(base, (_input, idx) => idx === 1);
    const cap = readOnlyCapability();
    registerMcpServer(app, { capabilities: [cap], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow-status-read", arguments: { id: "x" } } },
      { bearer: "valid-token" },
    );

    // The call itself succeeded; a best-effort AFTER-audit failure must not
    // be surfaced to the caller as a different response.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBeFalsy();
    expect(base.records).toHaveLength(1);
    expect(base.records[0]).toMatchObject({ event: "mcp.serve_call", decision: "allow" });
  });

  it("a handler that throws is reported as an isError tool result, still audited as outcome error", async () => {
    const audit = createFakeAuditStore();
    const cap = readOnlyCapability({
      handler: async () => {
        throw new Error("boom");
      },
    });
    registerMcpServer(app, { capabilities: [cap], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow-status-read", arguments: { id: "x" } } },
      { bearer: "valid-token" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBe(true);
    expect(audit.records[1]).toMatchObject({ event: "mcp.serve_result", attributes: { outcome: "error" } });
  });

  it("unknown JSON-RPC method -> -32601 error", async () => {
    const audit = createFakeAuditStore();
    registerMcpServer(app, { capabilities: [], policy: allowAllPolicyEngine(), audit, verifyToken });
    await app.ready();

    const res = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "resources/list" }, { bearer: "valid-token" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32601);
  });
});
