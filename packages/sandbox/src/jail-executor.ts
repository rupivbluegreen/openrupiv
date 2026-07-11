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
import { openSync } from "node:fs";
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

function looksLikeFsEscape(stderrText: string): boolean {
  return /read-only file system|errno 30|errno 2\b|no such file or directory|permission denied/i.test(
    stderrText,
  );
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
  });
}
