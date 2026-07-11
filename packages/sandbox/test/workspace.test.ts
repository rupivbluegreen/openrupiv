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
