/**
 * Bearer-token authentication for `POST /v1/execute` (ADR-0007, "Supervisor
 * API"). This is *authentication* only -- "is this caller allowed to talk
 * to me at all" -- never authorization; the decision "should this specific
 * tool call happen" has already been made and audited by `@openrupiv/agents`
 * before the caller ever reaches this sidecar.
 *
 * Both the presented and expected token are SHA-256 hashed first (fixed
 * 32-byte digests) before `timingSafeEqual`, deliberately -- comparing raw
 * tokens directly is unsafe because `timingSafeEqual` requires equal-length
 * buffers and would either throw or leak length information via that
 * mismatch. The raw token is never logged; only "present / absent / valid /
 * invalid" is ever recorded by callers of this module.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function tokensMatch(presented: string, expected: string): boolean {
  const presentedHash = hashToken(presented);
  const expectedHash = hashToken(expected);
  return timingSafeEqual(presentedHash, expectedHash);
}
