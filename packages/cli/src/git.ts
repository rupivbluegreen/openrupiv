/**
 * Minimal injectable git runner. Commands never shell out (args are passed
 * as an array to `spawn`), always capture stdout/stderr, and surface
 * failures as typed `CliError`s — a git failure is an environment error
 * (exit 4), e.g. a missing binary or an unconfigured identity.
 */

import { spawn } from "node:child_process";
import { CliError } from "./errors";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGit = (args: string[], opts: { cwd: string }) => Promise<ExecResult>;

/**
 * Build the real git runner. `env` is passed through verbatim so git sees
 * the user's own identity and configuration — `openrupiv` commits with the
 * user's identity, never a synthetic one (specs/phase-1.md §2).
 */
export function makeRunGit(env: NodeJS.ProcessEnv): RunGit {
  return (args, { cwd }) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        reject(
          new CliError(
            "ERR_GIT",
            `failed to run git (is git installed and on PATH?): ${error.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/**
 * Run one git command and demand success. On failure, throw a typed
 * environment error carrying git's own diagnostics (e.g. "Please tell me
 * who you are" when no identity is configured).
 */
export async function git(runGit: RunGit, cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, { cwd });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "(no output)";
    throw new CliError(
      "ERR_GIT",
      `git ${args.join(" ")} failed with exit code ${result.code}: ${detail}`,
    );
  }
  return result.stdout;
}
