import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieOptions,
  createSession,
  isSessionData,
  signPayload,
  verifyPayload,
  type LoginTransaction,
  type SessionData,
} from "../src/session";

const SECRET = "0123456789abcdef0123456789abcdef";

function makeSession(): SessionData {
  return createSession({ sub: "user-1", email: "a@example.com", roles: ["reviewer"] });
}

describe("signPayload / verifyPayload", () => {
  it("round-trips a session", () => {
    const session = makeSession();
    const token = signPayload(session, SECRET, "session");
    const verified = verifyPayload<SessionData>(token, SECRET, "session");
    expect(verified).toEqual({ ok: true, payload: session });
  });

  it("rejects a tampered payload as bad_signature", () => {
    const token = signPayload(makeSession(), SECRET, "session");
    const parts = token.split(".");
    const forged = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    ) as SessionData;
    forged.roles = ["admin"];
    const tampered = [
      parts[0],
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      parts[2],
    ].join(".");
    expect(verifyPayload(tampered, SECRET, "session")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPayload(makeSession(), "another-secret-that-is-32-chars!", "session");
    expect(verifyPayload(token, SECRET, "session")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("SECURITY: a token minted for one purpose does not verify as another (domain separation)", () => {
    // This is the fix for the critical auth-bypass: the login-transaction
    // cookie must not be replayable as a session cookie.
    const txn: LoginTransaction = {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      iat: 1_000,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const txnToken = signPayload(txn, SECRET, "txn");
    // Verifies fine as a txn...
    expect(verifyPayload<LoginTransaction>(txnToken, SECRET, "txn").ok).toBe(true);
    // ...but is rejected when presented as a session.
    expect(verifyPayload(txnToken, SECRET, "session")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // And symmetrically, a session token is not a valid txn.
    const sessionToken = signPayload(makeSession(), SECRET, "session");
    expect(verifyPayload(sessionToken, SECRET, "txn")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects malformed tokens", () => {
    for (const garbage of ["", "abc", "v1.only-two", "v2.a.b", "v1..", "v1.%%%.###"]) {
      const result = verifyPayload(garbage, SECRET, "session");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a structurally-valid token whose payload is not an object with exp", () => {
    const body = Buffer.from(JSON.stringify("just-a-string")).toString("base64url");
    const mac = createHmac("sha256", SECRET).update(`v1.session.${body}`).digest("base64url");
    expect(verifyPayload(`v1.${body}.${mac}`, SECRET, "session")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an expired session", () => {
    const now = Math.floor(Date.now() / 1000);
    const session = createSession({ sub: "user-1", roles: [] }, now - 10_000, 60);
    const token = signPayload(session, SECRET, "session");
    expect(verifyPayload<SessionData>(token, SECRET, "session", now)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("isSessionData", () => {
  it("accepts a real session", () => {
    expect(isSessionData(makeSession())).toBe(true);
  });

  it("rejects a login-transaction shape (no sub/roles)", () => {
    const txn: LoginTransaction = {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      iat: 1,
      exp: 2,
    };
    expect(isSessionData(txn)).toBe(false);
  });

  it("rejects objects with a non-string sub or non-array roles", () => {
    expect(isSessionData({ sub: "", roles: [], exp: 1 })).toBe(false);
    expect(isSessionData({ sub: "u", roles: "reviewer", exp: 1 })).toBe(false);
    expect(isSessionData({ sub: "u", roles: [1, 2], exp: 1 })).toBe(false);
    expect(isSessionData(null)).toBe(false);
  });
});

describe("createSession", () => {
  it("sets iat/exp and omits email when absent", () => {
    const session = createSession({ sub: "s", roles: ["a"] }, 1_000, 100);
    expect(session).toEqual({ sub: "s", roles: ["a"], iat: 1_000, exp: 1_100 });
    expect("email" in session).toBe(false);
  });
});

describe("cookieOptions", () => {
  it("is HttpOnly + SameSite=Lax + Secure outside dev mode", () => {
    expect(cookieOptions({ devMode: false }, 60)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60,
    });
  });

  it("drops Secure only in explicit dev mode", () => {
    expect(cookieOptions({ devMode: true }, 60).secure).toBe(false);
  });
});
