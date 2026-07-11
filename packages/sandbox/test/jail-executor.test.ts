import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runJail } from "../src/jail-executor";

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

  it("classifies a nonzero exit with EROFS/ENOENT-shaped stderr as fs_escape", async () => {
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
