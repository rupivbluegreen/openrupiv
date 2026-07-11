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
