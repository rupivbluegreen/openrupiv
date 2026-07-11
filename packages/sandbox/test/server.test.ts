import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import type { JailOutcome, RunJailInput } from "../src/jail-executor";
import type { CanaryResult } from "../src/canary";

const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const TOKEN = "a".repeat(40);
const WORKSPACE_ROOT = "/tmp/sandbox-test-workspaces";

/** A promise you can resolve/settle from outside -- used to hold a request
 * inside runJailFn until the test is ready to release it, and to know
 * precisely when runJailFn has actually been entered (no polling/sleeps). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const HEALTHY_CANARY: CanaryResult = { ok: true, assertions: [], at: new Date(0).toISOString() };
const UNHEALTHY_CANARY: CanaryResult = {
  ok: false,
  assertions: [{ name: "no_network_interface", ok: false, detail: "boom" }],
  at: new Date(0).toISOString(),
};

function baseDeps(overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
  const okOutcome: JailOutcome = { ok: true, output: { echoed: true }, durationMs: 5 };
  return {
    token: TOKEN,
    workspaceRoot: WORKSPACE_ROOT,
    pythonRoot: "/usr",
    toolRoot: path.join(__dirname, "fixtures", "tools"),
    seccompBpfPath: "/opt/sandbox/seccomp/tool.bpf",
    canaryResult: HEALTHY_CANARY,
    runJailFn: async (_input: RunJailInput) => okOutcome,
    ...overrides,
  };
}

beforeAll(async () => {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe("POST /v1/execute", () => {
  it("401s with no Authorization header", async () => {
    const app = await createServer(baseDeps());
    const res = await app.inject({ method: "POST", url: "/v1/execute", payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } } });
    expect(res.statusCode).toBe(401);
  });

  it("401s with a wrong bearer token", async () => {
    const app = await createServer(baseDeps());
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token" },
      payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s on a malformed runId, never constructing a jail", async () => {
    let called = false;
    const app = await createServer(
      baseDeps({ runJailFn: async () => { called = true; return { ok: true, output: null, durationMs: 1 }; } }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: "../../etc/passwd", tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it("400s on an unresolvable tool entrypoint", async () => {
    const app = await createServer(baseDeps());
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "../escape", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses every request when the boot canary failed (fail closed)", async () => {
    const app = await createServer(baseDeps({ canaryResult: UNHEALTHY_CANARY }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns a 200 SandboxExecuteResult-shaped body on success (given a real tool fixture on disk)", async () => {
    const app = await createServer(baseDeps());
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "echo", input: { hello: "world" }, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, output: { echoed: true }, durationMs: 5 });
  });
});

describe("GET /healthz", () => {
  it("200s when the canary passed", async () => {
    const app = await createServer(baseDeps({ canaryResult: HEALTHY_CANARY }));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("503s when the canary failed, with the failing assertion in the body", async () => {
    const app = await createServer(baseDeps({ canaryResult: UNHEALTHY_CANARY }));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it("requires no auth (health checks come from Compose, not a tool caller)", async () => {
    const app = await createServer(baseDeps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/execute concurrency cap (ADR-0007:361-364)", () => {
  // A distinct runId, not shared with any other test in this file: request A
  // creates a real workspace for it, so reusing the shared RUN_ID could race
  // against another test's own create/cleanup of that same directory.
  const CONCURRENCY_RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

  it("rejects a request at capacity with 503 ERR_SANDBOX_AT_CAPACITY without invoking the jail, then serves the held request once its slot frees", async () => {
    let jailCallCount = 0;
    const jailEntered = deferred<void>();
    const jailGate = deferred<JailOutcome>();

    const app = await createServer(
      baseDeps({
        concurrency: { maxConcurrent: 1, maxQueueDepth: 0 },
        runJailFn: async (_input: RunJailInput) => {
          jailCallCount += 1;
          jailEntered.resolve();
          return jailGate.promise;
        },
      }),
    );

    const payload = {
      runId: CONCURRENCY_RUN_ID,
      tool: "echo",
      input: {},
      limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 },
    };

    // Request A: acquires the only slot and blocks inside runJailFn.
    const requestA = app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    // Wait for real confirmation that A has actually entered runJailFn (and
    // therefore holds the slot) before firing B -- no sleeps, no polling.
    await jailEntered.promise;

    // Request B: fired while A still holds the only slot and the queue
    // depth is 0 -- must be rejected outright, never reach the jail.
    const resB = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    expect(resB.statusCode).toBe(503);
    expect(resB.json()).toEqual({ error: "ERR_SANDBOX_AT_CAPACITY" });
    expect(jailCallCount).toBe(1);

    // Release A's slot -- A should complete normally.
    jailGate.resolve({ ok: true, output: { echoed: true }, durationMs: 5 });
    const resA = await requestA;
    expect(resA.statusCode).toBe(200);
    expect(resA.json()).toEqual({ ok: true, output: { echoed: true }, durationMs: 5 });
    expect(jailCallCount).toBe(1);
  });
});
