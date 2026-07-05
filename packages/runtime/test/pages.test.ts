import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { escapeHtml } from "../src/pages";
import { FakeDb } from "./helpers/fakeDb";
import {
  buildTestServer,
  sessionCookieFor,
  type TestServer,
} from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;
const asUser = {
  cookie: sessionCookieFor({ sub: "u1", email: "u1@example.com", roles: ["reviewer"] }),
  accept: "text/html",
};

const XSS = '<script>alert("xss")</script>';
const XSS_ATTR = '" onmouseover="alert(1)';

describe("escapeHtml", () => {
  it("escapes all HTML metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml(XSS)).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("renders null/undefined as empty and stringifies the rest", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
  });
});

describe("SSR pages", () => {
  let db: FakeDb;
  let server: TestServer;

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(spec, db);
  });

  it("GET / renders an index of the app's pages", async () => {
    const res = await server.app.inject({ method: "GET", url: "/", headers: asUser });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    for (const page of spec.pages ?? []) {
      expect(res.body).toContain(`/p/${page.name}`);
    }
    // logged-in user is displayed
    expect(res.body).toContain("u1@example.com");
  });

  it("list pages render records in a table and ESCAPE user data", async () => {
    db.seedRow("vendor", { name: XSS, contact_email: "x@x", country: "DE" });
    const res = await server.app.inject({
      method: "GET",
      url: "/p/vendors",
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(XSS);
    expect(res.body).toContain("&lt;script&gt;");
    expect(res.body).toContain("DE");
  });

  it("list pages respect the page's field selection", async () => {
    db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "SHOULD-NOT-APPEAR",
      annual_spend: 5,
      status: "draft",
    });
    const res = await server.app.inject({
      method: "GET",
      url: "/p/applications", // fields: vendor, status, annualSpend
      headers: asUser,
    });
    expect(res.body).toContain("draft");
    expect(res.body).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("detail pages render every field, escaped, plus workflow actions", async () => {
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: XSS,
      annual_spend: 9000,
      status: "in_review",
    });
    const res = await server.app.inject({
      method: "GET",
      url: `/p/application-detail?id=${String(row["id"])}`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(XSS);
    expect(res.body).toContain("&lt;script&gt;");
    expect(res.body).toContain("in_review");
    // Only transitions available from in_review are offered:
    expect(res.body).toContain(`/transitions/approve`);
    expect(res.body).toContain(`/transitions/reject`);
    expect(res.body).not.toContain(`/transitions/submit`);
  });

  it("detail pages show approval progress", async () => {
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "j",
      status: "in_review",
    });
    await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${String(row["id"])}/transitions/approve`,
      headers: { cookie: asUser.cookie },
    });
    const res = await server.app.inject({
      method: "GET",
      url: `/p/application-detail?id=${String(row["id"])}`,
      headers: asUser,
    });
    expect(res.body).toContain("1 of 2 approvals");
  });

  it("detail pages require a valid ?id and 404 on unknown records", async () => {
    const missingId = await server.app.inject({
      method: "GET",
      url: "/p/application-detail",
      headers: asUser,
    });
    expect(missingId.statusCode).toBe(400);

    const unknown = await server.app.inject({
      method: "GET",
      url: `/p/application-detail?id=${randomUUID()}`,
      headers: asUser,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("form pages render inputs that POST to the entity API", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/p/vendor-form",
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/api/vendor"');
    expect(res.body).toContain('name="name"');
    expect(res.body).toContain('name="contactEmail"');
    expect(res.body).toContain('name="riskTier"');
  });

  it("form pages NEVER render an input for the workflow state field", async () => {
    // project-form defaults to all fields, and `phase` is Project's state field
    const trackerDb = new FakeDb();
    const tracker = await buildTestServer(fixtures.projectTrackerSpec, trackerDb);
    const res = await tracker.app.inject({
      method: "GET",
      url: "/p/project-form",
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('name="phase"');
    expect(res.body).toContain('name="name"');
  });

  it("reference fields render as selects of existing records, escaped", async () => {
    db.seedRow("vendor", { name: XSS_ATTR, contact_email: "x@x" });
    const res = await server.app.inject({
      method: "GET",
      url: "/p/application-form",
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="vendor"');
    expect(res.body).not.toContain(XSS_ATTR);
    expect(res.body).toContain("&quot; onmouseover=&quot;");
  });

  it("pages are session-gated like everything else", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/p/vendors",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/login");
  });
});
