/**
 * Workflow enforcement tests against fixtures.vendorOnboardingSpec with an
 * injected fake pg Pool (FakeDb) — the n-eyes distinct-approver rule is the
 * crown jewel of Phase 1 (acceptance criterion #2).
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { FakeDb } from "./helpers/fakeDb";
import {
  buildTestServer,
  sessionCookieFor,
  type TestServer,
} from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;

const requester = { cookie: sessionCookieFor({ sub: "u-requester", roles: ["requester"] }) };
const reviewer1 = { cookie: sessionCookieFor({ sub: "u-reviewer-1", roles: ["reviewer"] }) };
const reviewer2 = { cookie: sessionCookieFor({ sub: "u-reviewer-2", roles: ["reviewer"] }) };
const compliance = { cookie: sessionCookieFor({ sub: "u-compliance", roles: ["compliance"] }) };
const outsider = { cookie: sessionCookieFor({ sub: "u-outsider", roles: [] }) };

describe("workflow transitions (vendor onboarding)", () => {
  let db: FakeDb;
  let server: TestServer;
  let applicationId: string;

  function transitionUrl(name: string, id: string = applicationId): string {
    return `/api/vendor-application/${id}/transitions/${name}`;
  }

  function seedApplication(status: string): string {
    const row = db.seedRow("vendor_application", {
      vendor_id: randomUUID(),
      justification: "we need this vendor",
      annual_spend: 10_000,
      status,
    });
    return String(row["id"]);
  }

  function currentStatus(): unknown {
    const row = db.rows("vendor_application")[0] as Record<string, unknown>;
    return row["status"];
  }

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(spec, db);
    applicationId = seedApplication("draft");
  });

  describe("plain guarded transitions", () => {
    it("transitions draft→submitted for a requester", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit"),
        headers: requester,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "transitioned", state: "submitted" });
      expect(currentStatus()).toBe("submitted");
    });

    it("403s ERR_FORBIDDEN_ROLE for a user without the guard role", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit"),
        headers: outsider,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });
      expect(currentStatus()).toBe("draft");
    });

    it("409s ERR_BAD_STATE when the record is not in the from state", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("submit"), headers: requester });
      const again = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit"),
        headers: requester,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "ERR_BAD_STATE" });
    });

    it("checks state BEFORE roles (enforcement order)", async () => {
      // outsider + wrong state: must surface ERR_BAD_STATE, not the role error
      const id = seedApplication("approved");
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit", id),
        headers: outsider,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "ERR_BAD_STATE" });
    });

    it("401s without a session", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit"),
      });
      expect(res.statusCode).toBe(401);
    });

    it("404s for an unknown record", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("submit", randomUUID()),
        headers: requester,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ERR_NOT_FOUND" });
    });

    it("404s for a transition name not in the workflow", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("teleport"),
        headers: requester,
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s for a malformed record id", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/vendor-application/not-a-uuid/transitions/submit",
        headers: requester,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("n-eyes approval (approve requires 2 distinct approvers)", () => {
    beforeEach(async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("submit"), headers: requester });
      await server.app.inject({ method: "POST", url: transitionUrl("start-review"), headers: reviewer1 });
      expect(currentStatus()).toBe("in_review");
    });

    it("first approval is recorded and reported pending; state unchanged", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: reviewer1,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "pending", approvals: 1, required: 2 });
      expect(currentStatus()).toBe("in_review");

      const approvals = db.rows("workflow_approvals");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        entity_table: "vendor_application",
        record_id: applicationId,
        transition: "approve",
        approver_sub: "u-reviewer-1",
      });
    });

    it("REJECTS a second approval by the same user: 409 ERR_DUPLICATE_APPROVER + warn log", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });
      const again = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: reviewer1,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "ERR_DUPLICATE_APPROVER" });

      // no state change, no extra approval row
      expect(currentStatus()).toBe("in_review");
      expect(db.rows("workflow_approvals")).toHaveLength(1);

      // structured warn log with full context
      const warn = server.logger.find("workflow.duplicate_approver");
      expect(warn?.level).toBe("warn");
      expect(warn?.fields).toMatchObject({
        entityTable: "vendor_application",
        recordId: applicationId,
        transition: "approve",
        approverSub: "u-reviewer-1",
      });
    });

    it("a second DISTINCT approver reaches the count and flips the state", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: compliance,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "transitioned", state: "approved" });
      expect(currentStatus()).toBe("approved");
      // Completing the transition ends the round: pending approvals are
      // cleared so a future re-entry starts fresh (revision-loop safety).
      expect(db.rows("workflow_approvals")).toHaveLength(0);
    });

    it("two distinct reviewers also satisfy the rule (same role, different sub)", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: reviewer2,
      });
      expect(res.json()).toEqual({ status: "transitioned", state: "approved" });
    });

    it("403s an approver without an approval role (requester)", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: requester,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });
      expect(db.rows("workflow_approvals")).toHaveLength(0);
    });

    it("approvals are scoped per transition: reject is independent of approve", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });
      // reviewer1 already approved "approve", but can still fire "reject"
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("reject"),
        headers: reviewer1,
      });
      expect(res.json()).toEqual({ status: "transitioned", state: "rejected" });
    });

    it("SECURITY: stale approvals from a prior round do not carry into a new approval round", async () => {
      // Round 1: reviewer1 approves (pending 1/2).
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });
      expect(db.rows("workflow_approvals")).toHaveLength(1);

      // The record leaves in_review (reject → rejected): the state change
      // must clear the pending approval.
      await server.app.inject({ method: "POST", url: transitionUrl("reject"), headers: reviewer1 });
      expect(db.rows("workflow_approvals")).toHaveLength(0);

      // Simulate a revision loop returning the record to the approval's
      // `from` state (a real spec may allow re-entry via a revise path).
      const row = db.rows("vendor_application")[0] as Record<string, unknown>;
      db.table("vendor_application").get(String(row["id"]))!["status"] = "in_review";

      // Round 2: a DIFFERENT single approver must NOT complete the 4-eyes
      // rule on the strength of round 1's stale approval — the bug would let
      // compliance alone flip the state to approved.
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: compliance,
      });
      expect(res.json()).toEqual({ status: "pending", approvals: 1, required: 2 });
      expect(currentStatus()).toBe("in_review");
    });

    it("final approval and state flip are ATOMIC: a failing state update rolls back the approval", async () => {
      await server.app.inject({ method: "POST", url: transitionUrl("approve"), headers: reviewer1 });

      db.failNextMatching(/^UPDATE "vendor_application" SET "status"/);
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: compliance,
      });
      expect(res.statusCode).toBe(500);

      // The whole transaction rolled back: compliance's approval was NOT
      // recorded and the state did not change.
      expect(db.rows("workflow_approvals")).toHaveLength(1);
      expect(currentStatus()).toBe("in_review");
    });

    it("form-encoded approvals redirect back to the detail page", async () => {
      const res = await server.app.inject({
        method: "POST",
        url: transitionUrl("approve"),
        headers: {
          ...reviewer1,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "",
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `/p/application-detail?id=${applicationId}`,
      );
    });
  });
});

describe("guard predicates (project tracker)", () => {
  const lead = { cookie: sessionCookieFor({ sub: "u-lead", roles: ["lead"] }) };
  const member = { cookie: sessionCookieFor({ sub: "u-member", roles: ["member"] }) };
  let db: FakeDb;
  let server: TestServer;

  beforeEach(async () => {
    db = new FakeDb();
    server = await buildTestServer(fixtures.projectTrackerSpec, db);
  });

  function seedProject(fields: Record<string, unknown>): string {
    const row = db.seedRow("project", { name: `p-${randomUUID()}`, ...fields });
    return String(row["id"]);
  }

  it("checks roles BEFORE predicates (enforcement order)", async () => {
    // member + failing predicate: must surface the role error, not the guard
    const id = seedProject({ phase: "planned", budget: 0 });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/project/${id}/transitions/kick-off`,
      headers: member,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ERR_FORBIDDEN_ROLE" });
  });

  it("409s ERR_GUARD_FAILED when a comparison predicate fails", async () => {
    const id = seedProject({ phase: "planned", budget: 0 });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/project/${id}/transitions/kick-off`,
      headers: lead,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "ERR_GUARD_FAILED" });
  });

  it("fails comparison predicates on NULL values (no silent pass)", async () => {
    const id = seedProject({ phase: "planned", budget: null });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/project/${id}/transitions/kick-off`,
      headers: lead,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "ERR_GUARD_FAILED" });
  });

  it("passes when the predicate holds", async () => {
    const id = seedProject({ phase: "planned", budget: 50_000 });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/project/${id}/transitions/kick-off`,
      headers: lead,
    });
    expect(res.json()).toEqual({ status: "transitioned", state: "active" });
  });

  it("supports set/notSet predicates (complete requires dueDate set)", async () => {
    const withoutDate = seedProject({ phase: "active", budget: 1 });
    const blocked = await server.app.inject({
      method: "POST",
      url: `/api/project/${withoutDate}/transitions/complete`,
      headers: member,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "ERR_GUARD_FAILED" });

    const withDate = seedProject({ phase: "active", budget: 1, due_date: "2026-12-01" });
    const ok = await server.app.inject({
      method: "POST",
      url: `/api/project/${withDate}/transitions/complete`,
      headers: member,
    });
    expect(ok.json()).toEqual({ status: "transitioned", state: "done" });
  });
});
