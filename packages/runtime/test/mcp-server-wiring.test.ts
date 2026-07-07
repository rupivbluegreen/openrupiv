import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { signPayload } from "../src/session";
import { FakeDb } from "./helpers/fakeDb";
import { buildTestServer, sessionCookieFor, TEST_SESSION_SECRET } from "./helpers/testServer";

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

  it("POST /mcp with a garbage/malformed bearer -> 401 (finding mcp-bearer-negative-path-untested)", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer not-a-real-token-at-all" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /mcp with a validly-signed txn-purpose token presented as a bearer -> 401 (cross-purpose token rejected, mirrors auth.ts's 'txn replayed as session cookie' test)", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    // Forge exactly what /auth/login hands an unauthenticated caller: a
    // validly-signed txn payload -- but for the "txn" purpose, not
    // "session". Presented as an MCP bearer it must NOT authenticate,
    // proving verifyToken's `verifyPayload<SessionData>(bearer, secret,
    // "session")` call genuinely checks the purpose and doesn't just
    // verify the HMAC signature.
    const now = Math.floor(Date.now() / 1000);
    const txn = {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      iat: now,
      exp: now + 600,
    };
    const txnToken = signPayload(txn, TEST_SESSION_SECRET, "txn");
    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${txnToken}` },
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
