/**
 * Canonicalization + digesting for tool-call input/output. Per
 * specs/phase-2-contracts.md §4, audit attributes must NEVER carry a raw
 * input/output value -- only a sha256 digest and byte size of a
 * CANONICALIZED value.
 *
 * This mirrors @openrupiv/audit's `canonicalize` algorithm (recursively
 * sorted object keys, no incidental whitespace, arrays keep order) but is a
 * separate, local implementation rather than a reuse of that export:
 * audit's `canonicalize` takes an `AuditRecordBody` -- the full hashed
 * record (`seq`, `timestamp`, `prevHash`, `event`, `actor`, ...) -- not an
 * arbitrary JSON value, so it does not structurally fit hashing a tool's
 * `input`/`output` payload. Reimplementing the same small, pure algorithm
 * here (rather than force-fitting audit's shape with placeholder fields)
 * keeps this package's dependency on @openrupiv/audit's hashing surface
 * limited to `appendInTransaction` (see runtime.ts).
 */
import { createHash } from "node:crypto";

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = canonicalizeValue(v);
    }
    return sorted;
  }
  return value;
}

/** sha256 digest + byte size of a canonicalized JSON value. */
export function digestValue(value: unknown): { digest: string; bytes: number } {
  const canonical = JSON.stringify(canonicalizeValue(value ?? null));
  const bytes = Buffer.byteLength(canonical, "utf8");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { digest, bytes };
}
