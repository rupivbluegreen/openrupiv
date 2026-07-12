import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
  it("writes the request input to input.json in the workspace before the jail runs", async () => {
    let capturedInput: unknown;
    const app = await createServer(
      baseDeps({
        runJailFn: async (input: RunJailInput) => {
          // The tool reads ./input.json from its cwd (the RW-bound workspace);
          // reading it here proves the supervisor delivered the request input
          // BEFORE the jail was invoked.
          const raw = await readFile(path.join(input.workspaceHostPath, "input.json"), "utf8");
          capturedInput = JSON.parse(raw);
          return { ok: true, output: null, durationMs: 1 };
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      // Unique runId (this test creates a real workspace on disk — reusing the
      // shared RUN_ID would race/collide with the other tests, per the note by
      // the concurrency tests below).
      payload: { runId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", tool: "echo", input: { hello: "world", n: 42 }, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedInput).toEqual({ hello: "world", n: 42 });
  });

  it("returns typed ERR_SANDBOX_INPUT_WRITE (no path leak) when input delivery fails, and still cleans up + frees the slot", async () => {
    const runIdA = "8d5f1c2a-0b3e-4a6d-9c7f-1e2d3a4b5c6d";
    const runIdB = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const app = await createServer(
      baseDeps({
        // maxConcurrent:1 so a leaked slot would make the SECOND request hang —
        // both returning promptly proves release() ran on the failure path.
        concurrency: { maxConcurrent: 1, maxQueueDepth: 8 },
        writeToolInput: async () => {
          // An fs error whose raw message embeds the host path — exactly what
          // must NOT reach the client (a generic Fastify 500 would leak it).
          throw new Error(`EACCES: permission denied, open '${WORKSPACE_ROOT}/x/input.json'`);
        },
      }),
    );

    const send = (runId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/execute",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { runId, tool: "echo", input: { hello: "world" }, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
      });

    const res = await send(runIdA);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "ERR_SANDBOX_INPUT_WRITE" });
    // The host workspace path / filename / raw errno must not leak in the body.
    expect(res.body).not.toContain(WORKSPACE_ROOT);
    expect(res.body).not.toContain("input.json");
    expect(res.body).not.toContain("EACCES");

    // release() ran on the failure path: with maxConcurrent:1 a leaked slot
    // would make this second request block forever instead of returning.
    // (cleanupWorkspace also runs, in the post-send finally — already verified
    // by the PR #13 review; asserting the dir is gone here would race that
    // async cleanup, so we prove non-leakage via the slot instead.)
    const res2 = await send(runIdB);
    expect(res2.statusCode).toBe(500);
    expect(res2.json()).toEqual({ error: "ERR_SANDBOX_INPUT_WRITE" });
  });

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

describe("POST /v1/execute duplicate concurrent runId (adversarial-review fix)", () => {
  // A distinct runId, not shared with any other test in this file, since
  // this test's request A creates a real workspace and holds it open.
  const DUP_RUN_ID = "0d1a6b2e-9d0a-4d3a-8f0a-1a2b3c4d5e6f";

  it("rejects a second concurrent request with the same runId with 409, without deleting the first request's still-active workspace", async () => {
    let jailCallCount = 0;
    const jailEntered = deferred<void>();
    const jailGate = deferred<JailOutcome>();

    const app = await createServer(
      baseDeps({
        runJailFn: async (_input: RunJailInput) => {
          jailCallCount += 1;
          jailEntered.resolve();
          return jailGate.promise;
        },
      }),
    );

    const payload = {
      runId: DUP_RUN_ID,
      tool: "echo",
      input: {},
      limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 },
    };

    // Request A: creates the workspace, acquires the slot, blocks inside
    // runJailFn (so its workspace is still "active" on disk).
    const requestA = app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    // Wait for real confirmation that A has entered runJailFn -- by this
    // point A's createWorkspace has definitely already succeeded (it's
    // awaited before runJailFn is ever called).
    await jailEntered.promise;

    const workspaceDir = path.join(WORKSPACE_ROOT, DUP_RUN_ID);
    await expect(stat(workspaceDir)).resolves.toBeTruthy();

    // Request B: same runId, fired while A is still mid-flight. Its own
    // createWorkspace must EEXIST -- it must be rejected with 409, and it
    // must NEVER clean up (delete) the directory A is actively using.
    const resB = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    expect(resB.statusCode).toBe(409);
    expect(resB.json()).toEqual({ error: "ERR_SANDBOX_RUN_ID_IN_USE" });
    // B never reached the jail.
    expect(jailCallCount).toBe(1);

    // The crucial assertion: A's workspace must still exist on disk -- B's
    // rejected createWorkspace must not have triggered a cleanup of it.
    await expect(stat(workspaceDir)).resolves.toBeTruthy();

    // A still completes normally, unaffected by B's rejected attempt.
    jailGate.resolve({ ok: true, output: { echoed: true }, durationMs: 5 });
    const resA = await requestA;
    expect(resA.statusCode).toBe(200);
    expect(resA.json()).toEqual({ ok: true, output: { echoed: true }, durationMs: 5 });
    expect(jailCallCount).toBe(1);
  });
});

describe("POST /v1/execute limits validation (reject non-positive/non-finite)", () => {
  it("400s on a negative wallClockMs, never invoking the jail", async () => {
    let called = false;
    const app = await createServer(
      baseDeps({ runJailFn: async () => { called = true; return { ok: true, output: null, durationMs: 1 }; } }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: -1, memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "ERR_SANDBOX_BAD_LIMITS" });
    expect(called).toBe(false);
  });

  it("400s on a non-numeric (NaN-producing) wallClockMs, never invoking the jail", async () => {
    let called = false;
    const app = await createServer(
      baseDeps({ runJailFn: async () => { called = true; return { ok: true, output: null, durationMs: 1 }; } }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: "not-a-number", memoryBytes: 1, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "ERR_SANDBOX_BAD_LIMITS" });
    expect(called).toBe(false);
  });

  it("400s on a zero memoryBytes, never invoking the jail", async () => {
    let called = false;
    const app = await createServer(
      baseDeps({ runJailFn: async () => { called = true; return { ok: true, output: null, durationMs: 1 }; } }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 0, maxOutputBytes: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "ERR_SANDBOX_BAD_LIMITS" });
    expect(called).toBe(false);
  });
});

describe("POST /v1/execute default concurrency cap (ADR-0007 mandated default of 4)", () => {
  // Distinct runIds for all 5 requests -- Finding 1's fix means a duplicate
  // concurrent runId is now rejected outright, so this test (which needs 5
  // genuinely concurrent in-flight requests) must not collide with itself.
  const RUN_IDS = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];

  it("holds exactly 4 concurrent jails with the default cap (no concurrency override) and queues a 5th until a slot frees", async () => {
    let jailCallCount = 0;
    const gates = RUN_IDS.map(() => deferred<JailOutcome>());
    const entered = RUN_IDS.map(() => deferred<void>());

    const app = await createServer(
      // No `concurrency` override in deps -- this exercises ADR-0007's
      // mandated DEFAULT supervisor-level cap (maxConcurrent=4,
      // maxQueueDepth=8), not an overridden test value.
      baseDeps({
        runJailFn: async (_input: RunJailInput) => {
          const idx = jailCallCount;
          jailCallCount += 1;
          entered[idx]!.resolve();
          return gates[idx]!.promise;
        },
      }),
    );

    const fire = (runId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/execute",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { runId, tool: "echo", input: {}, limits: { wallClockMs: 1000, memoryBytes: 1, maxOutputBytes: 1 } },
      });

    // Fire 4 distinct-runId requests -- with the default cap of 4, all four
    // must reach the jail concurrently.
    const first4 = RUN_IDS.slice(0, 4).map(fire);
    await Promise.all(entered.slice(0, 4).map((d) => d.promise));
    expect(jailCallCount).toBe(4);

    // Fire a 5th, distinct-runId request. The default queue depth is 8, so
    // it must queue (not 503) -- but with all 4 slots already busy, it must
    // NOT reach the jail yet.
    let fifthSettled = false;
    const fifth = fire(RUN_IDS[4]!);
    fifth.then(() => {
      fifthSettled = true;
    });

    // Let the event loop fully drain. Nothing between firing the 5th
    // request and its `await semaphore.acquire()` involves a timer or real
    // I/O, so this proves it is genuinely still blocked there (queued),
    // not just "hasn't been scheduled yet".
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(jailCallCount).toBe(4);
    expect(fifthSettled).toBe(false);

    // Release one of the first 4 -- its slot must transfer FIFO to the
    // queued 5th request, which should now enter the jail.
    gates[0]!.resolve({ ok: true, output: { echoed: true }, durationMs: 5 });
    await entered[4]!.promise;
    expect(jailCallCount).toBe(5);

    // Drain the rest so nothing is left hanging.
    for (let i = 1; i < 5; i++) {
      gates[i]!.resolve({ ok: true, output: { echoed: true }, durationMs: 5 });
    }
    const results = await Promise.all([...first4, fifth]);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }
  });
});
