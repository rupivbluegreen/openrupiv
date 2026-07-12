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

// RLIMIT_NPROC is enforced per REAL uid, and the supervisor now runs as a
// non-root user (Dockerfile USER 10001) that it SHARES with every jail — so
// this cap counts the supervisor's own ~40-50 node/tsx/esbuild threads too.
// (As root, the previous value of 16 was silently bypassed via
// CAP_SYS_RESOURCE; under the non-root + cap_drop:ALL posture it is strictly
// enforced, and 16 is below the supervisor's own footprint, so bwrap's fork
// to create the jail failed with EAGAIN.) Set it high enough for the
// supervisor plus a bounded per-jail budget. This is therefore a COARSE
// system-pid-exhaustion guard, not a tight per-jail process cap; the real
// per-jail bounds are the wall-clock timer and RLIMIT_AS (memory), which cap
// any fork bomb in both time and memory regardless. A tight per-jail limit
// would require a cgroup pids.max (out of scope; the container is cap-dropped
// and can't manage cgroups).
const RLIMIT_NPROC = 256;
const RLIMIT_CPU_SECONDS = 30;
const RLIMIT_FSIZE_BYTES = 67_108_864;
const RLIMIT_NOFILE = 256;

// The inner seccomp filter kills a disallowed syscall with SIGSYS (signal
// 31). But the process node tracks is `bwrap` (prlimit exec's into it), and
// bwrap does NOT re-raise the inner process's signal on itself — when the
// jailed process is killed by signal N, bwrap reports it by exiting with the
// conventional 128+N status. So a SIGSYS kill of the tool surfaces to the
// supervisor as exit CODE 159 (128+31) with signal===null, NOT as
// signal==="SIGSYS". Both forms must be treated as the same kernel-enforced
// violation, or every real seccomp kill (network egress, nested userns,
// mount, ...) is misclassified as a generic tool_error.
const SIGSYS = 31;
const SIGSYS_EXIT_CODE = 128 + SIGSYS;

// The same 128+signum convention (see SIGSYS note above) applies to the
// kernel-default signal deaths from the RLIMIT_* backstops this module
// itself configures via prlimit, so their outcomes must be classified as
// resource limits rather than falling through to a generic tool_error:
//   RLIMIT_CPU exceeded  -> SIGXCPU (24) -> bwrap exit 152 -> a time limit
//                           (the belt-and-suspenders backstop for the JS
//                           wall-clock timer, mapped to the same subtype)
//   RLIMIT_FSIZE exceeded -> SIGXFSZ (25) -> bwrap exit 153 -> an output/
//                           file-size limit
const SIGXCPU_EXIT_CODE = 128 + 24;
const SIGXFSZ_EXIT_CODE = 128 + 25;

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
      if (signal === "SIGSYS" || code === SIGSYS_EXIT_CODE) {
        resolve({
          ok: false,
          reason: "violation",
          violation: "network_egress",
          message: "process was killed by the inner seccomp filter (SIGSYS)",
          durationMs,
        });
        return;
      }
      if (code === SIGXCPU_EXIT_CODE) {
        resolve({
          ok: false,
          reason: "limit",
          limit: "wall_clock",
          message: `tool exceeded the CPU-time backstop (RLIMIT_CPU=${RLIMIT_CPU_SECONDS}s)`,
          durationMs,
        });
        return;
      }
      if (code === SIGXFSZ_EXIT_CODE) {
        resolve({
          ok: false,
          reason: "limit",
          limit: "output_size",
          message: `tool exceeded the file-size limit (RLIMIT_FSIZE=${RLIMIT_FSIZE_BYTES} bytes)`,
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
