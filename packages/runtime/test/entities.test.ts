import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { FakeDb } from "./helpers/fakeDb";
import { buildTestServer, sessionCookieFor, type TestServer } from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;
const asUser = { cookie: sessionCookieFor({ sub: "u1", roles: ["requester"] }) };

describe("entity CRUD API", () => {
  let db: FakeDb;
  let server: TestServer;

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(spec, db);
  });

  describe("POST /api/<entity> (create)", () => {
    it("creates a record and returns 201 with camelCase fields", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor",
        headers: asUser,
        payload: { name: "Acme", contactEmail: "a@acme.test", country: "DE" },
      });
      expect(res.statusCode).toBe(201);
      const record = res.json() as Record<string, unknown>;
      expect(record["name"]).toBe("Acme");
      expect(record["contactEmail"]).toBe("a@acme.test");
      expect(record["country"]).toBe("DE");
      expect(typeof record["id"]).toBe("string");
      expect(record["createdAt"]).toBeTruthy();

      // Stored under snake_case columns.
      const row = db.rows("vendor")[0] as Record<string, unknown>;
      expect(row["contact_email"]).toBe("a@acme.test");
    });

    it("rejects missing required fields with 400 ERR_VALIDATION", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor",
        headers: asUser,
        payload: { country: "DE" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; details: { field: string }[] };
      expect(body.error).toBe("ERR_VALIDATION");
      const fields = body.details.map((d) => d.field).sort();
      expect(fields).toEqual(["contactEmail", "name"]);
    });

    it("rejects unknown fields with 400 ERR_VALIDATION", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor",
        headers: asUser,
        payload: { name: "A", contactEmail: "a@a.a", hacker: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "ERR_VALIDATION" });
    });

    it("rejects invalid enum values", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor",
        headers: asUser,
        payload: { name: "A", contactEmail: "a@a.a", riskTier: "extreme" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects non-uuid reference values", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor-application",
        headers: asUser,
        payload: { vendor: "not-a-uuid", justification: "because" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "ERR_VALIDATION" });
    });

    it("server-sets the workflow state field to the initial state", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor-application",
        headers: asUser,
        payload: { vendor: randomUUID(), justification: "new vendor" },
      });
      expect(res.statusCode).toBe(201);
      const record = res.json() as Record<string, unknown>;
      expect(record["status"]).toBe("draft");
    });

    it("rejects client-supplied state field on create (read-only)", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor-application",
        headers: asUser,
        payload: {
          vendor: randomUUID(),
          justification: "sneaky",
          status: "approved",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: "ERR_STATE_FIELD_READONLY",
        details: { field: "status" },
      });
      expect(db.rows("vendor_application")).toHaveLength(0);
    });

    it("coerces form-encoded values and redirects to the detail page", async () => {
      const vendorId = randomUUID();
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor-application",
        headers: { ...asUser, "content-type": "application/x-www-form-urlencoded" },
        payload: `vendor=${vendorId}&justification=hello&annualSpend=50000`,
      });
      expect(res.statusCode).toBe(303);
      const row = db.rows("vendor_application")[0] as Record<string, unknown>;
      expect(row["annual_spend"]).toBe(50000);
      expect(res.headers.location).toBe(
        `/p/application-detail?id=${String(row["id"])}`,
      );
    });

    it("treats empty form values as absent (400 when required)", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor",
        headers: { ...asUser, "content-type": "application/x-www-form-urlencoded" },
        payload: "name=&contactEmail=",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/<entity> (list) and GET /:id", () => {
    it("lists records newest first", async () => {
      db.seedRow("vendor", { name: "One", contact_email: "1@x", created_at: "2026-01-01T00:00:00Z" });
      db.seedRow("vendor", { name: "Two", contact_email: "2@x", created_at: "2026-02-01T00:00:00Z" });
      const res = await server.app.inject({
        method: "GET",
        url: "/api/vendor",
        headers: asUser,
      });
      expect(res.statusCode).toBe(200);
      const list = res.json() as Record<string, unknown>[];
      expect(list.map((r) => r["name"])).toEqual(["Two", "One"]);
    });

    it("fetches a record by id", async () => {
      const row = db.seedRow("vendor", { name: "One", contact_email: "1@x" });
      const res = await server.app.inject({
        method: "GET",
        url: `/api/vendor/${String(row["id"])}`,
        headers: asUser,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Record<string, unknown>)["name"]).toBe("One");
    });

    it("404s for an unknown id and 400s for a malformed one", async () => {
      const missing = await server.app.inject({
        method: "GET",
        url: `/api/vendor/${randomUUID()}`,
        headers: asUser,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "ERR_NOT_FOUND" });

      const malformed = await server.app.inject({
        method: "GET",
        url: "/api/vendor/not-a-uuid",
        headers: asUser,
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ error: "ERR_VALIDATION" });
    });
  });

  describe("PUT /api/<entity>/:id (update)", () => {
    it("updates provided fields only", async () => {
      const row = db.seedRow("vendor_application", {
        vendor_id: randomUUID(),
        justification: "old",
        status: "draft",
      });
      const res = await server.app.inject({
        method: "PUT",
        url: `/api/vendor-application/${String(row["id"])}`,
        headers: asUser,
        payload: { annualSpend: 123.5 },
      });
      expect(res.statusCode).toBe(200);
      const record = res.json() as Record<string, unknown>;
      expect(record["annualSpend"]).toBe(123.5);
      expect(record["justification"]).toBe("old");
    });

    it("rejects state field writes on update (read-only)", async () => {
      const row = db.seedRow("vendor_application", {
        vendor_id: randomUUID(),
        justification: "j",
        status: "draft",
      });
      const res = await server.app.inject({
        method: "PUT",
        url: `/api/vendor-application/${String(row["id"])}`,
        headers: asUser,
        payload: { status: "approved" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "ERR_STATE_FIELD_READONLY" });
      const unchanged = db.rows("vendor_application")[0] as Record<string, unknown>;
      expect(unchanged["status"]).toBe("draft");
    });

    it("404s when updating a missing record", async () => {
      const res = await server.app.inject({
        method: "PUT",
        url: `/api/vendor/${randomUUID()}`,
        headers: asUser,
        payload: { name: "X" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects an empty update body", async () => {
      const row = db.seedRow("vendor", { name: "n", contact_email: "e@x" });
      const res = await server.app.inject({
        method: "PUT",
        url: `/api/vendor/${String(row["id"])}`,
        headers: asUser,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "ERR_VALIDATION" });
    });
  });

  describe("route surface", () => {
    it("does not expose DELETE (v0)", async () => {
      const row = db.seedRow("vendor", { name: "n", contact_email: "e@x" });
      const res = await server.app.inject({
        method: "DELETE",
        url: `/api/vendor/${String(row["id"])}`,
        headers: asUser,
      });
      expect(res.statusCode).toBe(404);
    });

    it("unknown routes return machine-readable 404s", async () => {
      const res = await server.app.inject({
        method: "GET",
        url: "/api/nonexistent",
        headers: asUser,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ERR_NOT_FOUND" });
    });
  });
});
