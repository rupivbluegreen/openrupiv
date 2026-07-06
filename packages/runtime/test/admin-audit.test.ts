/**
 * /admin/audit + /admin/audit/export tests: policy-gated (action
 * `audit.read`, platform admin-like roles), decisions audited both ways,
 * verify() status reported, tampering surfaced, SIEM export formats valid.
 * Uses the REAL WASM policy engine and the REAL Db-backed audit store over
 * FakeDb.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { appendRecord, rowToRecord, type AuditRecord } from "@openrupiv/audit";
import { fixtures } from "@openrupiv/spec";
import { AUDIT_READ_ROLES } from "../src/admin";
import { FakeDb } from "./helpers/fakeDb";
import {
  buildTestServer,
  sessionCookieFor,
  type TestServer,
} from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;

/**
 * Seed `count` more chained records directly into FakeDb's audit_log table
 * (bypassing the store's own append path — this is about exercising the
 * EXPORT route's pagination across a large chain quickly, not the append
 * path itself). Chains onto whatever the current tail already is.
 */
function seedLargeChain(db: FakeDb, count: number): void {
  const existing = db.auditRows();
  let prev: AuditRecord | null =
    existing.length > 0 ? rowToRecord(existing[existing.length - 1]!) : null;
  const table = db.table("audit_log");
  for (let i = 0; i < count; i++) {
    const record = appendRecord(
      prev,
      { event: "bulk.append", actor: `u${i}`, actorType: "system" },
      new Date(Date.UTC(2026, 6, 6, 0, 0, i % 60)).toISOString(),
    );
    table.set(String(record.seq), {
      seq: record.seq,
      timestamp: record.timestamp,
      event: record.event,
      actor: record.actor,
      actor_type: record.actorType,
      subject: record.subject ?? null,
      decision: record.decision ?? null,
      attributes: record.attributes,
      prev_hash: record.prevHash,
      hash: record.hash,
    });
    prev = record;
  }
}

const admin = { cookie: sessionCookieFor({ sub: "u-admin", roles: ["admin"] }) };
const auditor = { cookie: sessionCookieFor({ sub: "u-auditor", roles: ["auditor"] }) };
const reviewer = { cookie: sessionCookieFor({ sub: "u-reviewer", roles: ["reviewer"] }) };
const requester = { cookie: sessionCookieFor({ sub: "u-requester", roles: ["requester"] }) };

function auditRecords(db: FakeDb): AuditRecord[] {
  return db.auditRows().map(rowToRecord);
}

describe("/admin/audit", () => {
  let db: FakeDb;
  let server: TestServer;

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(spec, db);
    // Populate the chain with a real event: one guarded transition.
    const row = db.seedRow("vendor_application", {
      vendor_id: "00000000-0000-4000-8000-000000000002",
      justification: "seed",
      annual_spend: 1,
      status: "draft",
    });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${String(row["id"])}/transitions/submit`,
      headers: requester,
    });
    expect(res.statusCode).toBe(200);
  });

  it("exposes the platform audit-read roles", () => {
    expect(AUDIT_READ_ROLES).toEqual(["admin", "auditor"]);
  });

  it("returns a page of the chain for an admin, with NO full-chain verify by default (finding audit-read-unbounded-memory)", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      verify?: { ok: boolean; count: number };
      page: { fromSeq: number; limit: number; count: number };
      records: AuditRecord[];
    };
    // Chain: policy.decision (submit's guard-role decision, now appended
    // BEFORE the transition it authorizes — see finding
    // "post-commit-flush-ordering") + workflow.transition + the audit.read
    // allow decision itself.
    expect(body.verify).toBeUndefined();
    expect(body.page).toEqual({ fromSeq: 1, limit: 100, count: 3 });
    expect(body.records.map((r) => r.event)).toEqual([
      "policy.decision",
      "workflow.transition",
      "policy.decision",
    ]);
    const readDecision = body.records[2] as AuditRecord;
    expect(readDecision).toMatchObject({
      actor: "u-admin",
      decision: "allow",
      subject: "audit_log",
      attributes: { action: "audit.read" },
    });
  });

  it("runs a full-chain verify only when explicitly requested via ?verify=full (finding audit-read-unbounded-memory)", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit?verify=full",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verify: { ok: boolean; count: number } };
    // count covers the audit.read allow decision itself, appended before
    // verify runs.
    expect(body.verify).toEqual({ ok: true, count: 3 });
  });

  it("allows the auditor role too", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: auditor,
    });
    expect(res.statusCode).toBe(200);
  });

  it("403s an app role (reviewer) and audits the DENY", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: reviewer,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "ERR_FORBIDDEN_ROLE",
      details: { requiredRoles: ["admin", "auditor"] },
    });

    const denial = auditRecords(db).pop();
    expect(denial).toMatchObject({
      event: "policy.decision",
      actor: "u-reviewer",
      decision: "deny",
      subject: "audit_log",
      attributes: { action: "audit.read" },
    });
  });

  it("401s API clients without a session; browsers get a login redirect", async () => {
    const api = await server.app.inject({ method: "GET", url: "/admin/audit" });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ error: "ERR_UNAUTHENTICATED" });

    const browser = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { accept: "text/html" },
    });
    expect(browser.statusCode).toBe(302);
    expect(browser.headers.location).toBe(
      `/auth/login?returnTo=${encodeURIComponent("/admin/audit")}`,
    );
  });

  it("paginates with fromSeq/limit and rejects invalid values", async () => {
    const page = await server.app.inject({
      method: "GET",
      url: "/admin/audit?fromSeq=2&limit=1",
      headers: admin,
    });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { records: AuditRecord[]; page: { count: number } };
    expect(body.page.count).toBe(1);
    expect(body.records[0]?.seq).toBe(2);

    const bad = await server.app.inject({
      method: "GET",
      url: "/admin/audit?limit=zero",
      headers: admin,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "ERR_VALIDATION" });
  });

  it("TAMPER-EVIDENT: a mutated record makes ?verify=full fail with the exact seq", async () => {
    // Tamper with the first record directly in storage (bypassing the
    // append-only API, as an attacker with DB access would).
    const first = db.table("audit_log").get("1");
    expect(first).toBeDefined();
    first!["actor"] = "attacker";

    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit?verify=full",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verify: { ok: boolean; failedSeq?: number; reason?: string } };
    expect(body.verify.ok).toBe(false);
    expect(body.verify.failedSeq).toBe(1);
    expect(body.verify.reason).toBe("hash_mismatch");
  });
});

describe("/admin/audit/export", () => {
  let db: FakeDb;
  let server: TestServer;

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(spec, db);
    const row = db.seedRow("vendor_application", {
      vendor_id: "00000000-0000-4000-8000-000000000003",
      justification: "seed",
      annual_spend: 1,
      status: "draft",
    });
    await server.app.inject({
      method: "POST",
      url: `/api/vendor-application/${String(row["id"])}/transitions/submit`,
      headers: requester,
    });
  });

  it("exports JSONL by default (one parseable record per line, chain fields included)", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");

    const lines = res.body.split("\n");
    // submit's guard-role decision (now precedes the transition it
    // authorizes) + the transition itself + this export's own audit.read
    // decision.
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(parsed[0]).toMatchObject({ seq: 1, event: "policy.decision" });
    expect(parsed[1]).toMatchObject({ seq: 2, event: "workflow.transition" });
    expect(parsed[2]).toMatchObject({
      event: "policy.decision",
      attributes: { action: "audit.read" },
    });
    for (const record of parsed) {
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.prevHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("STREAMED, NOT BUFFERED: export spans multiple internal pages without truncation or duplication (finding audit-read-unbounded-memory)", async () => {
    // 2 existing (from beforeEach) + 1500 seeded, well past any plausible
    // internal page size, so this only passes if the pagination loop
    // correctly advances fromSeq across page boundaries instead of, say,
    // silently stopping at the first page.
    seedLargeChain(db, 1500);
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n");
    // 2 (submit) + 1500 (seeded) + 1 (this export's own audit.read decision).
    expect(lines).toHaveLength(1503);
    const seqs = lines.map((l) => (JSON.parse(l) as AuditRecord).seq);
    expect(seqs).toEqual(Array.from({ length: 1503 }, (_, i) => i + 1));
  });

  it("exports OTLP logs JSON", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export?format=otlp",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    expect(body.resourceLogs).toHaveLength(1);
    expect(body.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(3);
  });

  it("exports RFC 5424 syslog lines", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export?format=syslog",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const lines = res.body.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^<13>1 /);
      expect(line).toContain("openrupiv audit");
    }
  });

  it("400s an unknown format", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export?format=csv",
      headers: admin,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ERR_VALIDATION" });
  });

  it("403s a non-admin and audits the denial", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit/export",
      headers: reviewer,
    });
    expect(res.statusCode).toBe(403);
    const denial = auditRecords(db).pop();
    expect(denial).toMatchObject({
      event: "policy.decision",
      actor: "u-reviewer",
      decision: "deny",
      attributes: { action: "audit.read" },
    });
  });
});

describe("finding audit-role-namespace-collision: an app-declared role must never satisfy the platform audit-read check", () => {
  // An app spec that (perhaps unwisely, but validly) declares its own
  // domain role named literally "admin" — nothing in validateSpec reserves
  // this name for the platform.
  const collidingSpec = {
    ...fixtures.vendorOnboardingSpec,
    app: { ...fixtures.vendorOnboardingSpec.app, roles: ["admin", "requester"] },
  };

  it("a session holding ONLY the app-granted 'admin' role (not a platform-sourced one) is DENIED audit.read", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(collidingSpec, db);
    // This user's ENTIRE role set is exactly what the app spec declares —
    // indistinguishable, at the string level, from a genuine platform
    // "admin". It must still be denied.
    const appAdmin = { cookie: sessionCookieFor({ sub: "u-app-admin", roles: ["admin"] }) };

    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: appAdmin,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });

    const denial = auditRecords(db).pop();
    expect(denial).toMatchObject({
      event: "policy.decision",
      actor: "u-app-admin",
      decision: "deny",
      subject: "audit_log",
      attributes: { action: "audit.read" },
    });
  });

  it("a session holding BOTH the colliding app role AND a genuinely distinct platform role is still ALLOWED", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(collidingSpec, db);
    // "admin" is shadowed (app-declared), but "auditor" is not declared by
    // this app spec at all — it can only have come from a real platform
    // grant, so it must still work.
    const platformAuditor = {
      cookie: sessionCookieFor({ sub: "u-real-auditor", roles: ["admin", "auditor"] }),
    };

    const res = await server.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: platformAuditor,
    });
    expect(res.statusCode).toBe(200);
  });
});
