/**
 * HMAC-signed, stateless session and login-transaction cookies.
 *
 * SECURITY-CRITICAL. Format: `v1.<base64url(JSON payload)>.<base64url(HMAC)>`
 * where the MAC is HMAC-SHA256 over `v1.<payload>` keyed with the
 * SESSION_SECRET (>= 32 chars, enforced at config load and in createServer).
 * Verification uses a constant-time comparison and rejects on any structural
 * problem, bad signature, or expiry — there is no "best effort" acceptance.
 *
 * Cookies are HttpOnly, SameSite=Lax, Path=/, and Secure unless devMode.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeConfig } from "./config";

const FORMAT_VERSION = "v1";

/**
 * Cookie purpose, bound into the MAC input so a token minted for one purpose
 * cannot be replayed as another. Without this domain separation the
 * short-lived login-transaction cookie (issued to anyone hitting /auth/login)
 * verifies as a session cookie — a full authentication bypass.
 */
export type CookiePurpose = "session" | "txn";

/**
 * Identity namespaces reserved for machine actors (agent runtime,
 * specs/phase-2-contracts.md §4; A2A, §6). No human OIDC sub may carry
 * either prefix — enforced at session creation so the namespaces can never
 * collide with a real human identity.
 */
export const RESERVED_IDENTITY_PREFIXES = ["agent:", "a2a:"] as const;

export function hasReservedIdentityPrefix(sub: string): boolean {
  return RESERVED_IDENTITY_PREFIXES.some((prefix) => sub.startsWith(prefix));
}

export const SESSION_COOKIE_NAME = "openrupiv_session";
export const AUTH_TXN_COOKIE_NAME = "openrupiv_auth_txn";

/** Session lifetime: 8 hours. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Login transaction (state/nonce/PKCE verifier) lifetime: 10 minutes. */
export const AUTH_TXN_TTL_SECONDS = 10 * 60;

/** Identity established from validated ID-token claims. */
export interface SessionData {
  sub: string;
  email?: string;
  roles: string[];
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

/** In-flight OIDC login state, held only in a short-lived signed cookie. */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Local path to return to after login (validated, never absolute URLs). */
  returnTo: string;
  iat: number;
  exp: number;
}

function mac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** MAC input binds the format version AND the cookie purpose to the body. */
function macInput(purpose: CookiePurpose, body: string): string {
  return `${FORMAT_VERSION}.${purpose}.${body}`;
}

/**
 * Serialize + sign a payload for cookie transport. `purpose` is bound into the
 * signature, so a `txn` token never verifies where a `session` token is
 * expected (and vice versa), even though both use the same secret and format.
 */
export function signPayload(
  payload: object,
  secret: string,
  purpose: CookiePurpose,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = mac(macInput(purpose, body), secret).toString("base64url");
  return `${FORMAT_VERSION}.${body}.${signature}`;
}

export type VerifyFailureReason = "malformed" | "bad_signature" | "expired";

export type VerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: VerifyFailureReason };

/**
 * Verify a signed cookie value. Signature is checked in constant time BEFORE
 * the payload is parsed; expiry is checked against `exp` (unix seconds).
 */
export function verifyPayload<T extends { exp: number }>(
  token: string,
  secret: string,
  purpose: CookiePurpose,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult<T> {
  const parts = token.split(".");
  const version = parts[0];
  const body = parts[1];
  const signature = parts[2];
  if (parts.length !== 3 || version !== FORMAT_VERSION || !body || !signature) {
    return { ok: false, reason: "malformed" };
  }

  const expected = mac(macInput(purpose, body), secret);
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if ((payload as { exp: number }).exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: payload as T };
}

/**
 * Structural guard: a verified session token must actually carry identity.
 * Defense in depth beyond the purpose-bound signature — the session gate
 * treats anything failing this as unauthenticated.
 */
export function isSessionData(payload: unknown): payload is SessionData {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p["sub"] === "string" &&
    p["sub"] !== "" &&
    Array.isArray(p["roles"]) &&
    p["roles"].every((r) => typeof r === "string") &&
    typeof p["exp"] === "number"
  );
}

/** Build a SessionData for a just-authenticated user. */
export function createSession(
  identity: { sub: string; email?: string | undefined; roles: string[] },
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): SessionData {
  const session: SessionData = {
    sub: identity.sub,
    roles: identity.roles,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  if (identity.email !== undefined) session.email = identity.email;
  return session;
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

/**
 * Hardened cookie attributes. `Secure` is dropped ONLY in explicit dev mode
 * (plain-http localhost); everywhere else it is mandatory.
 */
export function cookieOptions(
  config: Pick<RuntimeConfig, "devMode">,
  maxAgeSeconds: number,
): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: !config.devMode,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
