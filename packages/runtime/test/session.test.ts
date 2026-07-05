import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieOptions,
  createSession,
  signPayload,
  verifyPayload,
  type SessionData,
} from "../src/session";

const SECRET = "0123456789abcdef0123456789abcdef";

function makeSession(): SessionData {
  return createSession({ sub: "user-1", email: "a@example.com", roles: ["reviewer"] });
}

describe("signPayload / verifyPayload", () => {
  it("round-trips a session", () => {
    const session = makeSession();
    const token = signPayload(session, SECRET);
    const verified = verifyPayload<SessionData>(token, SECRET);
    expect(verified).toEqual({ ok: true, payload: session });
  });

  it("rejects a tampered payload as bad_signature", () => {
    const token = signPayload(makeSession(), SECRET);
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
    expect(verifyPayload(tampered, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPayload(makeSession(), "another-secret-that-is-32-chars!");
    expect(verifyPayload(token, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects malformed tokens", () => {
    for (const garbage of ["", "abc", "v1.only-two", "v2.a.b", "v1..", "v1.%%%.###"]) {
      const result = verifyPayload(garbage, SECRET);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a structurally-valid token whose payload is not an object with exp", () => {
    const body = Buffer.from(JSON.stringify("just-a-string")).toString("base64url");
    const mac = createHmac("sha256", SECRET).update(`v1.${body}`).digest("base64url");
    expect(verifyPayload(`v1.${body}.${mac}`, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an expired session", () => {
    const now = Math.floor(Date.now() / 1000);
    const session = createSession({ sub: "user-1", roles: [] }, now - 10_000, 60);
    const token = signPayload(session, SECRET);
    expect(verifyPayload<SessionData>(token, SECRET, now)).toEqual({
      ok: false,
      reason: "expired",
    });
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
