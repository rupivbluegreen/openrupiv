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
