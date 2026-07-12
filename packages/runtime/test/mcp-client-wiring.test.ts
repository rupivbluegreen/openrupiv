import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { FakeDb } from "./helpers/fakeDb";
import { buildTestServer, testConfig } from "./helpers/testServer";

/** Write `contents` (or nothing) to a fresh temp file; returns its path. */
async function mcpServersConfigFile(contents: string | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openrupiv-mcp-servers-"));
  const file = path.join(dir, "servers.json");
  if (contents !== undefined) {
    await writeFile(file, contents, "utf8");
  }
  return file;
}

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

  describe("loadMcpServersConfig error paths (via config.mcpServersConfigPath)", () => {
    it("throws ERR_CONFIG when the file does not exist", async () => {
      const db = new FakeDb();
      const missingPath = path.join(
        await mkdtemp(path.join(tmpdir(), "openrupiv-mcp-servers-")),
        "does-not-exist.json",
      );
      const config = testConfig({ mcpServersConfigPath: missingPath });
      await expect(
        buildTestServer(fixtures.vendorOnboardingSpec, db, { config }),
      ).rejects.toMatchObject({ code: "ERR_CONFIG" });
    });

    it("throws ERR_CONFIG when the file is not valid JSON", async () => {
      const db = new FakeDb();
      const filePath = await mcpServersConfigFile("{ not json");
      const config = testConfig({ mcpServersConfigPath: filePath });
      await expect(
        buildTestServer(fixtures.vendorOnboardingSpec, db, { config }),
      ).rejects.toMatchObject({ code: "ERR_CONFIG" });
    });

    it("throws ERR_CONFIG when servers is missing", async () => {
      const db = new FakeDb();
      const filePath = await mcpServersConfigFile(JSON.stringify({}));
      const config = testConfig({ mcpServersConfigPath: filePath });
      await expect(
        buildTestServer(fixtures.vendorOnboardingSpec, db, { config }),
      ).rejects.toMatchObject({ code: "ERR_CONFIG" });
    });

    it("throws ERR_CONFIG when servers is not an array", async () => {
      const db = new FakeDb();
      const filePath = await mcpServersConfigFile(JSON.stringify({ servers: "not-an-array" }));
      const config = testConfig({ mcpServersConfigPath: filePath });
      await expect(
        buildTestServer(fixtures.vendorOnboardingSpec, db, { config }),
      ).rejects.toMatchObject({ code: "ERR_CONFIG" });
    });
  });
});
