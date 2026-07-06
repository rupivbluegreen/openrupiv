/**
 * Phase 2 audit-event wiring tests (specs/phase-2-contracts.md §2), against
 * fixtures.vendorOnboardingSpec with the REAL Db-backed audit store and the
 * REAL WASM policy engine over FakeDb:
 *
 * - every contract event is emitted with the right actor/actorType/subject/
 *   decision/attributes;
 * - committing events (workflow.transition, workflow.approval_recorded) are
 *   atomic with their side effect (rollback => no audit row; audit failure
 *   => side effect rolled back, request 5xx);
 * - rejection events (workflow.duplicate_approver,
 *   workflow.state_write_rejected) persist despite the rollback;
 * - policy decisions (allow AND deny) are audited;
 * - auth events are best-effort: an audit failure never breaks the request;
 * - the resulting chain always verifies.
 */

import { describe, expect, it } from "vitest";
import {
  rowToRecord,
  verifyChain,
  type AuditRecord,
  type AuditStore,
} from "@openrupiv/audit";
import { fixtures } from "@openrupiv/spec";
import { appendAllOrFail } from "../src/audit";
import { FakeDb } from "./helpers/fakeDb";
import { makeFakeIdp } from "./helpers/fakeIdp";
import {
  buildTestServer,
  CapturingLogger,
  sessionCookieFor,
  type TestServer,
} from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;

const requester = { cookie: sessionCookieFor({ sub: "u-requester", roles: ["requester"] }) };
const reviewer1 = { cookie: sessionCookieFor({ sub: "u-reviewer-1", roles: ["reviewer"] }) };
const compliance = { cookie: sessionCookieFor({ sub: "u-compliance", roles: ["compliance"] }) };
const outsider = { cookie: sessionCookieFor({ sub: "u-outsider", roles: [] }) };

function auditRecords(db: FakeDb): AuditRecord[] {
  return db.auditRows().map(rowToRecord);
}

function eventsOf(db: FakeDb): string[] {
  return auditRecords(db).map((r) => r.event);
}

function lastEvent(db: FakeDb, event: string): AuditRecord | undefined {
  return auditRecords(db)
    .filter((r) => r.event === event)
    .pop();
}

/** An AuditStore whose appends always fail (best-effort / fail-closed tests). */
const brokenAuditStore: AuditStore = {
  append: async () => {
    throw new Error("audit database unavailable");
  },
  read: async () => [],
  verify: async () => ({ ok: true, count: 0 }),
};

function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/** Full offline OIDC login (same path as auth.test.ts). */
async function oidcLogin(
  db: FakeDb,
  options: { roles?: unknown; auditStore?: AuditStore } = {},
): Promise<{ server: TestServer; callbackStatus: number }> {
  const claims = {
    email: "dev@example.com",
    ...(options.roles !== undefined ? { roles: options.roles } : {}),
  };
  const idp = makeFakeIdp({
    clientId: "test-client",
    clientSecret: "test-client-secret-not-the-dev-one",
    claims,
  });
  const server = await buildTestServer(spec, db, {
    oidcProvider: idp.provider,
    ...(options.auditStore ? { auditStore: options.auditStore } : {}),
  });
  const loginRes = await server.app.inject({ method: "GET", url: "/auth/login" });
  const location = new URL(loginRes.headers.location as string);
  idp.setNonce(location.searchParams.get("nonce") as string);
  idp.setClaims(claims);
  const txnCookie = setCookies(loginRes.headers)
    .find((c) => c.startsWith("openrupiv_auth_txn="))
    ?.split(";")[0] as string;
  const callbackRes = await server.app.inject({
    method: "GET",
    url: `/auth/callback?code=fake-code&state=${encodeURIComponent(
      location.searchParams.get("state") as string,
    )}`,
    headers: { cookie: txnCookie },
  });
  return { server, callbackStatus: callbackRes.statusCode };
}

async function workflowSetup(): Promise<{
  db: FakeDb;
  server: TestServer;
  applicationId: string;
  url: (transition: string) => string;
  status: () => unknown;
}> {
  const db = new FakeDb();
  const server = await buildTestServer(spec, db);
  const row = db.seedRow("vendor_application", {
    vendor_id: "00000000-0000-4000-8000-000000000001",
    justification: "we need this vendor",
    annual_spend: 10_000,
    status: "draft",
  });
  const applicationId = String(row["id"]);
  return {
    db,
    server,
    applicationId,
    url: (transition: string) =>
      `/api/vendor-application/${applicationId}/transitions/${transition}`,
    status: () =>
      (db.rows("vendor_application")[0] as Record<string, unknown>)["status"],
  };
}

describe("auth events (best-effort, separate connection)", () => {
  it("auth.login is appended with actor, actorType and roles", async () => {
    const db = new FakeDb();
    const { callbackStatus } = await oidcLogin(db, { roles: ["reviewer"] });
    expect(callbackStatus).toBe(303);

    const login = lastEvent(db, "auth.login");
    expect(login).toMatchObject({
      event: "auth.login",
      actor: "fake-idp-user",
      actorType: "human",
      attributes: { roles: ["reviewer"] },
    });
    expect(verifyChain(auditRecords(db))).toEqual({ ok: true, count: 1 });
  });

  it("auth.dev_role_grant is appended when the ADR-0005 grant fires", async () => {
    const db = new FakeDb();
    const { callbackStatus } = await oidcLogin(db); // no roles claim, devMode
    expect(callbackStatus).toBe(303);

    const grant = lastEvent(db, "auth.dev_role_grant");
    expect(grant).toMatchObject({
      actor: "fake-idp-user",
      actorType: "human",
      attributes: { roles: ["requester", "reviewer", "compliance"] },
    });
    // The grant is followed by the login event, all in one verifiable chain.
    expect(eventsOf(db)).toEqual(["auth.dev_role_grant", "auth.login"]);
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("auth.logout is appended with the actor", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const res = await server.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: sessionCookieFor({ sub: "u9" }) },
    });
    expect(res.statusCode).toBe(200);
    expect(lastEvent(db, "auth.logout")).toMatchObject({
      actor: "u9",
      actorType: "human",
    });
  });

  it("auth.session_rejected is appended with the rejection reason", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const res = await server.app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: {
        cookie: sessionCookieFor({ sub: "u1" }, "wrong-secret-wrong-secret-32ch!!"),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(lastEvent(db, "auth.session_rejected")).toMatchObject({
      actor: "system",
      actorType: "system",
      attributes: { reason: "bad_signature" },
    });
    // The cookie is cleared so the browser stops resending it.
    const cleared = setCookies(res.headers).find((c) =>
      c.startsWith("openrupiv_session="),
    );
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/openrupiv_session=;/);
  });

  it("UNBOUNDED-WRITES FIX: an invalid cookie against a PUBLIC path (/healthz) never appends, even though it is still logged (finding unauth-unbounded-audit-writes)", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const badCookie = {
      cookie: sessionCookieFor({ sub: "u1" }, "wrong-secret-wrong-secret-32ch!!"),
    };
    const res = await server.app.inject({
      method: "GET",
      url: "/healthz",
      headers: badCookie,
    });
    expect(res.statusCode).toBe(200);
    expect(db.auditRows()).toHaveLength(0);
    // Full-fidelity observability is preserved even though nothing was
    // durably appended.
    const rejected = server.logger.find("auth.session_rejected");
    expect(rejected?.fields["reason"]).toBe("bad_signature");
  });

  it("UNBOUNDED-WRITES FIX: the SAME invalid cookie hitting a protected route repeatedly is deduped to one append (finding unauth-unbounded-audit-writes)", async () => {
    const db = new FakeDb();
    const server = await buildTestServer(spec, db);
    const badCookie = {
      cookie: sessionCookieFor({ sub: "u1" }, "wrong-secret-wrong-secret-32ch!!"),
    };
    for (let i = 0; i < 10; i++) {
      const res = await server.app.inject({
        method: "GET",
        url: "/api/vendor",
        headers: badCookie,
      });
      expect(res.statusCode).toBe(401);
    }
    // 10 identical rejected requests -> exactly ONE durable append, not 10.
    expect(auditRecords(db).filter((r) => r.event === "auth.session_rejected")).toHaveLength(1);
  });

  it("BEST-EFFORT: a failing audit store never breaks login; the event is preserved in an error log", async () => {
    const db = new FakeDb();
    const { server, callbackStatus } = await oidcLogin(db, {
      roles: ["reviewer"],
      auditStore: brokenAuditStore,
    });
    // Login still succeeds — auth events must not brick authentication.
    expect(callbackStatus).toBe(303);
    expect(db.auditRows()).toHaveLength(0);

    const failure = server.logger.entries.find(
      (e) =>
        e.fields["event"] === "audit.append_failed" &&
        e.fields["auditEvent"] === "auth.login",
    );
    expect(failure?.level).toBe("error");
    // The full event rides along in the log line so nothing is lost silently.
    expect(failure?.fields["auditRecord"]).toMatchObject({
      event: "auth.login",
      actor: "fake-idp-user",
    });
  });
});

describe("workflow events", () => {
  it("a guarded transition appends workflow.transition atomically plus its policy.decision", async () => {
    const { db, server, applicationId, url } = await workflowSetup();
    const res = await server.app.inject({
      method: "POST",
      url: url("submit"),
      headers: requester,
    });
    expect(res.statusCode).toBe(200);

    const transition = lastEvent(db, "workflow.transition");
    expect(transition).toMatchObject({
      actor: "u-requester",
      actorType: "human",
      subject: `vendor_application:${applicationId}`,
      decision: "allow",
      attributes: {
        workflow: "vendor-approval",
        transition: "submit",
        from: "draft",
        to: "submitted",
      },
    });

    const decision = lastEvent(db, "policy.decision");
    expect(decision).toMatchObject({
      actor: "u-requester",
      decision: "allow",
      attributes: {
        action: "workflow.transition:submit",
        allowedRoles: ["requester"],
        policyId: "openrupiv.authz",
      },
    });
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("CAUSE BEFORE EFFECT: the guard policy.decision precedes its own workflow.transition in the chain (finding post-commit-flush-ordering)", async () => {
    const { db, server, url } = await workflowSetup();
    const res = await server.app.inject({
      method: "POST",
      url: url("submit"),
      headers: requester,
    });
    expect(res.statusCode).toBe(200);

    const records = auditRecords(db);
    expect(records.map((r) => r.event)).toEqual(["policy.decision", "workflow.transition"]);
    const decision = records[0] as AuditRecord;
    const transition = records[1] as AuditRecord;
    expect(decision.seq).toBeLessThan(transition.seq);
    expect(decision.attributes).toMatchObject({ action: "workflow.transition:submit" });
  });

  it("FAIL-CLOSED BEFORE ANY SIDE EFFECT: when the guard-role decision fails to append, the transaction never even opens — no state change, no transition event, no partial commit (finding post-commit-flush-ordering)", async () => {
    const { db, server, url, status } = await workflowSetup();
    // The very first `INSERT INTO audit_log` for this request is now the
    // guard-role policy.decision append, resolved and durably committed
    // BEFORE the state-write transaction opens.
    db.failNextMatching(/^INSERT INTO audit_log/);
    const res = await server.app.inject({
      method: "POST",
      url: url("submit"),
      headers: requester,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "ERR_AUDIT_APPEND_FAILED" });
    // Nothing committed at all: no state change, and — since the decision
    // never durably persisted — no way for the transition it would have
    // authorized to appear either.
    expect(status()).toBe("draft");
    expect(db.auditRows()).toHaveLength(0);
    expect(eventsOf(db)).not.toContain("workflow.transition");
  });

  it("a policy DENY is audited (decision: deny) and no transition event exists", async () => {
    const { db, server, url, status } = await workflowSetup();
    const res = await server.app.inject({
      method: "POST",
      url: url("submit"),
      headers: outsider,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });
    expect(status()).toBe("draft");

    // The deny persisted even though the transaction rolled back.
    const decision = lastEvent(db, "policy.decision");
    expect(decision).toMatchObject({
      actor: "u-outsider",
      decision: "deny",
      attributes: { action: "workflow.transition:submit" },
    });
    expect(eventsOf(db)).not.toContain("workflow.transition");
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("n-eyes: approval_recorded then final transition carry approvals/required; guard AND approval decisions audited", async () => {
    const { db, server, applicationId, url, status } = await workflowSetup();
    await server.app.inject({ method: "POST", url: url("submit"), headers: requester });
    await server.app.inject({ method: "POST", url: url("start-review"), headers: reviewer1 });

    const first = await server.app.inject({
      method: "POST",
      url: url("approve"),
      headers: reviewer1,
    });
    expect(first.json()).toEqual({ status: "pending", approvals: 1, required: 2 });

    const recorded = lastEvent(db, "workflow.approval_recorded");
    expect(recorded).toMatchObject({
      actor: "u-reviewer-1",
      subject: `vendor_application:${applicationId}`,
      decision: "allow",
      attributes: { transition: "approve", approvals: 1, required: 2 },
    });
    // Two decisions for an approval attempt: guard roles + approver roles.
    const approveActions = auditRecords(db)
      .filter((r) => r.event === "policy.decision" && r.actor === "u-reviewer-1")
      .map((r) => (r.attributes as Record<string, unknown>)["action"]);
    expect(approveActions).toContain("workflow.transition:approve");
    expect(approveActions).toContain("workflow.approve:approve");

    const final = await server.app.inject({
      method: "POST",
      url: url("approve"),
      headers: compliance,
    });
    expect(final.json()).toEqual({ status: "transitioned", state: "approved" });
    expect(status()).toBe("approved");

    expect(lastEvent(db, "workflow.transition")).toMatchObject({
      actor: "u-compliance",
      decision: "allow",
      attributes: {
        transition: "approve",
        from: "in_review",
        to: "approved",
        approvals: 2,
        required: 2,
      },
    });
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("workflow.duplicate_approver persists although the rejection rolled the transaction back", async () => {
    const { db, server, applicationId, url } = await workflowSetup();
    await server.app.inject({ method: "POST", url: url("submit"), headers: requester });
    await server.app.inject({ method: "POST", url: url("start-review"), headers: reviewer1 });
    await server.app.inject({ method: "POST", url: url("approve"), headers: reviewer1 });

    const again = await server.app.inject({
      method: "POST",
      url: url("approve"),
      headers: reviewer1,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "ERR_DUPLICATE_APPROVER" });

    // Rolled back: still exactly one approval row. Audited anyway:
    expect(db.rows("workflow_approvals")).toHaveLength(1);
    expect(lastEvent(db, "workflow.duplicate_approver")).toMatchObject({
      actor: "u-reviewer-1",
      subject: `vendor_application:${applicationId}`,
      decision: "deny",
      attributes: { workflow: "vendor-approval", transition: "approve" },
    });
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("ATOMIC: when the state update fails, no workflow.transition audit row exists (and vice-versa evidence below)", async () => {
    const { db, server, url, status } = await workflowSetup();
    await server.app.inject({ method: "POST", url: url("submit"), headers: requester });
    await server.app.inject({ method: "POST", url: url("start-review"), headers: reviewer1 });
    await server.app.inject({ method: "POST", url: url("approve"), headers: reviewer1 });

    db.failNextMatching(/^UPDATE "vendor_application" SET "status"/);
    const res = await server.app.inject({
      method: "POST",
      url: url("approve"),
      headers: compliance,
    });
    expect(res.statusCode).toBe(500);
    expect(status()).toBe("in_review");

    // The transaction rolled back: the approve transition was never audited
    // as done (submit/start-review earlier in the flow legitimately were).
    const approveTransitions = auditRecords(db).filter(
      (r) =>
        r.event === "workflow.transition" &&
        (r.attributes as Record<string, unknown>)["transition"] === "approve",
    );
    expect(approveTransitions).toHaveLength(0);
    // But compliance's (allowed) policy decisions still persisted.
    expect(lastEvent(db, "policy.decision")).toMatchObject({
      actor: "u-compliance",
      decision: "allow",
    });
  });

  it("FAIL-CLOSED + ATOMIC: when the IN-TRANSACTION workflow.transition append fails (guard decision already durably committed), the state change rolls back", async () => {
    const { db, server, url, status } = await workflowSetup();
    // The 1st `INSERT INTO audit_log` is the guard-role decision (now
    // appended before the transaction opens — let it succeed). The 2nd is
    // the in-transaction `workflow.transition` append, atomic with the state
    // write — target that one specifically.
    db.failNextMatching(/^INSERT INTO audit_log/, 2);
    const res = await server.app.inject({
      method: "POST",
      url: url("submit"),
      headers: requester,
    });
    // appendInTransaction (unlike appendOrFail) does not wrap its error —
    // it's meant to propagate straight up and roll back the transaction —
    // so this surfaces as the generic 500 handler (ERR_INTERNAL), same as
    // before this fix. What matters is atomicity, asserted below.
    expect(res.statusCode).toBe(500);
    // The side effect and its audit record are one transaction: no state
    // change, and no workflow.transition row (it rolled back with the
    // state write). The guard decision, appended on its own connection
    // before the transaction ever opened, is unaffected and persists.
    expect(status()).toBe("draft");
    expect(eventsOf(db)).not.toContain("workflow.transition");
    expect(lastEvent(db, "policy.decision")).toMatchObject({
      actor: "u-requester",
      decision: "allow",
      attributes: { action: "workflow.transition:submit" },
    });
  });

  it("FAIL-CLOSED: when the independent duplicate-approver rejection fails to append, the request fails with ERR_AUDIT_APPEND_FAILED", async () => {
    const { db, server, url } = await workflowSetup();
    await server.app.inject({ method: "POST", url: url("submit"), headers: requester });
    await server.app.inject({ method: "POST", url: url("start-review"), headers: reviewer1 });
    await server.app.inject({ method: "POST", url: url("approve"), headers: reviewer1 });

    // A duplicate "approve" attempt appends 2 decisions up front (guard role
    // + approval role, both succeed) before the transaction detects the
    // duplicate and queues workflow.duplicate_approver for the
    // post-transaction independent-events flush — target THAT append (the
    // 3rd `INSERT INTO audit_log` overall for this request).
    db.failNextMatching(/^INSERT INTO audit_log/, 3);
    const res = await server.app.inject({
      method: "POST",
      url: url("approve"),
      headers: reviewer1, // duplicate → rejection path
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "ERR_AUDIT_APPEND_FAILED" });
    const failure = server.logger.entries.find(
      (e) => e.fields["event"] === "audit.append_failed",
    );
    expect(failure?.level).toBe("error");
    expect(failure?.fields["auditEvent"]).toBe("workflow.duplicate_approver");
  });

  it("FLUSH DOESN'T DROP LATER EVENTS: appendAllOrFail attempts every queued event even after an earlier one fails (finding flush-drops-later-events)", async () => {
    const store: AuditStore = {
      append: async () => {
        throw new Error("should not be called directly in this test");
      },
      read: async () => [],
      verify: async () => ({ ok: true, count: 0 }),
    };
    const attempted: string[] = [];
    let calls = 0;
    const flakyStore: AuditStore = {
      ...store,
      append: async (input) => {
        calls++;
        attempted.push(input.event);
        if (calls === 1) throw new Error("first append fails");
        return {
          seq: calls,
          timestamp: "2026-07-06T00:00:00.000Z",
          prevHash: "0".repeat(64),
          hash: "f".repeat(64),
          ...input,
        };
      },
    };
    const logger = new CapturingLogger();
    await expect(
      appendAllOrFail(flakyStore, logger, [
        { event: "e1", actor: "u1", actorType: "system" },
        { event: "e2", actor: "u2", actorType: "system" },
        { event: "e3", actor: "u3", actorType: "system" },
      ]),
    ).rejects.toMatchObject({ code: "ERR_AUDIT_APPEND_FAILED" });

    // All three were attempted — the first's failure did not abandon e2/e3.
    expect(attempted).toEqual(["e1", "e2", "e3"]);
    // Each failure is logged individually with the full event preserved
    // (only e1 failed here, so exactly one audit.append_failed log line).
    const failures = logger.findAll("audit.append_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields["auditRecord"]).toMatchObject({ event: "e1" });
  });

  it("workflow.state_write_rejected is appended on an update that writes a state field", async () => {
    const { db, server, applicationId } = await workflowSetup();
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/vendor-application/${applicationId}`,
      headers: { ...requester, "content-type": "application/json" },
      payload: { status: "approved" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ERR_STATE_FIELD_READONLY" });

    expect(lastEvent(db, "workflow.state_write_rejected")).toMatchObject({
      actor: "u-requester",
      actorType: "human",
      subject: `vendor_application:${applicationId}`,
      decision: "deny",
      attributes: { entityTable: "vendor_application", mode: "update", field: "status" },
    });
    expect(verifyChain(auditRecords(db)).ok).toBe(true);
  });

  it("workflow.state_write_rejected is appended on a create that writes a state field", async () => {
    const { db, server } = await workflowSetup();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/vendor-application",
      headers: { ...requester, "content-type": "application/json" },
      payload: {
        vendor: "00000000-0000-4000-8000-000000000001",
        justification: "x",
        status: "approved",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(lastEvent(db, "workflow.state_write_rejected")).toMatchObject({
      actor: "u-requester",
      decision: "deny",
      attributes: { entityTable: "vendor_application", mode: "create", field: "status" },
    });
  });

  it("a full mixed flow produces one contiguous verifiable chain", async () => {
    const { db, server, url } = await workflowSetup();
    await server.app.inject({ method: "POST", url: url("submit"), headers: requester });
    await server.app.inject({ method: "POST", url: url("submit"), headers: outsider }); // 409 bad state — no decision needed
    await server.app.inject({ method: "POST", url: url("start-review"), headers: reviewer1 });
    await server.app.inject({ method: "POST", url: url("approve"), headers: requester }); // 403 deny
    await server.app.inject({ method: "POST", url: url("approve"), headers: reviewer1 });
    await server.app.inject({ method: "POST", url: url("approve"), headers: reviewer1 }); // 409 duplicate
    await server.app.inject({ method: "POST", url: url("approve"), headers: compliance });

    const records = auditRecords(db);
    const verify = verifyChain(records);
    expect(verify).toEqual({ ok: true, count: records.length });
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));

    const events = eventsOf(db);
    expect(events).toContain("workflow.transition");
    expect(events).toContain("workflow.approval_recorded");
    expect(events).toContain("workflow.duplicate_approver");
    expect(events.filter((e) => e === "policy.decision").length).toBeGreaterThan(3);
  });
});
