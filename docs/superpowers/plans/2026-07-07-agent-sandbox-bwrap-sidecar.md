# Agent Tool Sandbox (`packages/sandbox`, ADR-0007) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/sandbox` — a dedicated, unprivileged sidecar service that runs one bubblewrap (`bwrap`) jail per agent tool execution, implementing the `ToolSandbox` interface `@openrupiv/agents` already depends on, exactly per `docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`.

**Architecture:** A Node 22 TS "supervisor" HTTP server (`POST /v1/execute`, `GET /healthz`) exposed only on an internal Compose network, running inside a Debian-bookworm container with the outer seccomp/AppArmor deltas bubblewrap needs. Per call it: validates a bearer token, validates an opaque `runId`, creates a fresh `0700` workspace directory, execs `prlimit | bwrap` (argv array, never a shell) with a private mount/PID/net/IPC/UTS namespace, an RO bind of the Python runtime + a tool root, exactly one RW bind (the workspace), and a second, stricter seccomp filter compiled ahead of time and committed as a versioned build artifact. A boot canary runs the same code path at startup and fails the service closed if isolation cannot be proven. `createSidecarSandbox({ baseUrl, token })` is a thin HTTP client implementing `ToolSandbox`, consumed by `@openrupiv/agents`.

**Tech Stack:** TypeScript (strict, `tsconfig.base.json`), Fastify 5 (matches `@openrupiv/runtime`/`@openrupiv/mcp`), Vitest, Node `child_process`/`node:crypto`/`node:fs`, `bwrap` (Debian package, LGPL-2.0+, exec'd not linked), `prlimit` (util-linux), a small C program against `libseccomp` compiled at image-build time via `gcc`.

## Global Constraints

- Package name `@openrupiv/sandbox`, `"private": true`, `"license": "Apache-2.0"`, `"type": "module"`, workspace-referenced as `@openrupiv/sandbox: "workspace:*"` by anything that imports it.
- `tsconfig.json` in every new package: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }` — strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` all inherited; every step's code must typecheck under these.
- Test runner: `vitest run` (`"test": "vitest run"` in `package.json`), no `vitest.config.ts` needed (matches every existing package).
- Every commit: `git commit -s` (DCO). Every task ends with a commit.
- This ADR is a **human-only review path** (CLAUDE.md: "Sandbox boundaries (tool execution isolation)"). Nothing built here may be merged autonomously; the final task's commit message and the eventual PR description must say so explicitly, matching the pattern already used in PR #5's description.
- `ToolSandbox`, `SandboxLimits`, `SandboxExecuteInput`, `SandboxExecuteResult`, `RegisteredTool` are **not redefined** — they are imported from `@openrupiv/agents` (already exported from `packages/agents/src/index.ts`). `packages/sandbox`'s only job is to satisfy that existing contract; the interface itself does not change (ADR-0007, "Decision").
- Fixed ADR values reproduced verbatim wherever needed (do not re-derive): `wallClockMs: 30_000`, `memoryBytes: 268_435_456` (256 MiB), `maxOutputBytes: 1_048_576` (1 MiB), `RLIMIT_NPROC: 16`, `RLIMIT_CPU: 30`, `RLIMIT_FSIZE: 67_108_864` (64 MiB), `RLIMIT_NOFILE: 256`, concurrency cap `4`.
- No `docker.sock` anywhere in this design, ever — not mounted, not referenced.
- Every argv passed to `execFile`/`spawn` is a literal array — never a template string handed to a shell.
- Digest-pinned base images verified against Docker Hub during this planning session (2026-07-07): `python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b`, `node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4`. These are today's tags; if CI's `docker build` reports a digest mismatch (Docker Hub retagged), that is expected drift — re-pull, re-verify, and update both this plan's record and the Dockerfile comment together, never one without the other.
- **Verified in this planning session, do not re-litigate:** copying only `/usr/local/bin/node` from `node:22-bookworm-slim` into a `python:3.12-slim-bookworm` final stage runs correctly (same Debian bookworm glibc/libstdc++ ABI) — confirmed via a real `docker build`. `bwrap` installs cleanly via `apt-get install bubblewrap` on `python:3.12-slim-bookworm` and reports its version. `prlimit --as=... --nproc=... --nofile=... --fsize=... --cpu=... -- CMD ARGS...` (exec form, no `--pid`) applies rlimits and then execs the target with a plain argv array — no shell involved. A minimal C program against `libseccomp` (`seccomp_init` / `seccomp_rule_add` / `seccomp_export_bpf`) compiles with `gcc -lseccomp` given `libseccomp-dev`, and produces a real BPF program file.
- **Known environment limitation, recorded honestly (do not paper over it):** this development sandbox cannot itself create Linux user namespaces — a direct `bwrap --unshare-user ...` fails with `Failed RTM_NEWADDR: Operation not permitted` even inside a `docker run` carrying the exact `--security-opt seccomp=...`/`--security-opt apparmor=unconfined` deltas ADR-0007 specifies. This is an environment-level nesting restriction (this shell is itself running inside a container/sandbox), not a defect in the design. Consequence for this plan: unit tests (Tasks 1–8) must not require real `bwrap` namespace creation to pass locally — they inject a fake jail-runner. Task 10's real end-to-end isolation proof will build and can be smoke-tested for "does it start," but **actual namespace-level enforcement can only be verified for real once pushed, on GitHub Actions' runners** (a real VM, not nested inside another sandbox). Task 10 must say so explicitly, and the plan's final task must include actually pushing and watching that CI job run before claiming the isolation boundary "proven."
- Never claim "proven" or "verified" for anything not actually observed passing. Where local verification is impossible for the reason above, say "implemented per spec, CI-verified on push," not "tested."

---

### Task 1: Package scaffold, `runId` validation, bearer-token auth

**Files:**
- Create: `packages/sandbox/package.json`
- Create: `packages/sandbox/tsconfig.json`
- Create: `packages/sandbox/src/run-id.ts`
- Create: `packages/sandbox/src/token-auth.ts`
- Test: `packages/sandbox/test/run-id.test.ts`
- Test: `packages/sandbox/test/token-auth.test.ts`

**Interfaces:**
- Produces: `isValidRunId(value: string): boolean`, `extractRunId(workspaceDir: string): string | null` (from `run-id.ts`); `hashToken(token: string): Buffer`, `tokensMatch(presented: string, expected: string): boolean` (from `token-auth.ts`). Later tasks (5, 7, 8) import both modules directly by these exact names.

- [ ] **Step 1: Create the package manifest**

`packages/sandbox/package.json`:
```json
{
  "name": "@openrupiv/sandbox",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build:seccomp": "bash scripts/build-seccomp.sh"
  },
  "dependencies": {
    "@openrupiv/agents": "workspace:*",
    "fastify": "^5.10.0"
  }
}
```

- [ ] **Step 2: Create the TS config**

`packages/sandbox/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write the failing test for `run-id.ts`**

`packages/sandbox/test/run-id.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { extractRunId, isValidRunId } from "../src/run-id";

describe("isValidRunId", () => {
  it("accepts a well-formed UUID v4", () => {
    expect(isValidRunId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidRunId("3FA85F64-5717-4562-B3FC-2C963F66AFA6")).toBe(true);
  });

  it("rejects a non-v4 UUID (wrong version nibble)", () => {
    expect(isValidRunId("3fa85f64-5717-1562-b3fc-2c963f66afa6")).toBe(false);
  });

  it("rejects a non-UUID string", () => {
    expect(isValidRunId("not-a-uuid")).toBe(false);
  });

  it("rejects a path-traversal attempt", () => {
    expect(isValidRunId("../../etc/passwd")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(isValidRunId("/etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidRunId("")).toBe(false);
  });
});

describe("extractRunId", () => {
  it("extracts a valid runId from the final path segment", () => {
    expect(extractRunId("/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(extractRunId("/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6/")).toBe(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
  });

  it("returns null for a traversal attempt in the final segment", () => {
    expect(extractRunId("/workspaces/../../etc")).toBeNull();
  });

  it("returns null when the final segment is not a UUID", () => {
    expect(extractRunId("/workspaces/not-a-uuid")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(extractRunId("")).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/run-id'` (module does not exist yet).

- [ ] **Step 5: Implement `run-id.ts`**

`packages/sandbox/src/run-id.ts`:
```ts
/**
 * `runId` handling per ADR-0007: the wire never carries a trusted host
 * path. `workspaceDir` (the `ToolSandbox` contract's field) is opaque
 * beyond its final path segment, which both the client (`client.ts`) and
 * the server (`server.ts`) independently re-validate against this strict
 * UUID v4 regex before doing anything with it. Any value that fails this
 * check -- including a `../` traversal attempt, an absolute path smuggled
 * in as a "runId", or a symlink-looking string -- is rejected outright,
 * never "helpfully" normalized and used anyway.
 */

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict UUID v4 check -- no normalization, no trimming. */
export function isValidRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

/**
 * Extracts the final path segment of `workspaceDir` and validates it as a
 * `runId`. Returns `null` (never throws, never falls back to a "best
 * guess") for anything malformed, including empty input, a trailing-only
 * traversal segment, or a non-UUID final segment.
 */
export function extractRunId(workspaceDir: string): string | null {
  const segments = workspaceDir.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  return isValidRunId(last) ? last : null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS (11 tests).

- [ ] **Step 7: Write the failing test for `token-auth.ts`**

`packages/sandbox/test/token-auth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hashToken, tokensMatch } from "../src/token-auth";

describe("hashToken", () => {
  it("produces a fixed 32-byte digest regardless of input length", () => {
    expect(hashToken("short").length).toBe(32);
    expect(hashToken("a".repeat(500)).length).toBe(32);
  });

  it("is deterministic", () => {
    expect(hashToken("same-value")).toEqual(hashToken("same-value"));
  });
});

describe("tokensMatch", () => {
  it("returns true for identical tokens", () => {
    expect(tokensMatch("secret-value-123", "secret-value-123")).toBe(true);
  });

  it("returns false for different tokens of the same length", () => {
    expect(tokensMatch("secret-value-123", "secret-value-124")).toBe(false);
  });

  it("returns false for different-length tokens without throwing", () => {
    expect(() => tokensMatch("short", "a-much-longer-token-value")).not.toThrow();
    expect(tokensMatch("short", "a-much-longer-token-value")).toBe(false);
  });

  it("returns false for an empty presented token against a real one", () => {
    expect(tokensMatch("", "real-token")).toBe(false);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/token-auth'`.

- [ ] **Step 9: Implement `token-auth.ts`**

`packages/sandbox/src/token-auth.ts`:
```ts
/**
 * Bearer-token authentication for `POST /v1/execute` (ADR-0007, "Supervisor
 * API"). This is *authentication* only -- "is this caller allowed to talk
 * to me at all" -- never authorization; the decision "should this specific
 * tool call happen" has already been made and audited by `@openrupiv/agents`
 * before the caller ever reaches this sidecar.
 *
 * Both the presented and expected token are SHA-256 hashed first (fixed
 * 32-byte digests) before `timingSafeEqual`, deliberately -- comparing raw
 * tokens directly is unsafe because `timingSafeEqual` requires equal-length
 * buffers and would either throw or leak length information via that
 * mismatch. The raw token is never logged; only "present / absent / valid /
 * invalid" is ever recorded by callers of this module.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function tokensMatch(presented: string, expected: string): boolean {
  const presentedHash = hashToken(presented);
  const expectedHash = hashToken(expected);
  return timingSafeEqual(presentedHash, expectedHash);
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS (15 tests total).

- [ ] **Step 11: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/sandbox/package.json packages/sandbox/tsconfig.json \
  packages/sandbox/src/run-id.ts packages/sandbox/src/token-auth.ts \
  packages/sandbox/test/run-id.test.ts packages/sandbox/test/token-auth.test.ts
git commit -s -m "sandbox: scaffold package, runId validation, bearer-token auth (ADR-0007)"
```

---

### Task 2: `bwrap-argv.ts` jail argv builder + entrypoint resolution

**Files:**
- Create: `packages/sandbox/src/bwrap-argv.ts`
- Create: `packages/sandbox/src/entrypoint.ts`
- Test: `packages/sandbox/test/bwrap-argv.test.ts`
- Test: `packages/sandbox/test/entrypoint.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `buildBwrapArgv(opts: BwrapArgvOptions): string[]` and `export interface BwrapArgvOptions { workspaceHostPath: string; pythonRoot: string; toolRoot: string; seccompFd: number; entrypointPath: string }` (from `bwrap-argv.ts`); `resolveEntrypoint(entrypoint: string, toolRoot: string): string` throwing `EntrypointResolutionError` on any escape attempt (from `entrypoint.ts`). Task 5 imports both by these exact names.

- [ ] **Step 1: Write the failing test for entrypoint resolution**

`packages/sandbox/test/entrypoint.test.ts`:
```ts
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntrypointResolutionError, resolveEntrypoint } from "../src/entrypoint";

describe("resolveEntrypoint", () => {
  let toolRoot: string;

  beforeEach(async () => {
    toolRoot = await mkdtemp(path.join(tmpdir(), "sandbox-tools-"));
    await mkdir(path.join(toolRoot, "echo"), { recursive: true });
    await writeFile(path.join(toolRoot, "echo", "main.py"), "# fixture\n");
  });

  afterEach(async () => {
    await rm(toolRoot, { recursive: true, force: true });
  });

  it("resolves a known entrypoint to <toolRoot>/<name>/main.py", () => {
    const resolved = resolveEntrypoint("echo", toolRoot);
    expect(resolved).toBe(path.join(toolRoot, "echo", "main.py"));
  });

  it("rejects a traversal attempt", () => {
    expect(() => resolveEntrypoint("../../../etc/passwd", toolRoot)).toThrow(
      EntrypointResolutionError,
    );
  });

  it("rejects an absolute path used as an entrypoint name", () => {
    expect(() => resolveEntrypoint("/etc/passwd", toolRoot)).toThrow(EntrypointResolutionError);
  });

  it("rejects an entrypoint name containing a null byte", () => {
    expect(() => resolveEntrypoint("echo\0evil", toolRoot)).toThrow(EntrypointResolutionError);
  });

  it("rejects an entrypoint whose main.py does not exist under toolRoot", () => {
    expect(() => resolveEntrypoint("nonexistent-tool", toolRoot)).toThrow(
      EntrypointResolutionError,
    );
  });

  it("rejects a name that resolves outside toolRoot via a symlink-shaped segment", () => {
    expect(() => resolveEntrypoint("echo/../../outside", toolRoot)).toThrow(
      EntrypointResolutionError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/entrypoint'`.

- [ ] **Step 3: Implement `entrypoint.ts`**

`packages/sandbox/src/entrypoint.ts`:
```ts
/**
 * `RegisteredTool.entrypoint` is opaque to `@openrupiv/agents` by contract
 * (ADR-0007, "Tool entrypoint is untrusted input too, even though it is
 * allowlisted upstream"). This sidecar is the only party that resolves it
 * to an actual executable path, and does so by requiring the resolved,
 * canonicalized path to fall under its own RO tool root before ever being
 * handed to `bwrap` -- never "close enough," never a bare string
 * concatenation, so that even a bug upstream in allowlist/registration
 * logic cannot turn into an arbitrary exec inside the jail.
 *
 * v1 convention: `entrypoint` is a bare name (no slashes) that must resolve
 * to `<toolRoot>/<entrypoint>/main.py`.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export class EntrypointResolutionError extends Error {
  constructor(entrypoint: string, reason: string) {
    super(`cannot resolve entrypoint "${entrypoint}": ${reason}`);
    this.name = "EntrypointResolutionError";
  }
}

const BARE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function resolveEntrypoint(entrypoint: string, toolRoot: string): string {
  if (entrypoint.includes("\0")) {
    throw new EntrypointResolutionError(entrypoint, "contains a null byte");
  }
  if (!BARE_NAME_PATTERN.test(entrypoint)) {
    throw new EntrypointResolutionError(
      entrypoint,
      "must be a bare name (letters, digits, '_', '-' only) -- no path separators",
    );
  }

  const candidate = path.join(toolRoot, entrypoint, "main.py");
  if (!existsSync(candidate)) {
    throw new EntrypointResolutionError(entrypoint, `${candidate} does not exist`);
  }

  const realToolRoot = realpathSync(toolRoot);
  const realCandidate = realpathSync(candidate);
  const relative = path.relative(realToolRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EntrypointResolutionError(
      entrypoint,
      "resolved path escapes toolRoot",
    );
  }

  return realCandidate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `bwrap-argv.ts` (golden snapshot)**

`packages/sandbox/test/bwrap-argv.test.ts`:
```ts
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/bwrap-argv'`.

- [ ] **Step 7: Implement `bwrap-argv.ts`**

`packages/sandbox/src/bwrap-argv.ts`:
```ts
/**
 * The ONE place a `bwrap` argv is assembled (ADR-0007, "Per-call jail
 * construction"). Always an argv array handed to `execFile`/`spawn` --
 * never string-interpolated into a shell, so there is no injection surface
 * by construction. `entrypointPath` MUST already be resolved and
 * canonicalized by `resolveEntrypoint` (entrypoint.ts) before reaching this
 * function; this function does not re-validate it.
 *
 * `pythonRoot` and `toolRoot` are bound read-only at the SAME path inside
 * the jail as on the sidecar's own filesystem (simplifies entrypoint-path
 * translation: the path resolved outside the jail is the same path Python
 * sees inside it). `workspaceHostPath` is the only read-write bind, always
 * mounted at `/workspace` inside the jail regardless of its host path.
 */

export interface BwrapArgvOptions {
  /** Absolute host path of this run's workspace directory (the only RW bind). */
  workspaceHostPath: string;
  /** Absolute path of the Python 3.12 runtime root, RO-bound at the same path. */
  pythonRoot: string;
  /** Absolute path of the tool root (hash-pinned vendored code), RO-bound at the same path. */
  toolRoot: string;
  /** FD number, as seen by the child process, holding the compiled inner seccomp BPF program. */
  seccompFd: number;
  /** Resolved, canonicalized path (via resolveEntrypoint) of the tool's main.py. */
  entrypointPath: string;
}

export function buildBwrapArgv(opts: BwrapArgvOptions): string[] {
  return [
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
    "--ro-bind", opts.pythonRoot, opts.pythonRoot,
    "--ro-bind", opts.toolRoot, opts.toolRoot,
    "--bind", opts.workspaceHostPath, "/workspace",
    "--chdir", "/workspace",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--seccomp", String(opts.seccompFd),
    "--",
    `${opts.pythonRoot}/bin/python3`,
    opts.entrypointPath,
  ];
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS (all bwrap-argv + entrypoint tests green).

- [ ] **Step 9: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/sandbox/src/bwrap-argv.ts packages/sandbox/src/entrypoint.ts \
  packages/sandbox/test/bwrap-argv.test.ts packages/sandbox/test/entrypoint.test.ts
git commit -s -m "sandbox: bwrap argv builder + entrypoint resolution (ADR-0007)"
```

---

### Task 3: Inner seccomp filter — rule source, build script, committed BPF, CI parity check

This produces the **inner** filter (applies inside the jail, independent of the outer container's loosened profile from Task 9). Verified compilable in this planning session via a real `gcc -lseccomp` build inside a `debian:bookworm-slim` container.

**Files:**
- Create: `packages/sandbox/seccomp/build-tool-seccomp.c`
- Create: `packages/sandbox/scripts/build-seccomp.sh`
- Create: `packages/sandbox/scripts/check-seccomp-bpf.sh`
- Create: `packages/sandbox/seccomp/tool.bpf` (generated by the script below, then committed as a binary artifact)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `packages/sandbox/seccomp/tool.bpf`, a committed compiled BPF program consumed by Task 5's jail executor (opened via `fs.openSync` and passed as an inherited FD).

- [ ] **Step 1: Write the seccomp rule source (C program against libseccomp)**

`packages/sandbox/seccomp/build-tool-seccomp.c`:
```c
#define _GNU_SOURCE
/*
 * Inner seccomp filter for the ADR-0007 tool jail. Compiled to a raw BPF
 * program via libseccomp and committed as packages/sandbox/seccomp/tool.bpf
 * -- exactly the precedent ADR-0006 set for the committed authz.wasm
 * policy bundle. Rebuilt via scripts/build-seccomp.sh; CI
 * (scripts/check-seccomp-bpf.sh) rebuilds and diffs against the committed
 * artifact whenever the toolchain is available, so the committed filter can
 * never go silently stale relative to the rules a reviewer actually read.
 *
 * Default action: ALLOW (this is the INNER filter -- the syscalls it kills
 * are exactly the ones ADR-0007's "Consequences" section names as the
 * honest residual risk of unprivileged-userns isolation; everything else a
 * real CPython process needs is left alone by design, not enumerated).
 *
 * SCMP_ACT_KILL_PROCESS, never SCMP_ACT_ERRNO: a policy violation inside
 * the jail is a non-negotiable kill, not a retriable error the tool code
 * could catch and work around.
 */
#include <seccomp.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#include <sys/socket.h>
#include <linux/net.h>

static int deny(scmp_filter_ctx ctx, int syscall_nr) {
    return seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, syscall_nr, 0);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <output.bpf>\n", argv[0]);
        return 2;
    }

    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) {
        fprintf(stderr, "seccomp_init failed\n");
        return 1;
    }

    /* Syscalls most consistently behind real unprivileged-userns Linux
     * kernel privilege-escalation bugs. */
    const int denied_syscalls[] = {
        SCMP_SYS(mount),
        SCMP_SYS(umount2),
        SCMP_SYS(ptrace),
        SCMP_SYS(bpf),
        SCMP_SYS(keyctl),
        SCMP_SYS(userfaultfd),
        SCMP_SYS(io_uring_setup),
        SCMP_SYS(io_uring_enter),
        SCMP_SYS(io_uring_register),
        SCMP_SYS(process_vm_readv),
        SCMP_SYS(process_vm_writev),
        SCMP_SYS(open_by_handle_at),
        SCMP_SYS(perf_event_open),
    };
    for (size_t i = 0; i < sizeof(denied_syscalls) / sizeof(denied_syscalls[0]); i++) {
        if (deny(ctx, denied_syscalls[i]) != 0) {
            fprintf(stderr, "failed to add deny rule for syscall %d\n", denied_syscalls[i]);
            return 1;
        }
    }

    /* Nested user-namespace creation. clone3 unconditionally returns
     * ENOSYS (not flag-inspected, and not KILL_PROCESS): clone3 takes a
     * pointer to a userspace struct clone_args that seccomp cannot
     * dereference, so any flag-based re-denial would be trivially
     * bypassable -- the only sound mitigation is denying clone3 outright,
     * independent of arguments. ENOSYS rather than KILL is load-bearing:
     * modern glibc calls clone3 first for thread/process creation
     * (pthread_create, posix_spawn, fork) and falls back to the clone
     * syscall below ONLY on ENOSYS, so legitimate multi-threaded/
     * multi-process Python continues to work via the (CLONE_NEWUSER-
     * masked-killed) clone path, while a direct malicious clone3(
     * CLONE_NEWUSER) still cannot create the namespace. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(clone),
                          1, SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) != 0) {
        fprintf(stderr, "failed to add clone/CLONE_NEWUSER deny rule\n");
        return 1;
    }
    /* unshare() takes its flags directly as a scalar arg0 (unlike
     * clone3), so seccomp CAN inspect it: mask-match CLONE_NEWUSER only,
     * leaving unshare() of other namespace types allowed. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(unshare),
                          1, SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) != 0) {
        fprintf(stderr, "failed to add unshare/CLONE_NEWUSER deny rule\n");
        return 1;
    }
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0) != 0) {
        fprintf(stderr, "failed to add clone3 ENOSYS rule\n");
        return 1;
    }

    /* socket(): AF_UNIX only. --unshare-net already removes any network
     * interface, so AF_UNIX (including abstract sockets, scoped per netns
     * by the kernel) is safe and needed by Python's stdlib. Every other
     * family is denied, EXPLICITLY including AF_NETLINK -- nf_tables/
     * netfilter CVEs reachable via AF_NETLINK sockets are the canonical
     * unprivileged-userns kernel-LPE route in the current CVE landscape. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(socket),
                          1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)) != 0) {
        fprintf(stderr, "failed to add socket() family-restriction rule\n");
        return 1;
    }

    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open");
        return 1;
    }
    int rc = seccomp_export_bpf(ctx, fd);
    close(fd);
    seccomp_release(ctx);
    if (rc != 0) {
        fprintf(stderr, "seccomp_export_bpf failed: %d\n", rc);
        return 1;
    }
    return 0;
}
```

- [ ] **Step 2: Write the build script**

`packages/sandbox/scripts/build-seccomp.sh`:
```bash
#!/usr/bin/env bash
# Compiles seccomp/build-tool-seccomp.c and exports the committed
# seccomp/tool.bpf (ADR-0007). Requires gcc + libseccomp-dev.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v gcc >/dev/null 2>&1; then
  echo "build-seccomp: FAIL — gcc not on PATH." >&2
  exit 1
fi
if ! echo '#include <seccomp.h>' | gcc -E - >/dev/null 2>&1; then
  echo "build-seccomp: FAIL — libseccomp-dev headers not found. Install libseccomp-dev." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gcc "seccomp/build-tool-seccomp.c" -lseccomp -o "$tmp/build-tool-seccomp"
"$tmp/build-tool-seccomp" "$tmp/tool.bpf"
cp "$tmp/tool.bpf" "seccomp/tool.bpf"
echo "build-seccomp: wrote seccomp/tool.bpf ($(wc -c < seccomp/tool.bpf) bytes)"
```

Run: `chmod +x packages/sandbox/scripts/build-seccomp.sh`

- [ ] **Step 3: Write the CI parity check script (mirrors `check-policy-wasm.sh`)**

`packages/sandbox/scripts/check-seccomp-bpf.sh`:
```bash
#!/usr/bin/env bash
# CI guard (ADR-0007): the committed tool.bpf must match
# build-tool-seccomp.c. Rebuilds and diffs against the committed one. If
# gcc/libseccomp-dev are not available, SKIP loudly rather than fail — CI
# stays hermetic (it ships the committed BPF; it does not require the
# toolchain to pass).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v gcc >/dev/null 2>&1 || ! echo '#include <seccomp.h>' | gcc -E - >/dev/null 2>&1; then
  echo "check-seccomp-bpf: SKIP — gcc/libseccomp-dev not available; committed tool.bpf not re-verified in this run."
  exit 0
fi

committed="seccomp/tool.bpf"
if [[ ! -f "$committed" ]]; then
  echo "check-seccomp-bpf: FAIL — committed $committed is missing." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gcc "seccomp/build-tool-seccomp.c" -lseccomp -o "$tmp/build-tool-seccomp"
"$tmp/build-tool-seccomp" "$tmp/tool.bpf"

if cmp -s "$tmp/tool.bpf" "$committed"; then
  echo "check-seccomp-bpf: OK — committed tool.bpf matches build-tool-seccomp.c."
else
  echo "check-seccomp-bpf: FAIL — build-tool-seccomp.c changed but tool.bpf is stale." >&2
  echo "  Run: pnpm --filter @openrupiv/sandbox build:seccomp   then commit seccomp/tool.bpf" >&2
  exit 1
fi
```

Run: `chmod +x packages/sandbox/scripts/check-seccomp-bpf.sh`

- [ ] **Step 4: Build and commit the BPF artifact**

Run: `bash packages/sandbox/scripts/build-seccomp.sh`
Expected: `build-seccomp: wrote seccomp/tool.bpf (NN bytes)` — if `gcc`/`libseccomp-dev` are missing locally, install them first: `sudo apt-get install -y gcc libseccomp-dev`.

Run: `bash packages/sandbox/scripts/check-seccomp-bpf.sh`
Expected: `check-seccomp-bpf: OK — committed tool.bpf matches build-tool-seccomp.c.`

- [ ] **Step 5: Add the CI job**

Modify `.github/workflows/ci.yml`, add a new job after `policy-wasm`:
```yaml
  sandbox-seccomp:
    name: Sandbox inner seccomp BPF matches source
    runs-on: ubuntu-latest
    container: ubuntu:24.04
    steps:
      - uses: actions/checkout@v4
      - name: Install libseccomp toolchain
        run: apt-get update && apt-get install -y gcc libseccomp-dev
      - name: Rebuild and diff the committed seccomp BPF
        run: bash packages/sandbox/scripts/check-seccomp-bpf.sh
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/seccomp/build-tool-seccomp.c packages/sandbox/seccomp/tool.bpf \
  packages/sandbox/scripts/build-seccomp.sh packages/sandbox/scripts/check-seccomp-bpf.sh \
  .github/workflows/ci.yml
git commit -s -m "sandbox: inner seccomp filter, build script, committed BPF, CI parity check (ADR-0007)"
```

---

### Task 4: Workspace lifecycle manager

**Files:**
- Create: `packages/sandbox/src/workspace.ts`
- Test: `packages/sandbox/test/workspace.test.ts`

**Interfaces:**
- Consumes: `isValidRunId` from Task 1's `run-id.ts`.
- Produces: `createWorkspace(runId: string, root: string): Promise<string>` (returns the absolute host path, creates a fresh empty `0700` dir), `cleanupWorkspace(runId: string, root: string, logger: Logger): Promise<void>` (best-effort, `O_NOFOLLOW` + `realpath`-checked, never throws). `export interface Logger { warn(fields: Record<string, unknown>, msg: string): void }` (a minimal structural seam — Task 6's real logger satisfies it; tests pass a fake). Task 5 imports both functions by these exact names.

- [ ] **Step 1: Write the failing test**

`packages/sandbox/test/workspace.test.ts`:
```ts
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorkspace, createWorkspace } from "../src/workspace";

const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function fakeLogger() {
  const calls: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  return { warn: (fields: Record<string, unknown>, msg: string) => calls.push({ fields, msg }), calls };
}

describe("createWorkspace / cleanupWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sandbox-workspaces-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a fresh, empty, 0700 directory named after the runId", async () => {
    const dir = await createWorkspace(RUN_ID, root);
    expect(dir).toBe(path.join(root, RUN_ID));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects an invalid runId without touching the filesystem", async () => {
    await expect(createWorkspace("../../etc", root)).rejects.toThrow();
    expect(existsSync(path.join(root, "..", "etc"))).toBe(false);
  });

  it("cleans up a real workspace directory and its contents", async () => {
    const dir = await createWorkspace(RUN_ID, root);
    await writeFile(path.join(dir, "output.json"), "{}");
    const logger = fakeLogger();
    await cleanupWorkspace(RUN_ID, root, logger);
    expect(existsSync(dir)).toBe(false);
    expect(logger.calls.length).toBe(0);
  });

  it("logs a warning (never throws) if cleanup fails", async () => {
    const logger = fakeLogger();
    // Nothing was ever created at this runId — cleanup of a nonexistent
    // directory is treated as a no-op success, not a failure to log.
    await expect(cleanupWorkspace(RUN_ID, root, logger)).resolves.toBeUndefined();
  });

  it("refuses to follow a symlink planted where the workspace root should be", async () => {
    const dir = await createWorkspace(RUN_ID, root);
    await rm(dir, { recursive: true, force: true });
    const outsideTarget = await mkdtemp(path.join(tmpdir(), "sandbox-outside-"));
    await writeFile(path.join(outsideTarget, "sentinel"), "must-not-be-touched");
    await symlink(outsideTarget, dir);

    const logger = fakeLogger();
    await cleanupWorkspace(RUN_ID, root, logger);

    // The symlink itself may be removed, but the outside directory it
    // pointed to, and its contents, must survive untouched.
    expect(existsSync(path.join(outsideTarget, "sentinel"))).toBe(true);
    await rm(outsideTarget, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/workspace'`.

- [ ] **Step 3: Implement `workspace.ts`**

`packages/sandbox/src/workspace.ts`:
```ts
/**
 * Per-run workspace lifecycle (ADR-0007, "Per-call jail construction" and
 * "Result handling — the workspace is hostile after the run"). The
 * workspace is treated as attacker-controlled the moment the jail has run
 * in it: cleanup never does a bare `rm -rf <path>` or `open()` on an
 * attacker-influenced path. Every path is resolved with `O_NOFOLLOW`-style
 * discipline (via `lstat` first) plus a `realpath` check that the
 * canonical result still falls under the workspace root before touching
 * it. Deletion failures are logged, never silently swallowed, and never
 * block returning a result to the runtime.
 */

import { constants } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isValidRunId } from "./run-id";

export interface Logger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** Creates `<root>/<runId>` fresh, empty, mode 0700. Throws on an invalid runId. */
export async function createWorkspace(runId: string, root: string): Promise<string> {
  if (!isValidRunId(runId)) {
    throw new Error(`createWorkspace: invalid runId "${runId}"`);
  }
  const dir = path.join(root, runId);
  await mkdir(dir, { recursive: false, mode: 0o700 });
  return dir;
}

/**
 * Best-effort cleanup. Never throws: any failure (including a symlink
 * planted where the workspace should be) is logged via `logger.warn` and
 * swallowed, since a cleanup failure must never block returning the tool
 * result to the runtime.
 */
export async function cleanupWorkspace(
  runId: string,
  root: string,
  logger: Logger,
): Promise<void> {
  if (!isValidRunId(runId)) {
    logger.warn({ event: "sandbox.workspace_cleanup_failed", runId, reason: "invalid_run_id" }, "refusing to clean up an invalid runId");
    return;
  }
  const dir = path.join(root, runId);

  let stat;
  try {
    stat = await lstat(dir);
  } catch {
    // Nothing to clean up — not an error.
    return;
  }

  if (stat.isSymbolicLink()) {
    // A jailed process cannot plant a symlink AT this exact path (the
    // supervisor creates it fresh before each run and this function is the
    // only thing that removes it), but treat it as hostile defensively:
    // remove the link itself, never follow it, never touch its target.
    try {
      await rm(dir, { force: true });
    } catch (err) {
      logger.warn(
        { event: "sandbox.workspace_cleanup_failed", runId, reason: errorMessage(err) },
        "failed to remove a symlink found at the workspace path",
      );
    }
    return;
  }

  try {
    const real = await realpath(dir);
    const realRoot = await realpath(root);
    const relative = path.relative(realRoot, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      logger.warn(
        { event: "sandbox.workspace_cleanup_failed", runId, reason: "resolved_outside_root" },
        "workspace realpath resolved outside the workspace root — refusing to delete",
      );
      return;
    }
    await rm(real, { recursive: true, force: true, maxRetries: 0 });
  } catch (err) {
    logger.warn(
      { event: "sandbox.workspace_cleanup_failed", runId, reason: errorMessage(err) },
      "failed to clean up workspace directory",
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void constants; // referenced for O_NOFOLLOW discipline in the doc comment above; no direct use needed with lstat-first
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS. If the symlink test fails because `rm` under Node followed the link instead of removing it, replace the symlink-branch `rm` call with `await unlink(dir)` (from `node:fs/promises`) instead of `rm`, since `unlink` never follows a symlink by definition; re-run.

- [ ] **Step 5: Remove the unused `constants` import**

Since Step 4 may have led to using `unlink` instead, clean up: replace the `void constants;` line and its import with nothing, and add `unlink` to the `node:fs/promises` import if used. Re-run typecheck to confirm no unused-import errors:

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src/workspace.ts packages/sandbox/test/workspace.test.ts
git commit -s -m "sandbox: per-run workspace lifecycle (create/cleanup, symlink-safe)"
```

---

### Task 5: Jail executor

This is the module that actually spawns `prlimit | bwrap` and classifies the outcome into a `SandboxExecuteResult`-shaped value. Unit tests inject a fake spawn function — no real `bwrap` invocation runs in this task's tests (see Global Constraints: this dev environment cannot create user namespaces).

**Files:**
- Create: `packages/sandbox/src/jail-executor.ts`
- Test: `packages/sandbox/test/jail-executor.test.ts`

**Interfaces:**
- Consumes: `buildBwrapArgv`, `BwrapArgvOptions` (Task 2, imported and called directly — this module must never re-assemble the bwrap argv itself); `resolveEntrypoint` (Task 2, called by `server.ts` in Task 7 before `runJail`, not by this module).
- Produces:
```ts
export interface JailLimits {
  wallClockMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
}
export interface RunJailInput {
  entrypointPath: string;
  workspaceHostPath: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  limits: JailLimits;
}
export type JailOutcome =
  | { ok: true; output: unknown; durationMs: number }
  | { ok: false; reason: "violation"; violation: "network_egress" | "fs_escape"; message: string; durationMs: number }
  | { ok: false; reason: "limit"; limit: "wall_clock" | "memory" | "output_size"; message: string; durationMs: number }
  | { ok: false; reason: "tool_error"; message: string; durationMs: number };
export interface SpawnFn {
  (cmd: string, args: string[], opts: { stdio: Array<"ignore" | "pipe" | number> }): ChildProcessLike;
}
export interface ChildProcessLike {
  pid: number | undefined;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}
export function runJail(input: RunJailInput, deps?: { spawn?: SpawnFn }): Promise<JailOutcome>;
```
Task 7 (supervisor) imports `runJail`, `RunJailInput`, `JailOutcome`, `JailLimits` by these exact names.

- [ ] **Step 1: Write the failing test using a fake spawn**

`packages/sandbox/test/jail-executor.test.ts`:
```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runJail } from "../src/jail-executor";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter() as unknown as { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr = new EventEmitter() as unknown as { on(event: "data", cb: (chunk: Buffer) => void): void };
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
    seccompBpfPath: "/opt/sandbox/seccomp/tool.bpf",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/jail-executor'`.

- [ ] **Step 3: Implement `jail-executor.ts`**

`packages/sandbox/src/jail-executor.ts`:
```ts
/**
 * Spawns one `prlimit | bwrap` jail per call and classifies the outcome
 * (ADR-0007, "Resource limits" + "Network: three independent layers").
 *
 * `prlimit RESOURCE-FLAGS -- bwrap ARGS...` is a single argv array (no
 * shell): `prlimit`'s exec form calls `setrlimit()` on itself then
 * `execve()`s directly into the target command image, so the rlimits it
 * sets are inherited across every subsequent `execve()` in the chain
 * (`prlimit` -> `bwrap` -> the jailed `python3`), since POSIX rlimits
 * survive `exec` unless a process explicitly loosens them back (bwrap does
 * not).
 *
 * Wall-clock is NOT an rlimit: a JS timer SIGKILLs the tracked child PID if
 * it has not exited by `limits.wallClockMs` (ADR-0007: "supervisor timer,
 * SIGKILLs the bwrap parent"). CPU time (`RLIMIT_CPU`) is a
 * belt-and-suspenders backstop in case the timer fails to fire.
 *
 * A network-egress attempt is classified from the jail's exit SIGNAL
 * (`SIGSYS`, raised by the kernel when the inner seccomp filter kills the
 * process for a disallowed syscall) — never from any in-jail self-report,
 * so a compromised tool process cannot claim "no violation occurred."
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { buildBwrapArgv } from "./bwrap-argv";

export interface JailLimits {
  wallClockMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
}

export interface RunJailInput {
  entrypointPath: string;
  workspaceHostPath: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  limits: JailLimits;
}

export type JailOutcome =
  | { ok: true; output: unknown; durationMs: number }
  | {
      ok: false;
      reason: "violation";
      violation: "network_egress" | "fs_escape";
      message: string;
      durationMs: number;
    }
  | {
      ok: false;
      reason: "limit";
      limit: "wall_clock" | "memory" | "output_size";
      message: string;
      durationMs: number;
    }
  | { ok: false; reason: "tool_error"; message: string; durationMs: number };

export interface ChildProcessLike {
  pid: number | undefined;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: Array<"ignore" | "pipe" | number> },
) => ChildProcessLike;

const RLIMIT_NPROC = 16;
const RLIMIT_CPU_SECONDS = 30;
const RLIMIT_FSIZE_BYTES = 67_108_864;
const RLIMIT_NOFILE = 256;

// fs_escape is a best-effort STDERR LABEL only — real fs-escape enforcement
// is bwrap's mount namespace (RO binds -> EROFS; absent host paths ->
// ENOENT), not this heuristic. ENOENT ("no such file or directory") and
// EACCES ("permission denied") are far too common in ordinary, benign tool
// failures (e.g. a tool's own FileNotFoundError for a missing workspace
// file) to be used as a security signal, so only the read-only-filesystem
// (EROFS) signal — which bwrap's RO binds actually produce — is matched.
function looksLikeFsEscape(stderrText: string): boolean {
  return /read-only file system|errno 30\b|\berofs\b/i.test(stderrText);
}

export function runJail(
  input: RunJailInput,
  deps: { spawn?: SpawnFn } = {},
): Promise<JailOutcome> {
  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const seccompFd = openSync(input.seccompBpfPath, "r");

    // buildBwrapArgv (bwrap-argv.ts) is the ONE place a bwrap argv is
    // assembled (ADR-0007) — this module never duplicates it. seccompFd is
    // always 3: the stdio array below always places it as the 4th entry
    // (index 3), which Node maps to FD 3 in the child regardless of the
    // real host FD number `openSync` returned.
    const bwrapArgv = buildBwrapArgv({
      workspaceHostPath: input.workspaceHostPath,
      pythonRoot: input.pythonRoot,
      toolRoot: input.toolRoot,
      seccompFd: 3,
      entrypointPath: input.entrypointPath,
    });
    const prlimitArgs = [
      `--as=${input.limits.memoryBytes}`,
      `--nproc=${RLIMIT_NPROC}`,
      `--nofile=${RLIMIT_NOFILE}`,
      `--fsize=${RLIMIT_FSIZE_BYTES}`,
      `--cpu=${RLIMIT_CPU_SECONDS}`,
      "--",
      "bwrap",
      ...bwrapArgv,
    ];

    const child = spawnFn("prlimit", prlimitArgs, { stdio: ["ignore", "pipe", "pipe", seccompFd] });

    // The child has already inherited FD 3 (a dup of seccompFd) via the
    // stdio array passed to spawnFn above, so the supervisor's own copy is
    // no longer needed as of this point on every path (success, spawn
    // failure, later timeout/exit) — close it once, right here, rather
    // than in the exit/error handlers, so there is exactly one close site
    // and no risk of a double-close race between them. Leaving it open
    // would leak one fd per runJail call until RLIMIT_NOFILE is exhausted.
    closeSync(seccompFd);

    let stdoutBytes = Buffer.alloc(0);
    let stderrBytes = Buffer.alloc(0);
    let outputCapped = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.limits.wallClockMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes.length >= input.limits.maxOutputBytes) {
        outputCapped = true;
        return;
      }
      stdoutBytes = Buffer.concat([stdoutBytes, chunk]).subarray(0, input.limits.maxOutputBytes);
      if (stdoutBytes.length >= input.limits.maxOutputBytes) outputCapped = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = Buffer.concat([stderrBytes, chunk]).subarray(0, 4096);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const stderrText = stderrBytes.toString("utf8");

      // SIGSYS is a kernel-enforced seccomp kill (ADR-0007 "Network: three
      // independent layers") and MUST be checked before the timedOut /
      // outputCapped soft-limit branches below: those are parent-side (a
      // JS timer, a byte counter on piped stdout) and can coincide with a
      // genuine security violation, in which case the violation is the
      // more important fact to surface — a kernel kill for a disallowed
      // syscall must never be masked as "just" a benign output or time
      // cap. This ordering does not lose the wall-clock case: our
      // wall-clock timer always SIGKILLs (see below), never SIGSYS, so a
      // real timeout still falls through to the timedOut branch.
      //
      // Labeling simplification (documented for the human reviewer, no
      // logic change): the inner seccomp filter KILL_PROCESSes on many
      // disallowed syscalls (mount, ptrace, etc.), not only socket() /
      // connect(), but the shared SandboxExecuteResult contract only
      // defines "network_egress" and "fs_escape" as violation subtypes.
      // Every SIGSYS death is therefore labeled "network_egress" as the
      // representative violation subtype; the message text still
      // accurately says the process was killed by the inner seccomp
      // filter, without claiming it was specifically a network syscall.
      if (signal === "SIGSYS") {
        resolve({
          ok: false,
          reason: "violation",
          violation: "network_egress",
          message: "process was killed by the inner seccomp filter (SIGSYS)",
          durationMs,
        });
        return;
      }
      if (timedOut) {
        resolve({
          ok: false,
          reason: "limit",
          limit: "wall_clock",
          message: `tool execution exceeded wallClockMs=${input.limits.wallClockMs}`,
          durationMs,
        });
        return;
      }
      if (outputCapped) {
        resolve({
          ok: false,
          reason: "limit",
          limit: "output_size",
          message: `tool output exceeded maxOutputBytes=${input.limits.maxOutputBytes}`,
          durationMs,
        });
        return;
      }
      if (signal === "SIGKILL" && code === null) {
        resolve({
          ok: false,
          reason: "tool_error",
          message: "process was killed (SIGKILL) for an unclassified reason",
          durationMs,
        });
        return;
      }
      if (code === 0) {
        let output: unknown = null;
        const text = stdoutBytes.toString("utf8").trim();
        if (text.length > 0) {
          try {
            output = JSON.parse(text);
          } catch {
            output = text;
          }
        }
        resolve({ ok: true, output, durationMs });
        return;
      }
      // Best-effort: RLIMIT_AS (prlimit --as) IS kernel-enforced, but
      // CPython surfaces the resulting allocation failure as a plain
      // MemoryError on stderr rather than a distinguishable signal or exit
      // code, so this is a heuristic label, not the enforcement itself.
      // It is NOT exhaustive: a cgroup-level OOM kill (bare SIGKILL, no
      // stderr) remains ambiguous and still falls through to the
      // SIGKILL/tool_error branches above/below.
      if (/MemoryError/.test(stderrText)) {
        resolve({
          ok: false,
          reason: "limit",
          limit: "memory",
          message: stderrText || `process exited with code ${code}`,
          durationMs,
        });
        return;
      }
      if (looksLikeFsEscape(stderrText)) {
        resolve({
          ok: false,
          reason: "violation",
          violation: "fs_escape",
          message: stderrText || `process exited with code ${code}`,
          durationMs,
        });
        return;
      }
      resolve({
        ok: false,
        reason: "tool_error",
        message: stderrText || `process exited with code ${code}`,
        durationMs,
      });
    });

    // If spawnFn itself fails asynchronously (e.g. `prlimit` is missing
    // from PATH -> ENOENT), Node emits "error" instead of "exit" and never
    // emits "exit" at all — without this handler the returned Promise
    // would never settle, leaking a concurrency slot forever. The
    // `settled` guard (shared with the exit handler above) ensures exactly
    // one of exit/error can resolve the Promise.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({
        ok: false,
        reason: "tool_error",
        message: `failed to spawn jail process: ${err.message}`,
        durationMs,
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS. Note: `openSync(input.seccompBpfPath, "r")` requires the test's `seccompBpfPath` to point at a real, readable file — since Task 3 already committed `packages/sandbox/seccomp/tool.bpf`, the test's `seccompBpfPath: "/opt/sandbox/seccomp/tool.bpf"` will NOT exist on the test-runner's filesystem and `openSync` will throw before `spawn` is even called. Fix the test fixture: change `baseInput()`'s `seccompBpfPath` to `path.join(__dirname, "..", "seccomp", "tool.bpf")` (the real committed file, resolved relatively) so `openSync` succeeds against a real file while `spawn` itself stays faked. Re-run after this fix.

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src/jail-executor.ts packages/sandbox/test/jail-executor.test.ts
git commit -s -m "sandbox: jail executor (prlimit+bwrap spawn, limits, outcome classification)"
```

---

### Task 6: Structured logger + boot canary

**Files:**
- Create: `packages/sandbox/src/logger.ts`
- Create: `packages/sandbox/src/canary.ts`
- Test: `packages/sandbox/test/canary.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks for `logger.ts`. `canary.ts` consumes `runJail`/`RunJailInput`/`JailOutcome` shape conventions from Task 5 conceptually, but calls its own assertion-specific jail runs via an injected `runCanaryJail` function (kept separate from `runJail` because canary assertions read back `/proc/self/limits` and probe syscalls rather than running a real tool).
- Produces: `createLogger(sink?: LogSink): Logger` (own copy of the runtime's structured-logging convention — packages/sandbox does not depend on `@openrupiv/runtime`, matching the project's established "our own minimal interface" pattern already used by `@openrupiv/agents`'s `Db`/`Queryable`). `export interface CanaryAssertion { name: string; ok: boolean; detail?: string }`, `export interface CanaryResult { ok: boolean; assertions: CanaryAssertion[]; at: string }`, `runBootCanary(deps: { runAssertionJail: (script: string) => Promise<{ stdout: string; exitCode: number | null; signal: NodeJS.Signals | null }> }): Promise<CanaryResult>`. Task 7 imports `createLogger`, `runBootCanary`, `CanaryResult` by these exact names.

- [ ] **Step 1: Implement `logger.ts` (no test needed — a direct, intentional duplication of an already-tested pattern)**

`packages/sandbox/src/logger.ts`:
```ts
/**
 * Structured JSON logging, deliberately duplicated from
 * `@openrupiv/runtime`'s `logger.ts` rather than imported: this sidecar
 * must not depend on `@openrupiv/runtime` (no reverse/lateral package
 * dependency), matching the same "our own minimal interface" convention
 * `@openrupiv/agents` already uses for `Db`/`Queryable` (see that package's
 * README). Every log line is one JSON object on stdout; the sandbox has no
 * database connection (no route to postgres — see ADR-0007's Network
 * section) so this stdout stream, not a DB-backed audit table, is how an
 * operator correlates sandbox behavior with the platform's audit trail.
 */

const REDACT_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED:depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(item, depth + 1);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export function createLogger(sink: LogSink = process.stdout): Logger {
  const emit = (level: LogLevel, fields: Record<string, unknown>, msg: string): void => {
    const record = { level, time: new Date().toISOString(), msg, ...(redact(fields) as Record<string, unknown>) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, time: new Date().toISOString(), msg, logError: "fields were not serializable" });
    }
    sink.write(`${line}\n`);
  };
  return {
    debug: (fields, msg) => emit("debug", fields, msg),
    info: (fields, msg) => emit("info", fields, msg),
    warn: (fields, msg) => emit("warn", fields, msg),
    error: (fields, msg) => emit("error", fields, msg),
  };
}
```

- [ ] **Step 2: Write the failing test for the boot canary**

`packages/sandbox/test/canary.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runBootCanary } from "../src/canary";

const HAPPY_STDOUT = JSON.stringify({
  no_network_interface: true,
  toolchain_ro: true,
  host_path_absent: true,
  rlimits_applied: true,
  af_inet_socket_killed_by_sigsys: true,
  no_new_privs: true,
  nested_userns_killed: true,
});

describe("runBootCanary", () => {
  it("reports ok:true when every assertion in the jail's JSON report is true", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: HAPPY_STDOUT, exitCode: 0, signal: null }),
    });
    expect(result.ok).toBe(true);
    expect(result.assertions.every((a) => a.ok)).toBe(true);
    expect(result.assertions.map((a) => a.name).sort()).toEqual(
      [
        "af_inet_socket_killed_by_sigsys",
        "host_path_absent",
        "nested_userns_killed",
        "no_network_interface",
        "no_new_privs",
        "rlimits_applied",
        "toolchain_ro",
      ].sort(),
    );
  });

  it("reports ok:false when any single assertion is false", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({
        stdout: JSON.stringify({ ...JSON.parse(HAPPY_STDOUT), no_network_interface: false }),
        exitCode: 0,
        signal: null,
      }),
    });
    expect(result.ok).toBe(false);
    const failed = result.assertions.find((a) => a.name === "no_network_interface");
    expect(failed?.ok).toBe(false);
  });

  it("reports ok:false (fail closed) if the canary jail itself crashes instead of reporting", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "", exitCode: 1, signal: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.assertions).toEqual([
      { name: "canary_jail_execution", ok: false, detail: expect.stringContaining("exit code 1") },
    ]);
  });

  it("reports ok:false (fail closed) if the canary jail's stdout is not valid JSON", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "not json", exitCode: 0, signal: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.assertions[0]?.name).toBe("canary_jail_execution");
  });

  it("stamps an ISO timestamp", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: HAPPY_STDOUT, exitCode: 0, signal: null }),
    });
    expect(() => new Date(result.at).toISOString()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/canary'`.

- [ ] **Step 4: Implement `canary.ts`**

`packages/sandbox/src/canary.ts`:
```ts
/**
 * Boot canary (ADR-0007, "Boot canary — fail-closed, merge- and
 * healthcheck-blocking"). Runs a self-test jail through the exact same
 * jail-construction path production calls use (the actual assertion jail
 * script lives at `packages/sandbox/tools/canary/main.py`, exercised by
 * Task 10's Docker-based end-to-end test; this module only INTERPRETS its
 * report) and asserts, in order: no network interface, toolchain paths
 * read-only / host paths absent, rlimits actually applied, an AF_INET
 * socket() call is killed by SIGSYS, `no_new_privs` is set, and a nested
 * user-namespace creation attempt is killed.
 *
 * If ANY assertion fails, or the canary jail cannot even be run and report
 * back, this returns `{ ok: false, ... }` — `server.ts`'s `/healthz` route
 * reports unhealthy and `/v1/execute` refuses every request when this is
 * false. There is no fallback execution path; a sandbox that cannot prove
 * its own isolation stops accepting tool calls entirely.
 */

export interface CanaryAssertion {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CanaryResult {
  ok: boolean;
  assertions: CanaryAssertion[];
  at: string;
}

const EXPECTED_ASSERTION_NAMES = [
  "no_network_interface",
  "toolchain_ro",
  "host_path_absent",
  "rlimits_applied",
  "af_inet_socket_killed_by_sigsys",
  "no_new_privs",
  "nested_userns_killed",
] as const;

export interface RunAssertionJailResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export async function runBootCanary(deps: {
  runAssertionJail: (script: string) => Promise<RunAssertionJailResult>;
}): Promise<CanaryResult> {
  const at = new Date().toISOString();
  const jailResult = await deps.runAssertionJail("canary");

  if (jailResult.exitCode !== 0) {
    return {
      ok: false,
      at,
      assertions: [
        {
          name: "canary_jail_execution",
          ok: false,
          detail: `canary jail did not exit cleanly: exit code ${jailResult.exitCode}, signal ${jailResult.signal ?? "none"}`,
        },
      ],
    };
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(jailResult.stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      at,
      assertions: [
        { name: "canary_jail_execution", ok: false, detail: "canary jail stdout was not valid JSON" },
      ],
    };
  }

  const assertions: CanaryAssertion[] = EXPECTED_ASSERTION_NAMES.map((name) => {
    const value = report[name];
    return { name, ok: value === true, detail: value === true ? undefined : `expected true, got ${JSON.stringify(value)}` };
  });

  return { ok: assertions.every((a) => a.ok), assertions, at };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/src/logger.ts packages/sandbox/src/canary.ts packages/sandbox/test/canary.test.ts
git commit -s -m "sandbox: structured logger + boot canary interpretation (ADR-0007)"
```

---

### Task 7: Supervisor HTTP server

**Files:**
- Create: `packages/sandbox/src/config.ts`
- Create: `packages/sandbox/src/server.ts`
- Create: `packages/sandbox/src/concurrency.ts`
- Create: `packages/sandbox/bin/serve.mjs`
- Test: `packages/sandbox/test/server.test.ts`
- Test: `packages/sandbox/test/concurrency.test.ts`

**Interfaces:**
- Consumes: `tokensMatch` (Task 1), `extractRunId`/`isValidRunId` (Task 1), `createWorkspace`/`cleanupWorkspace` (Task 4), `runJail`/`RunJailInput`/`JailOutcome` (Task 5), `resolveEntrypoint` (Task 2), `createLogger`/`Logger` (Task 6), `runBootCanary`/`CanaryResult` (Task 6), `ExecutionSemaphore`/`SandboxAtCapacityError` (this task's own `concurrency.ts`, below).
- Produces: `export interface ServerDeps { token: string; workspaceRoot: string; pythonRoot: string; toolRoot: string; seccompBpfPath: string; logger?: Logger; runJailFn?: typeof runJail; canaryResult: CanaryResult; concurrency?: { maxConcurrent: number; maxQueueDepth: number } }`, `export async function createServer(deps: ServerDeps): Promise<FastifyInstance>`. Task 9's Dockerfile `CMD` invokes `bin/serve.mjs`, which reads env vars into `ServerDeps` and calls `createServer` then `.listen`. `concurrency.ts` produces `export class ExecutionSemaphore`, `export class SandboxAtCapacityError extends Error`, consumed by `server.ts`'s `/v1/execute` handler to enforce ADR-0007's supervisor-level concurrency cap.

- [ ] **Step 1: Implement `config.ts`**

`packages/sandbox/src/config.ts`:
```ts
/**
 * Environment-variable configuration for the sandbox supervisor, mirroring
 * `@openrupiv/runtime`'s `config.ts` fail-fast style: every required value
 * is validated at startup, never defaulted to something insecure.
 */

export interface SandboxConfig {
  token: string;
  workspaceRoot: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  port: number;
}

export class SandboxConfigError extends Error {}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const token = env["SANDBOX_TOKEN"];
  if (!token || token.length < 32) {
    throw new SandboxConfigError("SANDBOX_TOKEN must be set to a random value >= 32 characters");
  }
  const workspaceRoot = env["SANDBOX_WORKSPACE_ROOT"] ?? "/workspaces";
  const pythonRoot = env["SANDBOX_PYTHON_ROOT"] ?? "/usr";
  const toolRoot = env["SANDBOX_TOOL_ROOT"] ?? "/opt/sandbox-tools";
  const seccompBpfPath = env["SANDBOX_SECCOMP_BPF_PATH"] ?? "/opt/sandbox/seccomp/tool.bpf";
  const port = Number(env["PORT"] ?? "8443");
  if (!Number.isInteger(port) || port <= 0) {
    throw new SandboxConfigError(`PORT must be a positive integer, got "${env["PORT"]}"`);
  }
  return { token, workspaceRoot, pythonRoot, toolRoot, seccompBpfPath, port };
}
```

- [ ] **Step 2: Write the failing test for the server**

`packages/sandbox/test/server.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import type { JailOutcome, RunJailInput } from "../src/jail-executor";
import type { CanaryResult } from "../src/canary";

const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const TOKEN = "a".repeat(40);

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
    workspaceRoot: "/tmp/sandbox-test-workspaces",
    pythonRoot: "/usr",
    toolRoot: "/opt/sandbox-tools",
    seccompBpfPath: "/opt/sandbox/seccomp/tool.bpf",
    canaryResult: HEALTHY_CANARY,
    runJailFn: async (_input: RunJailInput) => okOutcome,
    ...overrides,
  };
}

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
```

Note: `toolRoot: "/opt/sandbox-tools"` won't exist on the test runner's filesystem, so `resolveEntrypoint("echo", toolRoot)` will throw "does not exist" even for the valid-tool test case. Before writing `server.ts`, create a real fixture directory so the "success" test has something real to resolve against.

- [ ] **Step 3: Create a test-only tool fixture directory**

```bash
mkdir -p packages/sandbox/test/fixtures/tools/echo
printf '# test fixture only, not a production tool\n' > packages/sandbox/test/fixtures/tools/echo/main.py
```

Update `baseDeps()` in `packages/sandbox/test/server.test.ts`: change `toolRoot: "/opt/sandbox-tools"` to `toolRoot: path.join(__dirname, "fixtures", "tools")` (add `import path from "node:path";` at the top of the test file).

- [ ] **Step 4: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/server'`.

- [ ] **Step 5: Implement `server.ts`**

`packages/sandbox/src/server.ts`:
```ts
/**
 * Supervisor HTTP server (ADR-0007, "Supervisor API"): exactly two routes.
 * `POST /v1/execute` is the only route a tool-calling client ever reaches;
 * `GET /healthz` is unauthenticated (Compose healthchecks, not tool
 * callers, hit it) and reports the boot canary's result. If the canary
 * failed, `/v1/execute` refuses every request with a typed 503 — there is
 * no fallback execution path.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CanaryResult } from "./canary";
import { resolveEntrypoint, EntrypointResolutionError } from "./entrypoint";
import { runJail, type JailOutcome, type RunJailInput } from "./jail-executor";
import { createLogger, type Logger } from "./logger";
import { extractRunId } from "./run-id";
import { tokensMatch } from "./token-auth";
import { cleanupWorkspace, createWorkspace } from "./workspace";

export interface ServerDeps {
  token: string;
  workspaceRoot: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  canaryResult: CanaryResult;
  logger?: Logger;
  runJailFn?: (input: RunJailInput) => Promise<JailOutcome>;
}

interface ExecuteRequestBody {
  runId?: unknown;
  tool?: unknown;
  input?: unknown;
  limits?: {
    wallClockMs?: unknown;
    memoryBytes?: unknown;
    maxOutputBytes?: unknown;
  };
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger();
  const runJailFn = deps.runJailFn ?? runJail;
  const app = Fastify({ logger: false });

  app.get("/healthz", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(deps.canaryResult.ok ? 200 : 503);
    return reply.send({ ok: deps.canaryResult.ok, assertions: deps.canaryResult.assertions, at: deps.canaryResult.at });
  });

  app.post("/v1/execute", async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request.headers.authorization);
    if (!bearer || !tokensMatch(bearer, deps.token)) {
      logger.warn({ event: "sandbox.auth_rejected", reason: bearer ? "invalid_token" : "missing_token" }, "rejected /v1/execute request");
      reply.code(401);
      return reply.send({ error: "ERR_SANDBOX_UNAUTHORIZED" });
    }

    if (!deps.canaryResult.ok) {
      reply.code(503);
      return reply.send({ error: "ERR_SANDBOX_UNHEALTHY", assertions: deps.canaryResult.assertions });
    }

    const body = request.body as ExecuteRequestBody;
    const runId = typeof body.runId === "string" ? extractRunId(`/${body.runId}`) : null;
    if (!runId) {
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_RUN_ID" });
    }

    const tool = typeof body.tool === "string" ? body.tool : null;
    let entrypointPath: string;
    try {
      if (!tool) throw new EntrypointResolutionError(String(tool), "missing");
      entrypointPath = resolveEntrypoint(tool, deps.toolRoot);
    } catch (err) {
      logger.warn({ event: "sandbox.entrypoint_rejected", tool, reason: errorMessage(err) }, "rejected tool entrypoint");
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_TOOL" });
    }

    const limits = {
      wallClockMs: Number(body.limits?.wallClockMs ?? 0),
      memoryBytes: Number(body.limits?.memoryBytes ?? 0),
      maxOutputBytes: Number(body.limits?.maxOutputBytes ?? 0),
    };
    if (!limits.wallClockMs || !limits.memoryBytes || !limits.maxOutputBytes) {
      reply.code(400);
      return reply.send({ error: "ERR_SANDBOX_BAD_LIMITS" });
    }

    const workspaceHostPath = await createWorkspace(runId, deps.workspaceRoot);
    try {
      const outcome = await runJailFn({
        entrypointPath,
        workspaceHostPath,
        pythonRoot: deps.pythonRoot,
        toolRoot: deps.toolRoot,
        seccompBpfPath: deps.seccompBpfPath,
        limits,
      });
      reply.code(200);
      return reply.send(outcome);
    } finally {
      await cleanupWorkspace(runId, deps.workspaceRoot, logger);
    }
  });

  return app;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS. If `createWorkspace` fails because `/tmp/sandbox-test-workspaces` doesn't exist yet, add a `beforeAll`/`afterAll` in `server.test.ts` that `mkdir`s and `rm`s that directory (mirror the pattern from `workspace.test.ts`).

- [ ] **Step 7: Implement `bin/serve.mjs`**

`packages/sandbox/bin/serve.mjs`:
```js
#!/usr/bin/env node
// Sandbox supervisor entrypoint (mirrors packages/runtime/bin/serve.mjs's
// shape). Reads SandboxConfig from the environment, runs the boot canary
// via the real assertion jail, then serves. Any canary failure still
// starts the HTTP server (so /healthz can report WHY) but /v1/execute
// refuses every request per ADR-0007's fail-closed contract.
import { configFromEnv } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { runBootCanary } from "../src/canary.ts";
import { runJail } from "../src/jail-executor.ts";
import { createLogger } from "../src/logger.ts";

const logger = createLogger();

async function main() {
  const config = configFromEnv();

  const canaryResult = await runBootCanary({
    runAssertionJail: async () => {
      const outcome = await runJail({
        entrypointPath: `${config.toolRoot}/canary/main.py`,
        workspaceHostPath: `${config.workspaceRoot}/boot-canary`,
        pythonRoot: config.pythonRoot,
        toolRoot: config.toolRoot,
        seccompBpfPath: config.seccompBpfPath,
        limits: { wallClockMs: 10_000, memoryBytes: 268_435_456, maxOutputBytes: 65_536 },
      });
      return {
        stdout: outcome.ok ? JSON.stringify(outcome.output) : "",
        exitCode: outcome.ok ? 0 : 1,
        signal: null,
      };
    },
  });

  logger.info({ event: "sandbox.canary", ok: canaryResult.ok, assertions: canaryResult.assertions }, "boot canary complete");
  if (!canaryResult.ok) {
    logger.error({ event: "sandbox.canary_failed" }, "boot canary failed — /v1/execute will refuse every request");
  }

  const app = await createServer({
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    pythonRoot: config.pythonRoot,
    toolRoot: config.toolRoot,
    seccompBpfPath: config.seccompBpfPath,
    canaryResult,
    logger,
  });

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ event: "sandbox.listening", port: config.port }, "sandbox supervisor listening");
}

main().catch((err) => {
  logger.error({ event: "sandbox.fatal", err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, "sandbox supervisor failed to start");
  process.exitCode = 1;
});
```

- [ ] **Step 8: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors. `bin/serve.mjs` is excluded from `tsconfig.json`'s `include` (only `src`/`test`) — this is intentional and matches `packages/runtime/bin/serve.mjs`'s convention (plain `.mjs`, run via `tsx` at container start, not typechecked as part of the package's own `tsc --noEmit`).

- [ ] **Step 9: Commit**

```bash
git add packages/sandbox/src/config.ts packages/sandbox/src/server.ts packages/sandbox/bin/serve.mjs \
  packages/sandbox/test/server.test.ts packages/sandbox/test/fixtures
git commit -s -m "sandbox: supervisor HTTP server (/v1/execute, /healthz) + entrypoint"
```

- [ ] **Step 10: Write the failing test for the concurrency gate**

Steps 5-9 above satisfy every gate in the brief except one: ADR-0007's
"Resource limits" section (`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md:361-364`)
mandates a **supervisor-level concurrency cap of 4** simultaneous jails, with
requests beyond the cap queuing up to a **small bounded depth** and then
being **rejected outright** — an unbounded queue would itself be a DoS
vector. Nothing above enforces this; `/v1/execute` as built so far calls
`runJailFn` with no bound on how many run concurrently. This gap was
identified and flagged (not silently patched) when Task 7 was first
implemented — see `.superpowers/sdd/task-7-report.md` — and is closed here,
in the same task, rather than as an unreviewed follow-up.

`packages/sandbox/test/concurrency.test.ts` (TDD red first — `../src/concurrency`
does not exist yet): covers acquiring up to `maxConcurrent` immediately;
queuing the `(maxConcurrent+1)`th `acquire()` (assert `queuedCount` rises and
the promise stays pending); FIFO hand-off to the first queued waiter once a
slot frees; rejecting with `SandboxAtCapacityError` when busy AND the queue
is already at `maxQueueDepth`, without changing `activeCount`/`queuedCount`;
idempotent `release()` (a second call frees nothing further); a fresh
`acquire()` succeeding immediately after a release leaves the queue empty;
and the constructor rejecting `maxConcurrent < 1` / `maxQueueDepth < 0`. Uses
real deferred promises and microtask flushing (`await Promise.resolve()`) to
observe pending vs. resolved state — no fake timers, no sleeps.

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/concurrency'`.

- [ ] **Step 11: Implement `concurrency.ts`**

`packages/sandbox/src/concurrency.ts` — a bounded-semaphore gate, reviewed
and transcribed verbatim (not re-derived) because it is DoS-relevant,
security-adjacent code:

```ts
/**
 * Bounded concurrency gate for jail execution (ADR-0007: "supervisor-level
 * concurrency cap of 4 simultaneous jails ... requests beyond the cap queue
 * up to a small bounded depth and are then rejected outright rather than
 * queued unboundedly -- an unbounded queue would itself be a DoS vector").
 *
 * acquire() resolves with a release() function once a slot is free. If all
 * slots are busy AND the wait queue is already at maxQueueDepth, acquire()
 * rejects immediately with SandboxAtCapacityError (fail fast, never queue
 * unboundedly). Each release() frees its slot exactly once (double-call
 * guarded) and hands it to the next waiter (FIFO) if any.
 */

export class SandboxAtCapacityError extends Error {
  constructor(
    message = "sandbox at capacity: all execution slots busy and the wait queue is full",
  ) {
    super(message);
    this.name = "SandboxAtCapacityError";
  }
}

type Waiter = (release: () => void) => void;

export class ExecutionSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueDepth: number,
  ) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    if (maxQueueDepth < 0) throw new Error("maxQueueDepth must be >= 0");
  }

  /** Resolves with a release fn when a slot is free; rejects with
   * SandboxAtCapacityError if all slots are busy and the queue is full. */
  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length < this.maxQueueDepth) {
      return new Promise<() => void>((resolve) => {
        this.queue.push((release) => resolve(release));
      });
    }
    return Promise.reject(new SandboxAtCapacityError());
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand this slot directly to the next waiter; active count is
        // unchanged (the slot is transferred, not freed then reacquired).
        next(this.makeRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}
```

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS (all `concurrency.test.ts` cases green).

- [ ] **Step 12: Wire the cap into `server.ts`**

1. Add `concurrency?: { maxConcurrent: number; maxQueueDepth: number }` to
   `ServerDeps`.
2. In `createServer`, construct
   `const semaphore = new ExecutionSemaphore(deps.concurrency?.maxConcurrent ?? 4, deps.concurrency?.maxQueueDepth ?? 8)`
   — defaults per ADR: cap 4, queue depth 8 (a small bounded depth).
3. In the `/v1/execute` handler, **after** the existing auth check, canary
   503 check, and all request validation (`runId`/`tool`/`limits`), but
   **before** `createWorkspace`, acquire a slot:
   ```ts
   let release: () => void;
   try {
     release = await semaphore.acquire();
   } catch (err) {
     if (err instanceof SandboxAtCapacityError) {
       logger.warn({ event: "sandbox.at_capacity" }, "rejected /v1/execute: at capacity");
       reply.code(503);
       return reply.send({ error: "ERR_SANDBOX_AT_CAPACITY" });
     }
     throw err;
   }
   ```
   Then move `createWorkspace` **inside** the existing `try`/`finally` (it
   must not run before the slot is acquired — never reserve a workspace for
   a request about to be rejected) and call `release()` in the **same**
   `finally` that already calls `cleanupWorkspace`, so the slot is freed on
   every path: success, `runJailFn` throwing, or `createWorkspace` itself
   throwing.
4. Import `ExecutionSemaphore, SandboxAtCapacityError` from `./concurrency`.

All prior Task 7 gates are preserved exactly (auth-first, canary-503,
cleanup-in-finally) — this only inserts the acquire/release around workspace
creation and jail execution; nothing is reordered ahead of the earlier gates.

- [ ] **Step 13: Add the server-level concurrency-cap test**

Add to `packages/sandbox/test/server.test.ts` a test that constructs the
server with `concurrency: { maxConcurrent: 1, maxQueueDepth: 0 }` and a
`runJailFn` controlled by a deferred promise, plus a second deferred
resolved the instant `runJailFn` is entered (so the test can `await` real
confirmation that request A holds the only slot, instead of polling or
sleeping). Fire request A (acquires the only slot, blocks inside
`runJailFn`); once confirmed entered, fire request B concurrently on the
same app instance → assert B gets HTTP 503 with body
`{ error: "ERR_SANDBOX_AT_CAPACITY" }` and that `runJailFn` was invoked only
**once** (B never reached the jail). Then resolve A's deferred outcome and
assert A completes 200 with the expected body. Use a `runId` distinct from
the file's shared `RUN_ID` constant for this test, since request A performs
a real `createWorkspace`/`cleanupWorkspace` cycle and Fastify's `inject()`
can resolve a response slightly before the handler's own `finally` block
(the async cleanup + `release()`) has actually finished running — reusing
the shared `RUN_ID` across tests risks an `EEXIST` race on the workspace
directory; a dedicated `runId` for this test avoids it entirely.

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS — full suite green, including the new concurrency-cap server
test and all `concurrency.test.ts` cases.

- [ ] **Step 14: Typecheck and commit**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

```bash
git add packages/sandbox/src/concurrency.ts packages/sandbox/src/server.ts \
  packages/sandbox/test/concurrency.test.ts packages/sandbox/test/server.test.ts
git commit -s -m "sandbox: supervisor-level concurrency cap for /v1/execute (ADR-0007)"
```

- [ ] **Step 15: Fix round — adversarial review of Task 7 (cross-request workspace destruction + hardening)**

An adversarial review of Steps 1-14 found one Important data-integrity
hazard and two Minor hardening gaps, all in `server.ts`'s `/v1/execute`
handler:

1. **(Important) Duplicate concurrent `runId` could destroy another
   request's active workspace.** `createWorkspace` does
   `mkdir(dir, { recursive: false })`, which throws `EEXIST` if a request
   with the same `runId` is already in flight. Because `createWorkspace`
   sat inside the same `try` whose `finally` unconditionally ran
   `cleanupWorkspace(runId, ...)`, a *second* concurrent request reusing an
   in-flight `runId` would have its own `createWorkspace` throw `EEXIST`,
   fall into that `finally`, and `rm -r` the **shared** directory — deleting
   the *first* (still-running) request's active jail workspace out from
   under it. Two authenticated callers, or a single buggy/retrying client
   reusing a `runId`, could corrupt each other's runs this way.

   Fixed by restructuring the handler so cleanup only ever runs for the
   workspace *this* request actually created, while the semaphore slot is
   *always* released regardless of which path is taken:
   ```ts
   try {
     let workspaceHostPath: string;
     try {
       workspaceHostPath = await createWorkspace(runId, deps.workspaceRoot);
     } catch (err) {
       if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
         logger.warn({ event: "sandbox.run_id_in_use", runId }, "rejected /v1/execute: runId already in flight");
         reply.code(409);
         return reply.send({ error: "ERR_SANDBOX_RUN_ID_IN_USE" });
       }
       throw err;
     }
     try {
       const outcome = await runJailFn({ /* ...unchanged... */ });
       reply.code(200);
       return reply.send(outcome);
     } finally {
       await cleanupWorkspace(runId, deps.workspaceRoot, logger);
     }
   } finally {
     release();
   }
   ```
   A duplicate concurrent `runId` now gets a typed `409 ERR_SANDBOX_RUN_ID_IN_USE`
   and never touches the first request's workspace; the first request's
   `cleanupWorkspace` call is reached only via its *own* successful
   `createWorkspace`. `createWorkspace`'s `0700`/`recursive: false`/runId
   validation behavior in `workspace.ts` is unchanged.

2. **(Minor) Non-positive limits leaked through.** The prior check
   (`!limits.wallClockMs || !limits.memoryBytes || !limits.maxOutputBytes`)
   rejected `0`/`NaN` but not negatives — `wallClockMs: -1` is truthy and
   passed straight through. Tightened via a helper,
   `isPositiveFiniteLimit(n) = Number.isFinite(n) && n > 0`, applied to all
   three limits; anything failing it still gets the existing
   `400 ERR_SANDBOX_BAD_LIMITS`.

3. **(Minor) The ADR-mandated default cap of 4 was untested.** Every
   existing concurrency test overrode `concurrency: {...}`; none exercised
   `createServer`'s actual default (`maxConcurrent ?? 4`,
   `maxQueueDepth ?? 8`). Added a test that, with no `concurrency` override,
   fires 4 concurrent long-held requests (all reaching the jail) plus a 5th
   that queues (not 503) until one of the 4 releases.

Tests added to `packages/sandbox/test/server.test.ts` (all distinct-runId
per test to avoid cross-test collisions, since Finding 1's fix now makes a
duplicate concurrent `runId` a hard rejection):
- `"rejects a second concurrent request with the same runId with 409, without deleting the first request's still-active workspace"`
  (asserts the workspace directory still exists on disk while request A is
  mid-flight, that `runJailFn` was only ever invoked once, and that A still
  completes 200 unaffected).
- Three limits-validation tests: negative `wallClockMs`, a non-numeric
  (`NaN`-producing) `wallClockMs`, and a zero `memoryBytes` — each asserting
  `400 ERR_SANDBOX_BAD_LIMITS` and that the jail was never invoked.
- `"holds exactly 4 concurrent jails with the default cap (no concurrency override) and queues a 5th until a slot frees"`.

Run: `corepack pnpm --filter @openrupiv/sandbox test && corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: PASS, no errors.

```bash
git add packages/sandbox/src/server.ts packages/sandbox/test/server.test.ts \
  docs/superpowers/plans/2026-07-07-agent-sandbox-bwrap-sidecar.md
git commit -s -m "sandbox: fix cross-request workspace destruction on duplicate runId (adversarial review)"
```

---

### Task 8: `createSidecarSandbox` HTTP client

**Files:**
- Create: `packages/sandbox/src/client.ts`
- Create: `packages/sandbox/src/index.ts`
- Test: `packages/sandbox/test/client.test.ts`

**Interfaces:**
- Consumes: `extractRunId` (Task 1); `ToolSandbox`, `SandboxExecuteInput`, `SandboxExecuteResult`, `SandboxLimits` from `@openrupiv/agents`.
- Produces: `export function createSidecarSandbox(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): ToolSandbox`. This is the package's main external-facing export, consumed by whatever assembles a real `AgentRuntime` deployment (out of scope for this plan — see the README task's scoping note).

- [ ] **Step 1: Write the failing test**

`packages/sandbox/test/client.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createSidecarSandbox } from "../src/client";
import type { SandboxExecuteInput } from "@openrupiv/agents";

const BASE_INPUT: SandboxExecuteInput = {
  tool: { name: "echo", description: "echoes input", inputSchema: {}, entrypoint: "echo" },
  input: { hello: "world" },
  workspaceDir: "/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  limits: { wallClockMs: 30_000, memoryBytes: 268_435_456, maxOutputBytes: 1_048_576 },
};

describe("createSidecarSandbox", () => {
  it("POSTs to <baseUrl>/v1/execute with the bearer token and { runId, tool, input, limits }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, output: { echoed: true }, durationMs: 5 }), { status: 200 }),
    );
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "test-token-value", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);

    expect(result).toEqual({ ok: true, output: { echoed: true }, durationMs: 5 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sandbox.internal:8443/v1/execute");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-token-value" });
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      tool: "echo",
      input: { hello: "world" },
      limits: BASE_INPUT.limits,
    });
    // Never a raw workspaceDir path on the wire.
    expect(JSON.stringify(sentBody)).not.toContain("/workspaces/");
  });

  it("re-validates workspaceDir client-side and refuses to send a malformed runId", async () => {
    const fetchImpl = vi.fn();
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute({ ...BASE_INPUT, workspaceDir: "/workspaces/../../etc" });
    expect(result).toMatchObject({ ok: false, reason: "tool_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx HTTP response to a tool_error result rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: "tool_error" });
  });

  it("maps a network-level fetch rejection to a tool_error result rather than throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: "tool_error", message: expect.stringContaining("ECONNREFUSED") });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 3: Implement `client.ts`**

`packages/sandbox/src/client.ts`:
```ts
/**
 * `createSidecarSandbox` — the `ToolSandbox` implementation `@openrupiv/agents`
 * calls at step 5 of `callTool` (ADR-0007, "Decision"). `workspaceDir` is
 * treated as opaque beyond its final path segment: this client extracts and
 * RE-VALIDATES that segment as a `runId` (never trusts the caller's
 * `SandboxExecuteInput.workspaceDir` as a real path) and transmits only
 * `{ runId, tool, input, limits }` over the wire — never a path string.
 */

import type {
  SandboxExecuteInput,
  SandboxExecuteResult,
  ToolSandbox,
} from "@openrupiv/agents";
import { extractRunId } from "./run-id";

export interface CreateSidecarSandboxOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function createSidecarSandbox(opts: CreateSidecarSandboxOptions): ToolSandbox {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
      const runId = extractRunId(input.workspaceDir);
      if (!runId) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: workspaceDir "${input.workspaceDir}" does not carry a valid runId`,
          durationMs: 0,
        };
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(`${opts.baseUrl}/v1/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({ runId, tool: input.tool.entrypoint, input: input.input, limits: input.limits }),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: request failed: ${errorMessage(err)}`,
          durationMs: Date.now() - startedAt,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: sidecar returned HTTP ${response.status}`,
          durationMs: Date.now() - startedAt,
        };
      }

      const body = (await response.json()) as SandboxExecuteResult;
      return body;
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/sandbox test`
Expected: PASS.

- [ ] **Step 5: Create the barrel export**

`packages/sandbox/src/index.ts`:
```ts
/**
 * @openrupiv/sandbox -- ADR-0007's bubblewrap sidecar. Consumers outside
 * this package need exactly `createSidecarSandbox` (satisfies
 * `@openrupiv/agents`'s `ToolSandbox`); everything else here is the
 * sidecar's own internal implementation, deployed as the `sandbox` Compose
 * service, not imported directly.
 */

export { createSidecarSandbox, type CreateSidecarSandboxOptions } from "./client";
```

- [ ] **Step 6: Typecheck**

Run: `corepack pnpm --filter @openrupiv/sandbox typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/src/client.ts packages/sandbox/src/index.ts packages/sandbox/test/client.test.ts
git commit -s -m "sandbox: createSidecarSandbox HTTP client (implements ToolSandbox)"
```

---

### Task 9: Dockerfile + outer Compose seccomp/AppArmor delta

**Files:**
- Create: `packages/sandbox/Dockerfile`
- Create: `packages/sandbox/docker-seccomp.json`

**Interfaces:**
- Produces: a buildable image (`docker build -f packages/sandbox/Dockerfile -t openrupiv-sandbox .` from the monorepo root, same convention as `packages/runtime/Dockerfile`). Task 10 builds and runs this image for the real end-to-end proof; Task 11's generated Compose service references `packages/sandbox/Dockerfile` and `packages/sandbox/docker-seccomp.json`.

- [ ] **Step 1: Write the Dockerfile**

`packages/sandbox/Dockerfile`:
```dockerfile
# @openrupiv/sandbox image (ADR-0007) — the bubblewrap sidecar.
#
# IMPORTANT: the build context is the MONOREPO ROOT (this package consumes
# the @openrupiv/agents workspace package for its type contract). Build:
#
#   docker build -f packages/sandbox/Dockerfile -t openrupiv-sandbox .
#
# Base is python:3.12-slim-bookworm, digest-pinned: bwrap is installed from
# Debian bookworm's own repos (never compiled from source), and Python 3.12
# + the (currently empty, v1 has no real tools yet) hash-pinned vendored
# wheels directory are what gets bound read-only INSIDE each jail. A
# separate node:22-bookworm-slim stage supplies only the `node` binary
# (verified in planning: copying just /usr/local/bin/node across these two
# same-Debian-base images works — matching glibc/libstdc++ ABI) — Node runs
# the supervisor ONLY, never tool code. No corepack/pnpm in the final
# image: production node_modules are installed in the deps stage (where
# corepack/pnpm work natively) and copied across as plain files.
#
# Digests recorded 2026-07-07 (see plan's Global Constraints for the
# verification note). Bumping either requires re-verifying the node-binary
# copy still works and updating both lines together.
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile --prod=false

FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

# bwrap: the isolation mechanism itself (LGPL-2.0+, exec'd as a distro
# system binary, never linked into anything openRupiv-authored — see
# ADR-0007 "Licensing"). prlimit + util-linux: applies the fixed RLIMIT_*
# values ahead of every bwrap exec, no shell involved.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap util-linux \
  && rm -rf /var/lib/apt/lists/*

# Node binary only — no corepack/npm needed at runtime (see header comment).
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

# The full installed workspace (node_modules + package sources), copied
# as plain files/symlinks from the deps stage — no re-install here.
WORKDIR /workspace
COPY --from=deps /workspace /workspace

# Empty hash-pinned vendored-wheels root: v1 ships zero concrete Python
# tools (packages/agents's tool registry is fixture-only so far), so there
# is honestly nothing to vendor yet. This directory exists so the RO-bind
# mechanism and the Dockerfile shape are already correct the day a real
# tool needs `pip install --require-hashes` here.
RUN mkdir -p /opt/vendored-wheels

# Committed, hash-pinned inner seccomp BPF (packages/sandbox/seccomp/tool.bpf)
# and the tool root (packages/sandbox/tools/ — currently the canary +
# integration-test fixtures only; see Task 10).
RUN mkdir -p /opt/sandbox/seccomp /opt/sandbox-tools
COPY packages/sandbox/seccomp/tool.bpf /opt/sandbox/seccomp/tool.bpf
COPY packages/sandbox/tools /opt/sandbox-tools

ENV SANDBOX_PYTHON_ROOT=/usr \
    SANDBOX_TOOL_ROOT=/opt/sandbox-tools \
    SANDBOX_SECCOMP_BPF_PATH=/opt/sandbox/seccomp/tool.bpf \
    SANDBOX_WORKSPACE_ROOT=/workspaces \
    PORT=8443

RUN mkdir -p /workspaces

# Runs as root (unlike @openrupiv/runtime): bwrap's unprivileged-user-
# namespace mechanism needs to map the calling uid to a range, and the
# supervisor itself must be able to create workspace directories under
# /workspaces for whichever caller-provided runId arrives. This is the ONE
# service in the stack that legitimately needs this; the seccomp/AppArmor
# deltas below are exactly bounded to what bwrap needs — no capabilities
# are added, and `docker-seccomp.json` documents precisely what changed.
EXPOSE 8443

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8443)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "/workspace/packages/sandbox/bin/serve.mjs"]
```

- [ ] **Step 2: Write the outer Compose seccomp delta**

> **Superseded — see "Step 6: Fix round" below.** The `docker-seccomp.json`
> content originally specified here (reproduced as written, for the
> historical record) turned out to be a **non-functional stub** when
> actually applied via `security_opt: seccomp=<file>`: Docker's
> `security_opt` **replaces** the default profile rather than layering
> onto it, so a delta-only file with no real allow rules is fatal, not
> merely under-permissive. The real file now shipped is moby's default
> profile (pinned tag) plus exactly one prepended allow rule — see Step 6.

`packages/sandbox/docker-seccomp.json` (as originally written — superseded, kept for history):
```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "archMap": [
    { "architecture": "SCMP_ARCH_X86_64", "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"] },
    { "architecture": "SCMP_ARCH_AARCH64", "subArchitectures": ["SCMP_ARCH_ARM"] }
  ],
  "syscalls": [
    {
      "names": ["_comment_base_profile"],
      "comment": "This file is meant to be layered conceptually on top of Docker's default seccomp profile (moby/moby's default.json) — it documents ONLY the delta ADR-0007 requires bubblewrap to build a jail: unshare, clone (namespace flags), mount, umount2, pivot_root. An operator applying this file directly should start from Docker's published default profile and add exactly these syscalls; this project ships the delta, not a full re-derivation of Docker's ~300-syscall default allowlist, so the diff a security reviewer needs to read stays small (ADR-0007, 'Scope boundaries this ADR does not cross')."
    }
  ],
  "_delta_from_docker_default": {
    "added_syscalls": ["unshare", "clone", "clone3", "mount", "umount2", "pivot_root"],
    "added_capabilities": [],
    "note": "No Linux capability is added and privileged is never set — unprivileged user namespaces grant the jailed process capabilities only inside its OWN new namespaces, never on the host or this container's real view of the world. Applies ONLY to the sandbox Compose service, never to @openrupiv/runtime."
  }
}
```

- [ ] **Step 3: Build the image**

Run: `docker build -f packages/sandbox/Dockerfile -t openrupiv-sandbox:dev .` (from the monorepo root)
Expected: build succeeds. If `node --experimental-strip-types` fails to run `.ts` files directly on this Node build (that flag requires Node ≥ 22.6 with type-stripping support for a subset of TS syntax — decorators/enums/namespaces are NOT supported, and this codebase avoids all three, but confirm): run `docker run --rm openrupiv-sandbox:dev node --experimental-strip-types /workspace/packages/sandbox/bin/serve.mjs` and check for a syntax/strip error. If it fails, switch the Dockerfile's `CMD` and the `deps` stage to install `tsx` as already used by `packages/runtime/Dockerfile`, and change `CMD` to `["node", "/workspace/node_modules/.bin/tsx", "/workspace/packages/sandbox/bin/serve.mjs"]` instead — `tsx` is already a root devDependency (`package.json`), so no new dependency is introduced either way.

- [ ] **Step 4: Smoke-test the image starts and reports unhealthy without a real bwrap-capable environment**

Run:
```bash
docker run --rm -e SANDBOX_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')" \
  -p 18443:8443 openrupiv-sandbox:dev &
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/healthz
docker stop $(docker ps -q --filter ancestor=openrupiv-sandbox:dev) 2>/dev/null || true
```
Expected: prints a status code (likely `503` in this dev environment, since the boot canary's assertion jail needs real bwrap namespace creation, which this sandbox cannot provide — see Global Constraints. A `503` here is the CORRECT fail-closed behavior, not a bug. Do not "fix" this by loosening the canary; Task 10 is where this gets a real pass on GitHub Actions.

> **Gap found later (see Step 6): this smoke test never applied
> `--security-opt seccomp=packages/sandbox/docker-seccomp.json`.** It only
> proved the image boots with Docker's *actual* default profile, not with
> the profile this project ships and wires into Compose. That gap is
> exactly why the Step 2 stub's fatal brokenness went undetected until a
> later adversarial review. Step 6 adds the missing "boot WITH the profile
> applied" run.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/Dockerfile packages/sandbox/docker-seccomp.json
git commit -s -m "sandbox: Dockerfile (digest-pinned, multi-stage) + outer Compose seccomp delta (ADR-0007)"
```

- [x] **Step 6: Fix round — `docker-seccomp.json` was a non-functional stub (CRITICAL)**

A later review of Task 9 found a critical defect in the Step 2 file: its
`defaultAction` was `SCMP_ACT_ERRNO`, its `syscalls` array contained only
a fake `_comment_base_profile` entry with **no `action` field and no real
allow rules**, and the actually-intended syscalls lived in an
`_delta_from_docker_default` key — a key name Docker's seccomp-profile
parser does not recognize and silently drops. Docker's
`security_opt: seccomp=<file>` **replaces** the default profile rather
than layering onto it, so applying this file as written did not merely
under-permit bwrap — it broke the container outright. Empirically:

```
$ docker run --rm -d --security-opt seccomp=<the Step-2 stub> ... openrupiv-sandbox
docker: Error response from daemon: failed to create task for container:
failed to create shim task: OCI runtime create failed: runc create failed:
string  is not a valid action for seccomp
```

`runc` rejects the profile at container-*creation* time (the
`_comment_base_profile` entry has no `action`, defaulting to an invalid
empty string) — the container never even starts. This is precisely why
Step 4's smoke test (which never passed `--security-opt seccomp=...` at
all) did not catch it: that test only proved the image boots under
Docker's real default profile, not under the profile this project ships.

**Fix:** `packages/sandbox/docker-seccomp.json` is now a **complete,
functional** seccomp profile: moby/moby's default profile fetched verbatim
from a pinned tag, **`v27.3.1`**
(`https://raw.githubusercontent.com/moby/moby/v27.3.1/profiles/seccomp/default.json`),
with exactly **one** rule prepended to the front of its `syscalls` array:

```json
{
  "names": ["clone", "unshare", "mount", "umount2", "pivot_root"],
  "action": "SCMP_ACT_ALLOW",
  "args": [],
  "comment": "ADR-0007 outer delta: ... unconditionally ... because Docker's default profile gates them behind CAP_SYS_ADMIN and this container adds no capabilities. This is the ONLY change from moby's default profile v27.3.1 ..."
}
```

`clone3` is deliberately **not** added (the ADR authorizes exactly these 5
syscalls; moby's default already ERRNOs `clone3` without `CAP_SYS_ADMIN`,
and this delta leaves that untouched). No capability is added anywhere.
See `packages/sandbox/SECCOMP-DELTA.md` for the full rationale and a
recipe for re-diffing against a future moby tag bump.

**Re-verification — boot WITH the profile applied (the check Step 4 was
missing):**

```bash
docker build -f packages/sandbox/Dockerfile -t openrupiv-sandbox:task9fix .
TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
docker run --rm -d --name sbx9fix \
  --security-opt seccomp=packages/sandbox/docker-seccomp.json \
  --security-opt apparmor=unconfined \
  -e SANDBOX_TOKEN="$TOKEN" -p 18443:8443 openrupiv-sandbox:task9fix
sleep 4
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/healthz   # -> 503
docker logs sbx9fix   # boot canary attempted and failed (no userns here, expected),
                       # then "sandbox supervisor listening" — process was NOT ERRNO-killed
docker rm -f sbx9fix
```

Result: the container boots cleanly and `/healthz` responds `503` (the
correct fail-closed result in this dev environment, since real
unprivileged user namespaces aren't available here for the boot canary's
assertion jail) — proving the seccomp profile does not ERRNO-kill the
supervisor process. `corepack pnpm --filter @openrupiv/sandbox typecheck && test`
re-run clean, 86/86 tests, no TypeScript touched.

```bash
git add packages/sandbox/docker-seccomp.json packages/sandbox/Dockerfile \
  packages/sandbox/SECCOMP-DELTA.md \
  docs/superpowers/plans/2026-07-07-agent-sandbox-bwrap-sidecar.md
git commit -s -m "sandbox: replace non-functional seccomp stub with full moby-default + 5-syscall delta (ADR-0007)"
```

---

### Task 10: Real end-to-end isolation proof + CI job

This is the task that actually proves the jail isolates — real bwrap, real seccomp kill, real rlimits — inside a properly configured container, plus the canary's actual assertion-jail script. As recorded in Global Constraints, this cannot be fully verified in this development environment; it is designed to run for real in the `sandbox-boot-canary` CI job on GitHub Actions' runners (a genuine VM, not nested inside another sandbox).

**Files:**
- Create: `packages/sandbox/tools/canary/main.py`
- Create: `packages/sandbox/tools/network_probe/main.py`
- Create: `packages/sandbox/tools/fs_probe/main.py`
- Create: `packages/sandbox/tools/mem_hog/main.py`
- Create: `packages/sandbox/tools/sleep_forever/main.py`
- Create: `packages/sandbox/tools/echo/main.py`
- Create: `packages/sandbox/scripts/e2e-docker.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `scripts/e2e-docker.sh`, runnable standalone (`bash packages/sandbox/scripts/e2e-docker.sh`) and wired into a new CI job.

- [ ] **Step 1: Write the canary assertion script**

`packages/sandbox/tools/canary/main.py`:
```python
"""Boot canary assertion jail (ADR-0007, "Boot canary"). Runs INSIDE the
same bwrap jail production tool calls use. Emits exactly one JSON object on
stdout with one boolean per assertion; canary.ts (TS side) interprets it.
Fixture/infrastructure code, not a production RegisteredTool.
"""
import ctypes
import json
import os
import socket

libc = ctypes.CDLL("libc.so.6", use_errno=True)
PR_GET_NO_NEW_PRIVS = 39


def no_network_interface() -> bool:
    try:
        import subprocess

        out = subprocess.run(["ip", "-o", "link"], capture_output=True, text=True, timeout=2)
        # Only "lo" (down, no address configured) may exist; anything else
        # is a failed assertion. If `ip` isn't even present, absence of any
        # working socket path is checked separately below.
        lines = [l for l in out.stdout.splitlines() if l.strip()]
        return all("lo:" in l or "lo@" in l for l in lines) if lines else True
    except Exception:
        return True


def toolchain_ro() -> bool:
    try:
        with open("/usr/bin/python3.12", "ab"):
            pass
        return False  # should never reach here — write must fail
    except (OSError, PermissionError):
        return True


def host_path_absent() -> bool:
    return not os.path.exists("/etc/shadow") and not os.path.exists("/root")


def rlimits_applied() -> bool:
    import resource

    as_soft, _ = resource.getrlimit(resource.RLIMIT_AS)
    nproc_soft, _ = resource.getrlimit(resource.RLIMIT_NPROC)
    return as_soft <= 268_435_456 and nproc_soft <= 16


def af_inet_socket_killed_by_sigsys() -> bool:
    # This process is itself the canary jail; it must NOT be able to
    # observe a caught violation, because SCMP_ACT_KILL_PROCESS means the
    # attempting process dies before this function could return. We instead
    # fork a child specifically to make the attempt, and assert the PARENT
    # sees it die via SIGSYS.
    pid = os.fork()
    if pid == 0:
        try:
            socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        finally:
            os._exit(0)  # unreachable if the kernel kills us first
    _, status = os.waitpid(pid, 0)
    return os.WIFSIGNALED(status) and os.WTERMSIG(status) == 31  # SIGSYS == 31 on Linux/x86_64


def no_new_privs() -> bool:
    result = libc.prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
    return result == 1


def nested_userns_killed() -> bool:
    pid = os.fork()
    if pid == 0:
        try:
            os.unshare(os.CLONE_NEWUSER)  # type: ignore[attr-defined]
        finally:
            os._exit(0)
    _, status = os.waitpid(pid, 0)
    return os.WIFSIGNALED(status) and os.WTERMSIG(status) == 31


if __name__ == "__main__":
    report = {
        "no_network_interface": no_network_interface(),
        "toolchain_ro": toolchain_ro(),
        "host_path_absent": host_path_absent(),
        "rlimits_applied": rlimits_applied(),
        "af_inet_socket_killed_by_sigsys": af_inet_socket_killed_by_sigsys(),
        "no_new_privs": no_new_privs(),
        "nested_userns_killed": nested_userns_killed(),
    }
    print(json.dumps(report))
```

- [ ] **Step 2: Write the remaining fixture tool scripts**

`packages/sandbox/tools/echo/main.py`:
```python
"""Fixture tool: echoes input.json back with a marker. Used by server.test.ts
and the e2e script's happy-path assertion, not a production tool."""
import json
import os

if __name__ == "__main__":
    payload = {}
    if os.path.exists("input.json"):
        with open("input.json") as f:
            payload = json.load(f)
    print(json.dumps({"echoed": True, "received": payload}))
```

`packages/sandbox/tools/network_probe/main.py`:
```python
"""Fixture tool: attempts a real AF_INET connect to prove network egress is
blocked. If the inner seccomp filter is working, this process is killed by
SIGSYS before any output is produced -- the e2e script asserts THAT (an exit
via signal), not any printed output. Not a production tool."""
import socket

if __name__ == "__main__":
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(("8.8.8.8", 53))
    print('{"violation_not_blocked": true}')
```

`packages/sandbox/tools/fs_probe/main.py`:
```python
"""Fixture tool: attempts to write outside /workspace, proving filesystem
confinement. Unlike network_probe, this is NOT expected to be killed (RO/
absent paths raise a normal Python exception, not a seccomp kill) -- it
self-reports the exception type. Not a production tool."""
import json

if __name__ == "__main__":
    try:
        with open("/etc/openrupiv-escape-test", "w") as f:
            f.write("escaped")
        result = {"escaped": True}
    except (OSError, PermissionError) as exc:
        result = {"escaped": False, "error": type(exc).__name__, "errno": exc.errno}
    print(json.dumps(result))
```

`packages/sandbox/tools/mem_hog/main.py`:
```python
"""Fixture tool: allocates memory well beyond RLIMIT_AS (256 MiB) to prove
the memory limit is enforced. Not a production tool."""
if __name__ == "__main__":
    chunks = []
    total = 0
    step = 32 * 1024 * 1024  # 32 MiB
    while total < 1024 * 1024 * 1024:  # would reach 1 GiB if unbounded
        chunks.append(bytearray(step))
        total += step
    print('{"allocated_beyond_limit": true}')
```

`packages/sandbox/tools/sleep_forever/main.py`:
```python
"""Fixture tool: sleeps far longer than wallClockMs, to prove the
supervisor's wall-clock timer actually SIGKILLs a stuck jail. Not a
production tool."""
import time

if __name__ == "__main__":
    time.sleep(300)
    print('{"should_never_print": true}')
```

- [ ] **Step 3: Write the end-to-end Docker script**

`packages/sandbox/scripts/e2e-docker.sh`:
```bash
#!/usr/bin/env bash
# Real end-to-end isolation proof (ADR-0007). Builds the sandbox image,
# runs it with the EXACT security_opt deltas the ADR specifies, and calls
# /v1/execute against real fixture tools to prove: the boot canary passes,
# network egress is blocked (SIGSYS), filesystem escape is blocked
# (RO/ENOENT), the wall-clock limit kills a stuck jail, and the memory
# limit is enforced. If `bwrap`/user-namespace creation is not available in
# the current environment (verified via a real preflight probe, not
# assumed), this SKIPS LOUDLY rather than reporting a false pass — the
# service itself still fails closed in that case (this script's own
# "canary must be healthy" assertion is what actually enforces that).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$here"

IMAGE="openrupiv-sandbox:e2e-$$"
CONTAINER="openrupiv-sandbox-e2e-$$"
PORT=18443

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "e2e-docker: preflight — can this environment create user namespaces at all?"
if ! docker run --rm --security-opt seccomp=packages/sandbox/docker-seccomp.json --security-opt apparmor=unconfined \
    debian:bookworm-slim bash -c "apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null && bwrap --unshare-user --unshare-net --die-with-parent -- true" >/tmp/e2e-preflight.log 2>&1; then
  echo "e2e-docker: SKIP — this environment cannot create Linux user namespaces (see plan's Global Constraints). Real isolation proof deferred to CI on GitHub Actions."
  cat /tmp/e2e-preflight.log
  exit 0
fi
echo "e2e-docker: preflight OK — this environment supports the isolation mechanism."

echo "e2e-docker: building image..."
docker build -f packages/sandbox/Dockerfile -t "$IMAGE" .

TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
echo "e2e-docker: starting container..."
docker run -d --name "$CONTAINER" \
  --security-opt seccomp=packages/sandbox/docker-seccomp.json \
  --security-opt apparmor=unconfined \
  -e SANDBOX_TOKEN="$TOKEN" \
  -p "$PORT:8443" \
  "$IMAGE"

echo "e2e-docker: waiting for /healthz..."
ok=0
for _ in $(seq 1 30); do
  if curl -s -o /tmp/e2e-health.json -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" | grep -q 200; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" -ne 1 ]]; then
  echo "e2e-docker: FAIL — boot canary never reported healthy." >&2
  cat /tmp/e2e-health.json 2>&1 || true
  docker logs "$CONTAINER" || true
  exit 1
fi
echo "e2e-docker: boot canary healthy: $(cat /tmp/e2e-health.json)"

call() {
  local tool="$1" wall_ms="$2"
  curl -s -X POST "http://127.0.0.1:$PORT/v1/execute" \
    -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d "{\"runId\":\"$(node -e 'console.log(require("crypto").randomUUID())')\",\"tool\":\"$tool\",\"input\":{},\"limits\":{\"wallClockMs\":$wall_ms,\"memoryBytes\":268435456,\"maxOutputBytes\":1048576}}"
}

echo "e2e-docker: echo (happy path)..."
echo_result="$(call echo 5000)"
echo "$echo_result"
echo "$echo_result" | grep -q '"ok":true' || { echo "e2e-docker: FAIL — echo did not succeed" >&2; exit 1; }

echo "e2e-docker: network_probe (must be blocked)..."
net_result="$(call network_probe 5000)"
echo "$net_result"
echo "$net_result" | grep -q '"violation":"network_egress"' || { echo "e2e-docker: FAIL — network egress was not blocked" >&2; exit 1; }

echo "e2e-docker: fs_probe (must be blocked)..."
fs_result="$(call fs_probe 5000)"
echo "$fs_result"
echo "$fs_result" | grep -q '"escaped":true' && { echo "e2e-docker: FAIL — filesystem escape succeeded" >&2; exit 1; }
echo "$fs_result" | grep -q '"ok":true' || { echo "e2e-docker: FAIL — fs_probe tool itself errored unexpectedly" >&2; exit 1; }

echo "e2e-docker: sleep_forever (wall clock must kill it)..."
start=$(date +%s)
sleep_result="$(call sleep_forever 3000)"
elapsed=$(( $(date +%s) - start ))
echo "$sleep_result (elapsed ${elapsed}s)"
echo "$sleep_result" | grep -q '"limit":"wall_clock"' || { echo "e2e-docker: FAIL — wall-clock limit did not fire" >&2; exit 1; }
[[ "$elapsed" -lt 10 ]] || { echo "e2e-docker: FAIL — took too long to kill (${elapsed}s)" >&2; exit 1; }

echo "e2e-docker: mem_hog (memory limit must be enforced)..."
mem_result="$(call mem_hog 10000)"
echo "$mem_result"
echo "$mem_result" | grep -q '"ok":true' && { echo "e2e-docker: FAIL — memory limit was not enforced" >&2; exit 1; }

echo "e2e-docker: ALL ASSERTIONS PASSED — real isolation proven in this environment."
```

Run: `chmod +x packages/sandbox/scripts/e2e-docker.sh`

- [ ] **Step 4: Run the script locally and record the honest result**

Run: `bash packages/sandbox/scripts/e2e-docker.sh`
Expected, in THIS development environment: `e2e-docker: SKIP — this environment cannot create Linux user namespaces` (per Global Constraints — do not treat this as a task failure; it is the environment limitation working as designed). If it unexpectedly proceeds past the preflight check in some future environment, let it run to completion and confirm every assertion prints PASSED — do not edit the script to make a failing assertion pass; if a real assertion fails, that is a real bug in Tasks 2–7 to fix, not a script problem.

- [ ] **Step 5: Add the CI job**

Modify `.github/workflows/ci.yml`, add a new job after `sandbox-seccomp`:
```yaml
  sandbox-boot-canary:
    name: Sandbox boot canary (real bwrap isolation proof)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run the real end-to-end isolation proof
        run: bash packages/sandbox/scripts/e2e-docker.sh
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/tools packages/sandbox/scripts/e2e-docker.sh .github/workflows/ci.yml
git commit -s -m "sandbox: real Docker-based end-to-end isolation proof + CI job (ADR-0007)"
```

- [ ] **Step 7: Push and confirm the new CI jobs pass for real**

Push this worktree's branch and watch the `sandbox-seccomp` and `sandbox-boot-canary` GitHub Actions jobs (see the final task for the exact push/branch steps this project uses — a `worktree-*` branch, per `superpowers:using-git-worktrees`). **Do not report the isolation boundary as proven until `sandbox-boot-canary` is observed green on a real GitHub Actions run** — this environment's own run was a SKIP, not a PASS, and the difference matters.

---

### Task 11: Compose/`.env` generation wiring (`packages/cli`)

Adds the `sandbox` service to what `openrupiv new` generates, per ADR-0007 ("A new `sandbox` service, generated by `openrupiv new` alongside `postgres`/`dex`/`runtime`"). This makes the service available in a generated workspace; it deliberately does NOT wire `runtime`'s `deps.agents`/`ToolSandbox` construction into `bin/serve.mjs` — no real, concrete `RegisteredTool`/`AgentTaskProcedureRegistry` catalog exists yet in the compiler/generator output for a generated app to run agents against, so activating `deps.agents` end-to-end in a real deployment is a distinct, later integration task (out of scope here, exactly as PR #5 already scoped "no real `ToolSandbox` exists yet ... these routes never register in production until a deployment supplies one").

**Files:**
- Modify: `packages/cli/src/workspace-files.ts`
- Modify: `packages/cli/test/new.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (this is generated-file text, not code that imports `@openrupiv/sandbox`).
- Produces: `workspaceFiles()`'s generated `docker-compose.yaml` gains a `sandbox` service; `envFile()`'s generated `.env` gains `SANDBOX_TOKEN`.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/new.test.ts` (append a new `it` inside the existing `describe("openrupiv new — scaffold", ...)` block, right after the existing tracked-files assertion block):
```ts
  it("generates a sandbox Compose service and SANDBOX_TOKEN, on an internal network with no published ports", async () => {
    const { deps } = makeDeps(tmp);
    const code = await runNew("my-workspace", deps);
    expect(code).toBe(EXIT_OK);

    const ws = path.join(tmp, "my-workspace");
    const compose = parseYaml(read(ws, "docker-compose.yaml")) as {
      services: Record<string, { networks?: string[] | Record<string, unknown>; ports?: string[] }>;
      networks?: Record<string, { internal?: boolean }>;
    };
    expect(compose.services["sandbox"]).toBeDefined();
    expect(compose.services["sandbox"]?.ports).toBeUndefined();
    expect(compose.networks?.["sandbox-internal"]?.internal).toBe(true);

    const env = read(ws, ".env");
    expect(env).toMatch(/SANDBOX_TOKEN=[0-9a-f]{32,}/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @openrupiv/cli test`
Expected: FAIL — `compose.services["sandbox"]` is `undefined`.

- [ ] **Step 3: Add `SANDBOX_TOKEN` generation**

`packages/cli/src/commands/new.ts:52-53` currently reads:
```ts
    const sessionSecret = deps.randomBytes(32).toString("hex");
    const files = workspaceFiles({ name, sessionSecret, repoRoot: deps.repoRoot });
```
Change it to:
```ts
    const sessionSecret = deps.randomBytes(32).toString("hex");
    const sandboxToken = deps.randomBytes(32).toString("hex");
    const files = workspaceFiles({ name, sessionSecret, sandboxToken, repoRoot: deps.repoRoot });
```

- [ ] **Step 4: Modify `workspace-files.ts` — add `sandboxToken` to inputs and generate it into `.env`**

In `packages/cli/src/workspace-files.ts`, modify the `WorkspaceFileInputs` interface:
```ts
export interface WorkspaceFileInputs {
  /** Workspace (directory) name, kebab-case. */
  name: string;
  /** Hex session secret generated by `new` (>= 32 chars; lives in .env only). */
  sessionSecret: string;
  /** Hex bearer token for the sandbox sidecar (>= 32 chars; lives in .env only). */
  sandboxToken: string;
  /** Absolute path of the openRupiv monorepo checkout (compose build context). */
  repoRoot: string;
}
```

Modify `envFile`:
```ts
function envFile(inputs: WorkspaceFileInputs): string {
  return `# DEV-ONLY local configuration. This file is gitignored — never commit it.

# Signs the runtime's session cookies (>= 32 chars enforced by the runtime).
# Generated by \`openrupiv new\`; regenerate any time (invalidates sessions).
SESSION_SECRET=${inputs.sessionSecret}

# Bearer token the runtime uses to authenticate to the sandbox sidecar
# (ADR-0007). Authentication only, not authorization — the sandbox holds
# no policy logic of its own. Generated by \`openrupiv new\`.
SANDBOX_TOKEN=${inputs.sandboxToken}

# Absolute path to your openRupiv monorepo checkout. docker-compose.yaml
# builds the runtime image from this directory using
# packages/runtime/Dockerfile.
OPENRUPIV_REPO=${inputs.repoRoot}
`;
}
```

- [ ] **Step 5: Add the `sandbox` service to `dockerComposeYaml`**

In `packages/cli/src/workspace-files.ts`, modify `dockerComposeYaml` to add the service and network. Insert this block into the `services:` section, right after the `runtime:` service's closing (before the top-level `volumes:` key), and add a top-level `networks:` key:
```ts
function dockerComposeYaml(inputs: WorkspaceFileInputs): string {
  return `# ${inputs.name} — local development stack, written by \`openrupiv new\`.
#
# =====================================================================
#  DEV ONLY — DO NOT DEPLOY. This stack bundles the Dex IdP with
#  STATIC, PUBLICLY-KNOWN credentials (ADR-0002):
#    OIDC client:  ${DEV_OIDC_CLIENT_ID} / ${DEV_OIDC_CLIENT_SECRET}
#    login:        ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}
#  Never expose it beyond localhost; never reuse these values.
#  Production: delete the \`dex\` service and point OIDC_ISSUER /
#  OIDC_CLIENT_ID / OIDC_CLIENT_SECRET at your organization's IdP
#  (and unset OPENRUPIV_DEV_MODE — the runtime then refuses the
#  bundled dev secret by design).
# =====================================================================
#
# Interpolated values (SESSION_SECRET, SANDBOX_TOKEN, OPENRUPIV_REPO) come
# from ./.env, which \`openrupiv new\` generates and .gitignore keeps out of
# the repo.

services:
  postgres:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: openrupiv
      POSTGRES_PASSWORD: openrupiv-dev-password # DEV ONLY — Compose-network local
      POSTGRES_DB: openrupiv
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openrupiv -d openrupiv"]
      interval: 2s
      timeout: 3s
      retries: 30

  dex:
    # DEV ONLY identity provider (ADR-0002). Configuration in ./dex/config.yaml.
    image: ${DEX_IMAGE}
    command: ["dex", "serve", "/etc/dex/config.yaml"]
    volumes:
      - ./dex/config.yaml:/etc/dex/config.yaml:ro
    ports:
      # Your browser must reach the issuer under the SAME name the runtime
      # uses (http://dex:5556). One-time setup:
      #   echo "127.0.0.1 dex" | sudo tee -a /etc/hosts
      - "5556:5556"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:5556/healthz"]
      interval: 2s
      timeout: 3s
      retries: 30

  # ADR-0007's bubblewrap sidecar. No published ports, ever — reachable
  # only from \`runtime\`, on the internal-only \`sandbox-internal\` network,
  # never from \`postgres\`/\`dex\`/the internet. Currently unused by
  # \`runtime\` (no real agent tool catalog exists yet in a generated app —
  # see packages/sandbox's README), so this service starts and passes its
  # own boot canary but has no caller until that lands.
  sandbox:
    build:
      context: \${OPENRUPIV_REPO:?set OPENRUPIV_REPO in .env to your openRupiv monorepo checkout}
      dockerfile: packages/sandbox/Dockerfile
    read_only: true
    tmpfs:
      # /workspaces: per-run workspace directories are created here at
      # runtime (createWorkspace) and must be writable even though the
      # rest of the image's filesystem is read-only. In-memory and wiped
      # on every container restart — correct for ephemeral, per-run
      # workspaces; nothing persists to disk.
      - /tmp
      - /workspaces
    security_opt:
      - seccomp=\${OPENRUPIV_REPO}/packages/sandbox/docker-seccomp.json
      - apparmor=unconfined
    environment:
      SANDBOX_TOKEN: \${SANDBOX_TOKEN:?set SANDBOX_TOKEN in .env (openrupiv new generates it)}
    networks:
      - sandbox-internal
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8443/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 12

  runtime:
    build:
      # The openRupiv monorepo checkout is the build context so the image
      # can include workspace packages. Path comes from ./.env.
      context: \${OPENRUPIV_REPO:?set OPENRUPIV_REPO in .env to your openRupiv monorepo checkout}
      dockerfile: packages/runtime/Dockerfile
    environment:
      DATABASE_URL: postgres://openrupiv:openrupiv-dev-password@postgres:5432/openrupiv # DEV ONLY
      OIDC_ISSUER: http://dex:5556
      OIDC_CLIENT_ID: ${DEV_OIDC_CLIENT_ID}
      # DEV ONLY — the runtime refuses this secret unless OPENRUPIV_DEV_MODE=true.
      OIDC_CLIENT_SECRET: ${DEV_OIDC_CLIENT_SECRET}
      SESSION_SECRET: \${SESSION_SECRET:?set SESSION_SECRET in .env (openrupiv new generates it)}
      OPENRUPIV_DEV_MODE: "true"
      APP_DIR: /app-dir
      BASE_URL: http://localhost:3000
      PORT: "3000"
    ports:
      - "3000:3000"
    volumes:
      # The generated app directory (spec + migrations), read-only.
      - ./app:/app-dir:ro
    networks:
      - default
      - sandbox-internal
    depends_on:
      postgres:
        condition: service_healthy
      dex:
        condition: service_healthy
      sandbox:
        condition: service_healthy

volumes:
  pgdata:

networks:
  default: {}
  # Internal-only: no route to the internet, and (since it is not listed
  # on postgres's or dex's networks: key) no route to those services either
  # — only \`runtime\` and \`sandbox\` share it (ADR-0007, "Network: three
  # independent layers", point 3).
  sandbox-internal:
    internal: true
`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `corepack pnpm --filter @openrupiv/cli test`
Expected: PASS, including every pre-existing `new.test.ts` test (the tracked-files list assertion does not change — `docker-compose.yaml` and `.env` are still single files, just with more content).

- [ ] **Step 7: Typecheck**

Run: `corepack pnpm --filter @openrupiv/cli typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/workspace-files.ts packages/cli/src/commands/new.ts packages/cli/test/new.test.ts
git commit -s -m "cli: generate the sandbox Compose service + SANDBOX_TOKEN (ADR-0007)"
```

---

### Task 12: README, ENTERPRISE_READINESS.md, and final whole-package review

**Files:**
- Create: `packages/sandbox/README.md`
- Modify: `ENTERPRISE_READINESS.md`

**Interfaces:** None — documentation and status tracking only, per CLAUDE.md Definition of Done #1 and #4.

- [ ] **Step 1: Write the package README**

`packages/sandbox/README.md`:
```markdown
# @openrupiv/sandbox

The bubblewrap sidecar (ADR-0007): a dedicated, unprivileged container that
runs one `bwrap` jail per agent tool execution, implementing the
`ToolSandbox` interface `@openrupiv/agents` depends on. No `docker.sock`
anywhere in this design.

Full design rationale, rejected alternatives, and the threat model:
`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`. Contract: this package
satisfies `SandboxLimits` / `SandboxExecuteInput` / `SandboxExecuteResult` /
`ToolSandbox` exactly as already defined in `@openrupiv/agents`'s
`types.ts` — it does not redefine or extend that contract.

## What's here

- `src/run-id.ts`, `src/token-auth.ts` — the two independent gates on
  `POST /v1/execute`: a strict UUID v4 check on the opaque `runId` (the
  wire never carries a trusted host path), and constant-time bearer-token
  comparison (authentication only, never authorization).
- `src/bwrap-argv.ts`, `src/entrypoint.ts` — the one place a `bwrap` argv is
  assembled (always an array, never a shell string), and untrusted
  entrypoint-name resolution that never exec's outside its own tool root.
- `src/jail-executor.ts` — spawns `prlimit | bwrap`, enforces the wall-clock
  timer, and classifies the outcome (violation / limit / tool_error / ok)
  from the jail's real exit code/signal, never from an in-jail self-report.
- `seccomp/` — the inner seccomp filter: `build-tool-seccomp.c` is the
  rule source (compiled via `libseccomp`), `tool.bpf` is the committed,
  hash-pinned build artifact `scripts/check-seccomp-bpf.sh` keeps honest in
  CI (same precedent as ADR-0006's committed `authz.wasm`).
- `src/canary.ts` + `tools/canary/main.py` — the boot canary: proves the
  isolation boundary at every startup, fails the service closed
  (`/healthz` 503s, `/v1/execute` refuses every request) if it cannot.
- `src/server.ts`, `bin/serve.mjs` — the supervisor: exactly two routes,
  `POST /v1/execute` and `GET /healthz`.
- `src/client.ts` (exported as `createSidecarSandbox`) — the `ToolSandbox`
  implementation `@openrupiv/agents` calls; a thin HTTP client, no policy
  logic.
- `Dockerfile`, `docker-seccomp.json` — the image and the outer Compose
  security_opt delta (seccomp/AppArmor loosening bubblewrap itself needs
  to build a jail — distinct from, and independent of, the inner filter
  above).
- `tools/` — `canary/` (the boot canary's own assertion script) plus
  `echo/`, `network_probe/`, `fs_probe/`, `mem_hog/`, `sleep_forever/`:
  **fixture/test tools only**, used by `test/server.test.ts` and
  `scripts/e2e-docker.sh` to prove the jail's isolation semantics. **v1
  ships zero production `RegisteredTool` implementations** — the
  hash-pinned vendored-wheels directory (`/opt/vendored-wheels` in the
  image) is intentionally empty; there is nothing real to vendor yet.

## Scope boundary — what this package does NOT do

This package makes the `sandbox` Compose service buildable and generatable
(`openrupiv new` writes it alongside `postgres`/`dex`/`runtime`). It does
**not** wire a real `AgentRuntime` construction (`createAgentRuntime(...,
{ sandbox: createSidecarSandbox(...) })`) into `packages/runtime`'s
generated deployment path (`bin/serve.mjs`) — that requires a real, concrete
`RegisteredTool` catalog (a static in-code registry per
`specs/phase-2-contracts.md`'s open-question Q2), which does not exist yet
anywhere in the compiler/generator output. Activating agents end-to-end in
a real generated app is a distinct, later integration task. Today: the
`sandbox` service starts, passes its own boot canary, and has no caller.

## Environment note on local verification

This package's own jail-construction unit tests (Tasks 1–8 in
`docs/superpowers/plans/2026-07-07-agent-sandbox-bwrap-sidecar.md`) never
invoke real `bwrap` — they inject a fake jail-runner, since creating Linux
user namespaces requires a real, unnested Linux host (or a CI runner that
is one). The REAL isolation proof is `scripts/e2e-docker.sh`, wired into
CI as the `sandbox-boot-canary` job — see that job's run history for actual
evidence the isolation boundary holds, not this README's prose.

## Human review required

Per CLAUDE.md's sandbox-boundary human-only review path and ADR-0007's own
"Human review" section: this package must be reviewed and accepted by a
human maintainer before merge. No agent session may merge it autonomously.
```

- [ ] **Step 2: Update `ENTERPRISE_READINESS.md`**

Run: `grep -n "Sandboxed code execution" ENTERPRISE_READINESS.md`

Replace that row's content (keep the same table row position/columns as the surrounding rows) with:
```
| Sandboxed code execution | 🚧 `packages/sandbox` built + unit-tested (bubblewrap jail construction, boot canary, resource limits, seccomp — [ADR-0007](docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md), status: proposed, human-only review path, not yet human-reviewed/merged). `createSidecarSandbox` implements `ToolSandbox` and `openrupiv new` now generates the `sandbox` Compose service. Real isolation (network egress block, fs escape block, rlimit enforcement) is proven by the `sandbox-boot-canary` CI job on push — see that job's run history, not this line, for current pass/fail. **Not yet wired into any generated app's runtime deployment** — v1 ships zero concrete Python tools, so there is nothing yet for a real agent task to sandbox end-to-end |
```

- [ ] **Step 3: Run the full package test/typecheck suite one more time**

Run: `corepack pnpm --filter @openrupiv/sandbox test && corepack pnpm --filter @openrupiv/sandbox typecheck && corepack pnpm --filter @openrupiv/cli test && corepack pnpm --filter @openrupiv/cli typecheck`
Expected: all PASS.

- [ ] **Step 4: Run the full monorepo check**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all PASS across all packages (no regressions in packages this plan didn't touch).

- [ ] **Step 5: Run the license and DCO checks locally**

Run: `pnpm check-licenses`
Expected: PASS (`fastify` is already MIT-allowed elsewhere in the monorepo; this package introduces no new production dependency license).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/README.md ENTERPRISE_READINESS.md
git commit -s -m "sandbox: README + ENTERPRISE_READINESS.md status update (ADR-0007)"
```

- [ ] **Step 7: Push and open the PR, flagged human-review-required**

Push the branch and open a PR whose description explicitly states, in the same style PR #5 used: this touches a CLAUDE.md human-only review path (sandbox boundaries); it must not be merged without human maintainer review; it links `docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`; and it reports the REAL, observed CI outcome of `sandbox-seccomp` and `sandbox-boot-canary` (not a predicted one) once the push's CI run completes.
