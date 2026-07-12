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

  let realToolRoot: string;
  let realCandidate: string;
  try {
    realToolRoot = realpathSync(toolRoot);
    realCandidate = realpathSync(candidate);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new EntrypointResolutionError(
      entrypoint,
      `failed to canonicalize resolved path: ${reason}`,
    );
  }

  const relative = path.relative(realToolRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EntrypointResolutionError(
      entrypoint,
      "resolved path escapes toolRoot",
    );
  }

  return realCandidate;
}
