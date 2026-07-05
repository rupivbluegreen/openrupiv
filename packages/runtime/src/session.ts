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

/** Serialize + sign a payload for cookie transport. */
export function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = mac(`${FORMAT_VERSION}.${body}`, secret).toString(
    "base64url",
  );
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
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult<T> {
  const parts = token.split(".");
  const version = parts[0];
  const body = parts[1];
  const signature = parts[2];
  if (parts.length !== 3 || version !== FORMAT_VERSION || !body || !signature) {
    return { ok: false, reason: "malformed" };
  }

  const expected = mac(`${FORMAT_VERSION}.${body}`, secret);
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
