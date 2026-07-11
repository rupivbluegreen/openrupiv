import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runJail } from "../src/jail-executor";

// Fix B (fd-leak) observability seam: node:fs's ESM named exports are
// non-configurable, so vi.spyOn(fs, "closeSync") cannot redefine them
// in-place. Instead, fully replace the module with a thin wrapper that
// still calls through to the real openSync/closeSync (so file-descriptor
// behavior for every other test in this file is completely unchanged) but
// also records every call, so the fd-close test below can make a real
// assertion instead of relying on code inspection alone.
const fsSpy = vi.hoisted(() => ({
  openSyncCalls: [] as number[],
  closeSyncCalls: [] as number[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fsSpy.openSyncCalls.push(fd);
      return fd;
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      fsSpy.closeSyncCalls.push(args[0] as number);
      return actual.closeSync(...args);
    },
  };
});

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter() as unknown as {
    on(event: "data", cb: (chunk: Buffer) => void): void;
    emit(event: "data", chunk: Buffer): boolean;
  };
  stderr = new EventEmitter() as unknown as {
    on(event: "data", cb: (chunk: Buffer) => void): void;
    emit(event: "data", chunk: Buffer): boolean;
  };
  killed = false;
  kill(_signal: NodeJS.Signals) {
    this.killed = true;
    return true;
  }
}

function baseInput() {
  return {
    entrypointPath: "/opt/sandbox-tools/echo/main.py",
    workspaceHostPath: "/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6",
    pythonRoot: "/usr",
    toolRoot: "/opt/sandbox-tools",
    seccompBpfPath: path.join(__dirname, "..", "seccomp", "tool.bpf"),
    limits: { wallClockMs: 30_000, memoryBytes: 268_435_456, maxOutputBytes: 1_048_576 },
  };
}

describe("runJail", () => {
  it("returns ok:true with parsed stdout on a clean exit 0", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stdout.emit("data", Buffer.from('{"result":"hello"}'));
    child.emit("exit", 0, null);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, output: { result: "hello" }, durationMs: expect.any(Number) });
  });

  it("classifies SIGSYS as a network_egress violation", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.emit("exit", null, "SIGSYS");
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "violation", violation: "network_egress" });
  });

  // Real jails never surface signal==="SIGSYS": bwrap (the tracked process)
  // reports a signal-killed inner process as exit code 128+signum. A SIGSYS
  // (31) kill therefore arrives as code 159 / signal null, and must classify
  // identically to a raw SIGSYS — otherwise every real seccomp kill is
  // misreported as a generic tool_error (observed on the ADR-0007 e2e proof).
  it("classifies exit code 159 (128+SIGSYS) as a network_egress violation", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.emit("exit", 159, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "violation", violation: "network_egress" });
  });

  it("classifies a nonzero exit with EROFS-shaped stderr as fs_escape", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stderr.emit("data", Buffer.from("PermissionError: [Errno 30] Read-only file system"));
    child.emit("exit", 1, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "violation", violation: "fs_escape" });
  });

  it("classifies a generic nonzero exit as tool_error", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stderr.emit("data", Buffer.from("ValueError: bad input"));
    child.emit("exit", 1, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "tool_error" });
  });

  // Fix D: a benign ENOENT in the tool's OWN workspace (e.g. reading a
  // missing input file) must NOT be misclassified as a security fs_escape
  // violation. Only the EROFS / read-only-filesystem signal (what bwrap's
  // RO binds actually produce) should trigger fs_escape.
  it("classifies a benign FileNotFoundError ([Errno 2]) nonzero exit as tool_error, not fs_escape", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stderr.emit(
      "data",
      Buffer.from("FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'"),
    );
    child.emit("exit", 1, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "tool_error" });
  });

  it("still classifies an [Errno 30] read-only-filesystem nonzero exit as fs_escape", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stderr.emit("data", Buffer.from("OSError: [Errno 30] Read-only file system"));
    child.emit("exit", 1, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "violation", violation: "fs_escape" });
  });

  // Fix A: a kernel-enforced SIGSYS kill must win over a soft, parent-side
  // outputCapped classification — a real security violation must never be
  // masked as a benign output-size limit.
  it("classifies SIGSYS as violation/network_egress even when outputCapped is also true", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(
      { ...baseInput(), limits: { ...baseInput().limits, maxOutputBytes: 10 } },
      { spawn },
    );
    child.stdout.emit("data", Buffer.from("this-output-is-definitely-longer-than-ten-bytes"));
    child.emit("exit", null, "SIGSYS");
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "violation", violation: "network_egress" });
  });

  // Fix E: RLIMIT_AS exhaustion is kernel-enforced (prlimit --as) but
  // CPython surfaces it as a plain MemoryError on stderr; this is the
  // best-effort label for that case.
  it("classifies a nonzero exit with a MemoryError on stderr as limit/memory", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.stderr.emit(
      "data",
      Buffer.from("Traceback (most recent call last):\nMemoryError"),
    );
    child.emit("exit", 1, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "limit", limit: "memory" });
  });

  // Fix C: if spawnFn's child fails to actually start (e.g. `prlimit` is
  // missing -> ENOENT), Node emits "error" instead of "exit", and without a
  // handler the returned Promise would hang forever. Assert it settles.
  it("settles as tool_error (not hanging) when the child emits an error event", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.emit("error", new Error("spawn prlimit ENOENT"));
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "tool_error" });
    expect((outcome as { message: string }).message).toContain("spawn prlimit ENOENT");
  });

  it("clears the wall-clock timer when the child emits an error event instead of exit", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.emit("error", new Error("spawn prlimit ENOENT"));
    await promise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("never settles twice if both error and exit fire for the same child", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail(baseInput(), { spawn });
    child.emit("error", new Error("spawn prlimit ENOENT"));
    // A late "exit" after "error" (or vice versa, in principle) must be a
    // no-op: the settled guard must prevent a second resolve() call, which
    // would otherwise be silently ignored by the Promise but indicates a
    // logic bug if outcomes ever diverge.
    child.emit("exit", 0, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "tool_error" });
  });

  // Fix B: the seccomp BPF fd (opened via openSync) must be closed by the
  // supervisor once the child has inherited it via the stdio array, or it
  // leaks one fd per runJail call until RLIMIT_NOFILE is exhausted.
  it("closes its own copy of the seccomp BPF fd once the child has inherited it", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const priorOpenCount = fsSpy.openSyncCalls.length;
    const priorCloseCount = fsSpy.closeSyncCalls.length;

    const promise = runJail(baseInput(), { spawn });

    // openSync/closeSync both happen synchronously inside the Promise
    // executor, before spawnFn's return value is even used for stdio setup
    // completion, so both calls have already landed by the time runJail()
    // returns the pending promise.
    expect(fsSpy.openSyncCalls.length).toBe(priorOpenCount + 1);
    expect(fsSpy.closeSyncCalls.length).toBe(priorCloseCount + 1);
    const openedFd = fsSpy.openSyncCalls.at(-1);
    const closedFd = fsSpy.closeSyncCalls.at(-1);
    expect(closedFd).toBe(openedFd);

    child.emit("exit", 0, null);
    await promise;
  });

  it("SIGKILLs the process and returns a wall_clock limit result on timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail({ ...baseInput(), limits: { ...baseInput().limits, wallClockMs: 1_000 } }, { spawn });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killed).toBe(true);
    child.emit("exit", null, "SIGKILL");
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "limit", limit: "wall_clock" });
    vi.useRealTimers();
  });

  it("caps captured stdout at maxOutputBytes and reports an output_size limit", async () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const promise = runJail({ ...baseInput(), limits: { ...baseInput().limits, maxOutputBytes: 10 } }, { spawn });
    child.stdout.emit("data", Buffer.from("this-output-is-definitely-longer-than-ten-bytes"));
    child.emit("exit", 0, null);
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "limit", limit: "output_size" });
  });

  it("passes prlimit + bwrap as a single argv array to spawn, never a shell string", () => {
    const child = new FakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    void runJail(baseInput(), { spawn });
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = spawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("prlimit");
    expect(args).toContain("bwrap");
    expect(args.join(" ")).not.toMatch(/[;&|`$()<>]/);
    child.emit("exit", 0, null);
  });
});
