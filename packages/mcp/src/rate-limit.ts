/**
 * Bounds how often a rejected `/mcp` request durably audits
 * `mcp.serve_rejected` (independent-review finding: unbounded,
 * unrate-limited audit append on every rejected `/mcp` request). This route
 * is mounted publicly (deny-by-default happens INSIDE the handler, via
 * bearer verification, not via a network-level allowlist), so an
 * unauthenticated caller can otherwise grow the tamper-evident audit chain
 * without bound and contend the chain's single global tail lock
 * (`appendInTransaction`'s advisory lock + `FOR UPDATE`), degrading every
 * OTHER audited operation platform-wide.
 *
 * Same two-part algorithm as `@openrupiv/runtime`'s
 * `createRejectedCookieLimiter` (ported here rather than imported, since
 * `@openrupiv/runtime` depends on `@openrupiv/mcp` and not the other way —
 * this package must stay independently usable), adapted for bearer-token
 * values instead of cookie values. Both caps "fail open" toward SKIPPING the
 * durable append, never toward silently dropping observability — callers
 * are expected to keep their own unconditional log/console statement (this
 * limiter only gates the audit-chain write):
 *   - Per-token dedup: the SAME rejected bearer value is audited once per
 *     TTL window, keyed by a hash (never the raw token) so nothing
 *     sensitive is retained in memory.
 *   - A coarser rolling-window cap on NEW distinct rejections, so a caller
 *     who defeats the per-token dedup by varying the (garbage) token on
 *     every request still cannot grow the log unboundedly.
 * Both caches are bounded in memory (capped entries, TTL-expired), so the
 * limiter itself cannot become the unbounded-growth problem it exists to
 * prevent.
 *
 * For the missing-token case there is no credential value to hash — callers
 * should pass a fixed sentinel (e.g. the empty string) so repeated
 * no-bearer-at-all requests dedup against each other exactly like a
 * repeated bad token would.
 */

import { createHash } from "node:crypto";

export interface RejectedTokenLimiter {
  shouldAppend(bearerValue: string): boolean;
}

export function createRejectedTokenLimiter(
  options: {
    dedupTtlMs?: number;
    dedupMaxEntries?: number;
    windowMs?: number;
    windowMaxAppends?: number;
    now?: () => number;
  } = {},
): RejectedTokenLimiter {
  const dedupTtlMs = options.dedupTtlMs ?? 5 * 60_000;
  const dedupMaxEntries = options.dedupMaxEntries ?? 500;
  const windowMs = options.windowMs ?? 60_000;
  const windowMaxAppends = options.windowMaxAppends ?? 20;
  const now = options.now ?? (() => Date.now());

  const seen = new Map<string, number>(); // sha256(bearer) -> expiry (epoch ms)
  let windowStart = now();
  let windowCount = 0;

  return {
    shouldAppend(bearerValue: string): boolean {
      const t = now();
      const hash = createHash("sha256").update(bearerValue).digest("hex");
      const expiry = seen.get(hash);
      if (expiry !== undefined && expiry > t) return false;

      if (t - windowStart >= windowMs) {
        windowStart = t;
        windowCount = 0;
      }
      if (windowCount >= windowMaxAppends) return false;
      windowCount++;

      if (seen.size >= dedupMaxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(hash, t + dedupTtlMs);
      return true;
    },
  };
}
