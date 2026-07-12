import { describe, expect, it, vi } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { buildAgentDeps } from "../src/server";
import { FakeDb } from "./helpers/fakeDb";
import { testConfig } from "./helpers/testServer";

/**
 * Directly exercises the `serveAppDir` agent gate (extracted as `buildAgentDeps`
 * so it is testable without a live pg pool / OPA / sidecar). This is the "now
 * wired into the runtime" logic the docs cite — an inverted condition, a
 * one-var check, or swapped `baseUrl`/`token` would otherwise ship green.
 */
describe("buildAgentDeps — the serveAppDir sandbox gate", () => {
  const spec = fixtures.vendorOnboardingWithAgentSpec;
  const db = new FakeDb() as never;
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;

  it("returns {} (agents off) when the sandbox is not configured", async () => {
    expect(await buildAgentDeps(spec, testConfig(), db, logger)).toEqual({});
  });

  it("returns {} for a half-set pair (URL or token alone), never partially enabling agents", async () => {
    expect(await buildAgentDeps(spec, testConfig({ sandboxUrl: "http://sandbox:8443" }), db, logger)).toEqual({});
    expect(await buildAgentDeps(spec, testConfig({ sandboxToken: "t".repeat(40) }), db, logger)).toEqual({});
  });

  it("builds the sandbox client with the configured url+token (not swapped) and shares one audit+policy when both are set", async () => {
    const fakeSandbox = { execute: async () => ({ ok: true, output: null, durationMs: 1 }) };
    const fakeAudit = { append: async () => ({}) };
    const fakePolicy = { decide: async () => ({ allow: true, reason: "t", policyId: "t" }) };
    const fakeRuntime = { contextFor: () => ({}), listProposals: async () => [] };
    const createSidecarSandbox = vi.fn(() => fakeSandbox);
    const createAgentRuntime = vi.fn(() => fakeRuntime);
    const createPolicyEngine = vi.fn(async () => fakePolicy);
    const createDbAuditStore = vi.fn(() => fakeAudit);

    const deps = await buildAgentDeps(
      spec,
      testConfig({ sandboxUrl: "http://sandbox:8443", sandboxToken: "s".repeat(40) }),
      db,
      logger,
      { createSidecarSandbox, createAgentRuntime, createPolicyEngine, createDbAuditStore } as never,
    );

    // Guards against swapped args: the client is built from the exact configured URL + token.
    expect(createSidecarSandbox).toHaveBeenCalledWith({ baseUrl: "http://sandbox:8443", token: "s".repeat(40) });
    // Exactly one audit/policy, returned so serveAppDir injects them into BOTH
    // the AgentRuntime and createServer (no split-brain).
    expect(deps.auditStore).toBe(fakeAudit);
    expect(deps.policyEngine).toBe(fakePolicy);
    expect(deps.agents?.runtime).toBe(fakeRuntime);
    expect(deps.agents?.procedures).toBeDefined();
    // The AgentRuntime got the same sandbox/audit/policy instances (not fresh ones).
    expect(createAgentRuntime).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ sandbox: fakeSandbox, audit: fakeAudit, policy: fakePolicy, db }),
    );
  });
});
