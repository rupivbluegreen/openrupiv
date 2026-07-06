/**
 * Canonicalization + digesting helper. Audit attributes for both directions
 * of this package (`mcp.tool_call`/`mcp.tool_result`/`mcp.serve_call`/
 * `mcp.serve_result`) MUST NEVER carry raw tool args or tool content — only a
 * sha256 digest and a byte size, mirroring the digest-not-raw-value pattern
 * the contract points to in `@openrupiv/agents` / `workflows.ts`.
 *
 * This is a small, self-contained canonicalizer (recursively sorted object
 * keys, arrays keep order, no incidental whitespace) rather than a reuse of
 * `@openrupiv/audit`'s `canonicalize`, because that function's signature is
 * pinned to `AuditRecordBody` — it is not a generic "canonicalize any JSON
 * value" utility. The algorithm is intentionally identical in spirit.
 */

import { createHash } from "node:crypto";

export interface ValueDigest {
  sha256: string;
  bytes: number;
}

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canon(child);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON serialization: sorted object keys, arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value ?? null));
}

/** sha256 + byte size of the canonical serialization of `value`. Never the raw value itself. */
export function digestValue(value: unknown): ValueDigest {
  const json = canonicalJson(value);
  return {
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
    bytes: Buffer.byteLength(json, "utf8"),
  };
}
