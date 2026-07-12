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
