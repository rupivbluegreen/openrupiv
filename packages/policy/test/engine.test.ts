import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyInput } from "../src/index";

/** The engine loads the COMMITTED authz.wasm — this proves the bundle is real. */
const engine = await createPolicyEngine();

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    subject: { id: "u1", roles: ["reviewer"] },
    action: "workflow.transition:approve",
    resource: { type: "workflow.transition", allowedRoles: ["reviewer", "compliance"] },
    ...over,
  };
}

describe("createPolicyEngine (committed OPA WASM bundle)", () => {
  it("allows when the subject holds a required role", async () => {
    const d = await engine.decide(input());
    expect(d.allow).toBe(true);
    expect(d.policyId).toBe("openrupiv.authz");
    expect(d.reason).toMatch(/required role/);
  });

  it("denies when the subject holds none of the required roles", async () => {
    const d = await engine.decide(
      input({ subject: { id: "u1", roles: ["requester"] } }),
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/do not intersect/);
  });

  it("denies a subject with no roles at all", async () => {
    const d = await engine.decide(input({ subject: { id: "u1", roles: [] } }));
    expect(d.allow).toBe(false);
  });

  it("allows an authenticated subject when no roles are required", async () => {
    const d = await engine.decide(
      input({
        subject: { id: "u1", roles: [] },
        resource: { type: "workflow.transition", allowedRoles: [] },
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/no roles required/);
  });

  it("denies an anonymous subject (empty id) even with no roles required", async () => {
    const d = await engine.decide(
      input({
        subject: { id: "", roles: [] },
        resource: { type: "workflow.transition", allowedRoles: [] },
      }),
    );
    expect(d.allow).toBe(false);
  });

  it("is deny-by-default: multiple required roles, subject holds exactly one", async () => {
    const d = await engine.decide(
      input({
        subject: { id: "u1", roles: ["compliance"] },
        resource: { type: "workflow.transition", allowedRoles: ["reviewer", "compliance"] },
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("fails closed on a bundle that cannot be loaded", async () => {
    await expect(
      createPolicyEngine({ wasmPath: "/nonexistent/authz.wasm" }),
    ).rejects.toThrow();
  });
});
