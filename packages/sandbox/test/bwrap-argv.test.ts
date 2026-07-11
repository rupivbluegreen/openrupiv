import { describe, expect, it } from "vitest";
import { buildBwrapArgv } from "../src/bwrap-argv";

describe("buildBwrapArgv", () => {
  const opts = {
    workspaceHostPath: "/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6",
    pythonRoot: "/usr",
    toolRoot: "/opt/sandbox-tools",
    seccompFd: 3,
    entrypointPath: "/opt/sandbox-tools/echo/main.py",
  };

  it("matches the golden argv exactly (ADR-0007 'Per-call jail construction')", () => {
    expect(buildBwrapArgv(opts)).toEqual([
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "HOME", "/tmp",
      "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/opt/sandbox-tools", "/opt/sandbox-tools",
      "--bind", "/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6", "/workspace",
      "--chdir", "/workspace",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--seccomp", "3",
      "--",
      "/usr/bin/python3",
      "/opt/sandbox-tools/echo/main.py",
    ]);
  });

  it("never contains an unexpanded template or shell metacharacter", () => {
    const argv = buildBwrapArgv(opts);
    for (const arg of argv) {
      expect(arg).not.toMatch(/[;&|`$()<>]/);
    }
  });

  it("is a pure function of its inputs (no timestamps, no env reads)", () => {
    expect(buildBwrapArgv(opts)).toEqual(buildBwrapArgv({ ...opts }));
  });

  it("changing seccompFd only changes the --seccomp argument", () => {
    const a = buildBwrapArgv(opts);
    const b = buildBwrapArgv({ ...opts, seccompFd: 7 });
    const diffIndex = a.findIndex((v, i) => v !== b[i]);
    expect(a[diffIndex - 1]).toBe("--seccomp");
    expect(b[diffIndex]).toBe("7");
  });
});
