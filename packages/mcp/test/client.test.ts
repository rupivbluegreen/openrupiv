import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActorType } from "@openrupiv/audit";
import type { PolicySubject } from "@openrupiv/policy";
import { createMcpClientWithTransportBuilder, type TransportBuilder } from "../src/client";
import type { McpServerEntry } from "../src/types";
import {
  allowAllPolicyEngine,
  createFakeAuditStore,
  createFakePolicyEngine,
  denyActionPolicyEngine,
  withFailingAppend,
} from "./helpers/fakes";
import { startFakeMcpServer, type FakeMcpServer } from "./helpers/fakeMcpServer";

const subject: PolicySubject = { id: "u1", roles: ["reviewer"] };
const actorType: ActorType = "human";

/** Wires each dummy `{kind:"stdio", command:"fake:<key>"}` entry to a pre-started fake server's transport. */
function transportBuilderFor(servers: Record<string, FakeMcpServer>): TransportBuilder {
  return (transport) => {
    if (transport.kind !== "stdio") {
      throw new Error("test transport builder only understands the stdio-shaped fake marker");
    }
    const key = transport.command.replace(/^fake:/, "");
    const fake = servers[key];
    if (!fake) throw new Error(`no fake server registered for key "${key}"`);
    return fake.clientTransport as Transport;
  };
}

function fakeEntry(name: string, key: string, allowedTools: string[]): McpServerEntry {
  return { name, transport: { kind: "stdio", command: `fake:${key}`, args: [] }, allowedTools };
}

describe("createMcpClient / callTool", () => {
  const started: FakeMcpServer[] = [];
  afterEach(async () => {
    while (started.length > 0) {
      const s = started.pop();
      await s?.close().catch(() => {});
    }
  });

  async function fakeServer(): Promise<FakeMcpServer> {
    const s = await startFakeMcpServer();
    started.push(s);
    return s;
  }

  it("unknown server -> ERR_MCP_SERVER_UNKNOWN before any wire attempt, audited", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must not be called for an unknown server");
    });
    const client = await createMcpClientWithTransportBuilder({ servers: [] }, { policy: allowAllPolicyEngine(), audit }, buildTransport);

    const result = await client.callTool({ server: "nope", tool: "echo", args: {}, subject, actorType });

    expect(result).toEqual({ ok: false, code: "ERR_MCP_SERVER_UNKNOWN", message: expect.stringContaining("nope") });
    expect(buildTransport).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "deny", attributes: { code: "ERR_MCP_SERVER_UNKNOWN" } });
  });

  it("empty McpClientConfig.servers -> client is fully inert (every callTool -> ERR_MCP_SERVER_UNKNOWN)", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must never be called with an empty server list");
    });
    const client = await createMcpClientWithTransportBuilder({ servers: [] }, { policy: allowAllPolicyEngine(), audit }, buildTransport);

    for (const server of ["a", "b", "c"]) {
      const result = await client.callTool({ server, tool: "echo", args: {}, subject, actorType });
      expect(result).toMatchObject({ ok: false, code: "ERR_MCP_SERVER_UNKNOWN" });
    }
    expect(buildTransport).not.toHaveBeenCalled();
  });

  it("empty McpClientConfig.servers -> listTools throws before any transport is built", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must never be called with an empty server list");
    });
    const client = await createMcpClientWithTransportBuilder({ servers: [] }, { policy: allowAllPolicyEngine(), audit }, buildTransport);

    await expect(client.listTools("anything")).rejects.toThrow();
    expect(buildTransport).not.toHaveBeenCalled();
  });

  it("empty McpClientConfig.servers -> close() resolves cleanly with zero connections", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must never be called with an empty server list");
    });
    const client = await createMcpClientWithTransportBuilder({ servers: [] }, { policy: allowAllPolicyEngine(), audit }, buildTransport);

    await expect(client.close()).resolves.toBeUndefined();
    expect(buildTransport).not.toHaveBeenCalled();
  });

  it("tool not in allowedTools -> ERR_MCP_TOOL_NOT_ALLOWED, no wire attempt", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must not be called when the tool is not allowlisted");
    });
    const entry = fakeEntry("srv", "srv", ["only-this-one"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      buildTransport,
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });
    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_TOOL_NOT_ALLOWED" });
    expect(buildTransport).not.toHaveBeenCalled();
    expect(audit.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "deny", attributes: { code: "ERR_MCP_TOOL_NOT_ALLOWED" } });
  });

  it("policy deny -> ERR_MCP_POLICY_DENIED, audited as mcp.tool_call decision deny, upstream never called", async () => {
    const audit = createFakeAuditStore();
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must not be called when policy denies");
    });
    const entry = fakeEntry("srv", "srv", ["echo"]);
    const policy = denyActionPolicyEngine("mcp.tool:srv/echo");
    const client = await createMcpClientWithTransportBuilder({ servers: [entry] }, { policy, audit }, buildTransport);

    const result = await client.callTool({ server: "srv", tool: "echo", args: { x: 1 }, subject, actorType });

    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_POLICY_DENIED" });
    expect(buildTransport).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "deny" });
  });

  it("audit-append failure before the call -> ERR_MCP_AUDIT_UNAVAILABLE, upstream never called", async () => {
    const base = createFakeAuditStore();
    const audit = withFailingAppend(base, () => true);
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must not be called when the before-call audit append fails");
    });
    const entry = fakeEntry("srv", "srv", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      buildTransport,
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });

    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_AUDIT_UNAVAILABLE" });
    expect(buildTransport).not.toHaveBeenCalled();
    expect(base.records).toHaveLength(0);
  });

  it("AFTER-append failure only: the real result is still returned (best-effort), BEFORE record survives, no exception", async () => {
    const base = createFakeAuditStore();
    // Fail only the 2nd append (the AFTER mcp.tool_result) -- the BEFORE
    // append (index 0) must succeed so this isolates the AFTER-only path,
    // unlike the unconditional-failure test above which only ever exercises
    // the BEFORE-failure fail-closed path.
    const audit = withFailingAppend(base, (_input, idx) => idx === 1);
    const fake = await fakeServer();
    const entry = fakeEntry("srv", "one", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: { n: 1 }, subject, actorType });

    // The tool call itself succeeded; a best-effort AFTER-audit failure must
    // not be surfaced to the caller as a different outcome.
    expect(result.ok).toBe(true);
    expect(base.records).toHaveLength(1);
    expect(base.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "allow" });
  });

  it("bearer token never appears in audit records for an http-transport server (end-to-end)", async () => {
    process.env["TEST_MCP_E2E_TOKEN"] = "super-secret-should-not-leak";
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    const entry: McpServerEntry = {
      name: "srv",
      transport: { kind: "http", url: "https://mcp.example.com/mcp", auth: { kind: "bearer", tokenEnv: "TEST_MCP_E2E_TOKEN" } },
      allowedTools: ["echo"],
    };
    // The wire-level transport is faked (same in-memory pair used elsewhere)
    // -- this test asserts the AUDIT layer never carries the token, not that
    // makeSafeFetch behaves correctly (that's safe-fetch.test.ts's job).
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      () => fake.clientTransport as Transport,
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: { n: 1 }, subject, actorType });
    expect(result.ok).toBe(true);
    expect(audit.records).toHaveLength(2);

    const serialized = JSON.stringify(audit.records);
    expect(serialized).not.toContain("super-secret-should-not-leak");
    delete process.env["TEST_MCP_E2E_TOKEN"];
  });

  it("full successful round trip: both audit records present, in order, args/content digested not raw", async () => {
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    const entry = fakeEntry("srv", "one", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: { secret: "shhh", n: 1 }, subject, actorType });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.content)).toContain("shhh"); // the actual tool result content is not secret in this test
    }

    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "allow", subject: "srv/echo" });
    expect(audit.records[1]).toMatchObject({ event: "mcp.tool_result", subject: "srv/echo", attributes: { outcome: "ok" } });

    // Neither audit record's attributes ever carry the raw args — only a digest.
    const beforeAttrs = JSON.stringify(audit.records[0]?.attributes ?? {});
    expect(beforeAttrs).not.toContain("shhh");
    expect(beforeAttrs).toMatch(/argsDigest/);
    const afterAttrs = JSON.stringify(audit.records[1]?.attributes ?? {});
    expect(afterAttrs).toMatch(/contentDigest/);
    expect(typeof (audit.records[1]?.attributes as Record<string, unknown> | undefined)?.["durationMs"]).toBe("number");
  });

  it("upstream tool error (isError result) -> ERR_MCP_UPSTREAM, mcp.tool_result records outcome error", async () => {
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    const entry = fakeEntry("srv", "one", ["boom"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );

    const result = await client.callTool({ server: "srv", tool: "boom", args: {}, subject, actorType });
    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_UPSTREAM" });
    expect(audit.records).toHaveLength(2);
    expect(audit.records[1]).toMatchObject({ event: "mcp.tool_result", attributes: { outcome: "error" } });
  });

  it("unsupported negotiated revision -> ERR_MCP_PROTOCOL, disconnected, audited", async () => {
    const audit = createFakeAuditStore();
    const fake = await startFakeMcpServer({ protocolVersionOverride: "2024-11-05" });
    started.push(fake);
    const entry = fakeEntry("srv", "one", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );

    const result = await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });

    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_PROTOCOL" });
    // Enforcement gate (server/tool/policy) passed -> mcp.tool_call recorded allow,
    // then the wire-level negotiation failure is recorded on mcp.tool_result.
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({ event: "mcp.tool_call", decision: "allow" });
    expect(audit.records[1]).toMatchObject({ event: "mcp.tool_result", attributes: { outcome: "error", code: "ERR_MCP_PROTOCOL" } });
  });

  it("listTools returns only tools within the server's allowedTools", async () => {
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    const entry = fakeEntry("srv", "one", ["echo"]); // "boom" exists upstream but is not allowlisted
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );

    const tools = await client.listTools("srv");
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("close() closes all cached connections", async () => {
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    const entry = fakeEntry("srv", "one", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      transportBuilderFor({ one: fake }),
    );
    await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("reuses the same connection across multiple calls (does not reconnect per call)", async () => {
    const audit = createFakeAuditStore();
    const fake = await fakeServer();
    let connectCalls = 0;
    const baseBuilder = transportBuilderFor({ one: fake });
    const countingBuilder: TransportBuilder = (t) => {
      connectCalls += 1;
      return baseBuilder(t);
    };
    const entry = fakeEntry("srv", "one", ["echo"]);
    const client = await createMcpClientWithTransportBuilder(
      { servers: [entry] },
      { policy: allowAllPolicyEngine(), audit },
      countingBuilder,
    );

    await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });
    await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });

    expect(connectCalls).toBe(1);
  });

  it("uses a distinct fake policy engine to exercise deny reasons surfaced in the error message", async () => {
    const audit = createFakeAuditStore();
    const policy = createFakePolicyEngine(() => ({ allow: false, reason: "not a reviewer", policyId: "test" }));
    const entry = fakeEntry("srv", "srv", ["echo"]);
    const buildTransport = vi.fn<TransportBuilder>(() => {
      throw new Error("must not be called");
    });
    const client = await createMcpClientWithTransportBuilder({ servers: [entry] }, { policy, audit }, buildTransport);
    const result = await client.callTool({ server: "srv", tool: "echo", args: {}, subject, actorType });
    expect(result).toMatchObject({ ok: false, code: "ERR_MCP_POLICY_DENIED", message: expect.stringContaining("not a reviewer") });
  });
});
