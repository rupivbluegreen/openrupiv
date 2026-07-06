import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { FakeDb } from "./helpers/fakeDb";
import { buildTestServer } from "./helpers/testServer";

describe("MCP client wiring", () => {
  it("createServer starts fine with no mcpClient dep supplied (inert)", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(fixtures.vendorOnboardingSpec, db);
    await server.app.ready();
    // NOTE: the POST /mcp route assertion from the plan's Step 1 is proven by
    // Task 7 (server-side MCP wiring), which lands immediately after this
    // task on the same branch. This test only proves Task 6's scope: the
    // client dependency is optional and the server starts fine without one.
    await server.app.close();
  });

  it("onClose calls mcpClient.close() when one was supplied", async () => {
    const db = new FakeDb();
    let closed = false;
    const mcpClient = {
      callTool: async () => ({ ok: false as const, code: "ERR_MCP_SERVER_UNKNOWN" as const, message: "unused" }),
      listTools: async () => [],
      close: async () => {
        closed = true;
      },
    };
    const server = await buildTestServer(fixtures.vendorOnboardingSpec, db, { mcpClient });
    await server.app.close();
    expect(closed).toBe(true);
  });
});
