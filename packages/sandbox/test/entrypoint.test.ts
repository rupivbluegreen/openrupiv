import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntrypointResolutionError, resolveEntrypoint } from "../src/entrypoint";

describe("resolveEntrypoint", () => {
  let toolRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    toolRoot = await mkdtemp(path.join(tmpdir(), "sandbox-tools-"));
    await mkdir(path.join(toolRoot, "echo"), { recursive: true });
    await writeFile(path.join(toolRoot, "echo", "main.py"), "# fixture\n");

    outsideRoot = await mkdtemp(path.join(tmpdir(), "sandbox-outside-"));
    await mkdir(path.join(outsideRoot, "outside"), { recursive: true });
    await writeFile(path.join(outsideRoot, "outside", "main.py"), "# fixture\n");
  });

  afterEach(async () => {
    await rm(toolRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
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

  it("rejects an entrypoint name containing path separators via the bare-name regex", () => {
    expect(() => resolveEntrypoint("echo/../../outside", toolRoot)).toThrow(
      EntrypointResolutionError,
    );
  });

  it("rejects a bare-name entrypoint that is a symlink escaping toolRoot via realpath containment", () => {
    // "escape" is a bare name (passes BARE_NAME_PATTERN) whose main.py exists
    // via the symlink, so this genuinely reaches the realpath canonicalization
    // + containment check rather than being rejected by the regex.
    const outsideDir = path.join(outsideRoot, "outside");
    symlinkSync(outsideDir, path.join(toolRoot, "escape"));

    expect(() => resolveEntrypoint("escape", toolRoot)).toThrow(EntrypointResolutionError);
  });
});
