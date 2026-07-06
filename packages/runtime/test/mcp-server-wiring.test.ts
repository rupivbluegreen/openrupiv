import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { FakeDb } from "./helpers/fakeDb";
import { buildTestServer, sessionCookieFor } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;

describe("MCP server wiring", () => {
  it("POST /mcp with no bearer -> 401", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /mcp with a valid session-cookie-as-bearer token can call tools/call for workflow-instance-status", async () => {
    const db = new FakeDb();
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "j",
      annual_spend: 1,
      status: "in_review",
    });
    const recordId = String(row["id"]);
    const server = await buildTestServer(spec, db);
    // sessionCookieFor returns a raw `name=value` cookie string (no other
    // attributes) -- see testServer.ts -- so the bearer is everything after
    // the cookie-name prefix, no trailing-attribute split needed.
    const bearer = sessionCookieFor({ sub: "u1", roles: [] }).replace(/^openrupiv_session=/, "");

    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "workflow-instance-status", arguments: { entityTable: "vendor_application", id: recordId } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const content = JSON.parse(body.result.content[0].text);
    expect(content.status).toBe("in_review");
  });
});
