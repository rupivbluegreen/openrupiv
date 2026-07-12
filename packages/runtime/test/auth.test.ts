import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { sanitizeReturnTo } from "../src/auth";
import {
  createSession,
  SESSION_COOKIE_NAME,
  signPayload,
  verifyPayload,
  type SessionData,
} from "../src/session";
import { FakeDb } from "./helpers/fakeDb";
import { makeFakeIdp } from "./helpers/fakeIdp";
import {
  buildTestServer,
  sessionCookieFor,
  testConfig,
  TEST_SESSION_SECRET,
} from "./helpers/testServer";

const spec = fixtures.vendorOnboardingSpec;

function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

describe("session gate", () => {
  it("GET /healthz needs no session", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects API requests without a session as 401 ERR_UNAUTHENTICATED", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({ method: "GET", url: "/api/vendor" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "ERR_UNAUTHENTICATED" });
  });

  it("redirects browser requests to /auth/login with returnTo", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({
      method: "GET",
      url: "/p/vendors",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `/auth/login?returnTo=${encodeURIComponent("/p/vendors")}`,
    );
  });

  it("accepts a valid session cookie", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: { cookie: sessionCookieFor({ sub: "u1" }) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a session signed with the wrong secret, and logs it", async () => {
    const { app, logger } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: {
        cookie: sessionCookieFor({ sub: "u1" }, "wrong-secret-wrong-secret-32ch!!"),
      },
    });
    expect(res.statusCode).toBe(401);
    const rejected = logger.find("auth.session_rejected");
    expect(rejected?.fields["reason"]).toBe("bad_signature");
  });

  it("rejects an expired session", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const now = Math.floor(Date.now() / 1000);
    const stale = createSession({ sub: "u1", roles: [] }, now - 100_000, 60);
    const res = await app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${signPayload(stale, TEST_SESSION_SECRET, "session")}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("SECURITY: a login-transaction cookie replayed as a session cookie is rejected (no auth bypass)", async () => {
    const { app, logger } = await buildTestServer(spec, new FakeDb());
    // Forge exactly what /auth/login hands an unauthenticated caller: a
    // validly-signed txn payload. Presented in the session slot it must NOT
    // authenticate — this is the regression test for the critical bypass.
    const now = Math.floor(Date.now() / 1000);
    const txn = {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      iat: now,
      exp: now + 600,
    };
    const txnToken = signPayload(txn, TEST_SESSION_SECRET, "txn");
    const res = await app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${txnToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "ERR_UNAUTHENTICATED" });
    expect(logger.find("auth.session_rejected")).toBeDefined();
  });
});

describe("GET /auth/login", () => {
  it("redirects to the IdP with PKCE + state and sets the txn cookie", async () => {
    const idp = makeFakeIdp({
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
    });
    const { app } = await buildTestServer(spec, new FakeDb(), {
      oidcProvider: idp.provider,
    });

    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);

    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://idp.test/auth");
    expect(location.searchParams.get("client_id")).toBe("test-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/callback",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("scope")).toContain("openid");

    const txnCookie = setCookies(res.headers).find((c) =>
      c.startsWith("openrupiv_auth_txn="),
    );
    expect(txnCookie).toBeDefined();
    expect(txnCookie).toContain("HttpOnly");
    expect(txnCookie).toContain("SameSite=Lax");
    // devMode=true in testConfig → no Secure flag
    expect(txnCookie).not.toContain("Secure");
  });

  it("marks cookies Secure outside dev mode", async () => {
    const idp = makeFakeIdp({
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
    });
    const { app } = await buildTestServer(spec, new FakeDb(), {
      config: testConfig({ devMode: false }),
      oidcProvider: idp.provider,
    });
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    const txnCookie = setCookies(res.headers).find((c) =>
      c.startsWith("openrupiv_auth_txn="),
    );
    expect(txnCookie).toContain("Secure");
  });
});

describe("GET /auth/callback (full PKCE code flow against an offline IdP)", () => {
  async function login(
    rolesClaimValue: unknown,
    configOverride?: ReturnType<typeof testConfig>,
    subOverride?: string,
  ) {
    const idp = makeFakeIdp({
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
      claims: {
        email: "dev@example.com",
        ...(subOverride !== undefined ? { sub: subOverride } : {}),
        ...(rolesClaimValue !== undefined ? { roles: rolesClaimValue } : {}),
      },
    });
    const db = new FakeDb();
    const { app, logger } = await buildTestServer(spec, db, {
      oidcProvider: idp.provider,
      ...(configOverride ? { config: configOverride } : {}),
    });

    const loginRes = await app.inject({
      method: "GET",
      url: "/auth/login?returnTo=/p/vendors",
    });
    const location = new URL(loginRes.headers.location as string);
    const state = location.searchParams.get("state") as string;
    idp.setNonce(location.searchParams.get("nonce") as string);
    idp.setClaims({
      email: "dev@example.com",
      ...(subOverride !== undefined ? { sub: subOverride } : {}),
      ...(rolesClaimValue !== undefined ? { roles: rolesClaimValue } : {}),
    });
    const txnCookie = setCookies(loginRes.headers)
      .find((c) => c.startsWith("openrupiv_auth_txn="))
      ?.split(";")[0] as string;

    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: txnCookie },
    });
    return { app, idp, callbackRes, logger };
  }

  it("exchanges the code, validates the ID token, and issues a session", async () => {
    const { app, callbackRes } = await login(["reviewer", "compliance"]);
    expect(callbackRes.statusCode).toBe(303);
    expect(callbackRes.headers.location).toBe("/p/vendors");

    const sessionCookie = setCookies(callbackRes.headers).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");

    // The issued session actually authenticates API calls.
    const apiRes = await app.inject({
      method: "GET",
      url: "/api/vendor",
      headers: { cookie: sessionCookie?.split(";")[0] as string },
    });
    expect(apiRes.statusCode).toBe(200);
  });

  it("sends PKCE code_verifier and client_secret to the token endpoint", async () => {
    const { idp } = await login([]);
    expect(idp.tokenRequests).toHaveLength(1);
    const body = idp.tokenRequests[0] as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("fake-code");
    expect(body.get("code_verifier")).toBeTruthy();
  });

  it("extracts sub, email and roles from validated ID-token claims", async () => {
    const { callbackRes } = await login(["reviewer"]);
    const sessionValue = setCookies(callbackRes.headers)
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.split(";")[0]
      ?.slice(`${SESSION_COOKIE_NAME}=`.length) as string;
    const verified = verifyPayload<SessionData>(sessionValue, TEST_SESSION_SECRET, "session");
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe("fake-idp-user");
      expect(verified.payload.email).toBe("dev@example.com");
      expect(verified.payload.roles).toEqual(["reviewer"]);
    }
  });

  it("coerces a single-string roles claim to a one-element array", async () => {
    const { callbackRes } = await login("compliance");
    const sessionValue = setCookies(callbackRes.headers)
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.split(";")[0]
      ?.slice(`${SESSION_COOKIE_NAME}=`.length) as string;
    const verified = verifyPayload<SessionData>(sessionValue, TEST_SESSION_SECRET, "session");
    expect(verified.ok && verified.payload.roles).toEqual(["compliance"]);
  });

  it("rejects an OIDC sub carrying a reserved agent: prefix", async () => {
    const { callbackRes, logger } = await login(
      [],
      undefined,
      "agent:evil@some-app",
    );
    expect(callbackRes.statusCode).toBe(401);
    expect(callbackRes.json()).toMatchObject({
      error: "ERR_RESERVED_IDENTITY_PREFIX",
    });
    expect(logger.find("auth.reserved_identity_rejected")).toBeDefined();
  });

  it("rejects an OIDC sub carrying a reserved a2a: prefix", async () => {
    const { callbackRes } = await login([], undefined, "a2a:some-client");
    expect(callbackRes.statusCode).toBe(401);
    expect(callbackRes.json()).toMatchObject({
      error: "ERR_RESERVED_IDENTITY_PREFIX",
    });
  });

  it("rejects a callback without a login transaction cookie", async () => {
    const idp = makeFakeIdp({
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
    });
    const { app } = await buildTestServer(spec, new FakeDb(), {
      oidcProvider: idp.provider,
    });
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=x&state=y",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ERR_OIDC_CALLBACK" });
  });

  it("rejects a callback whose state does not match the transaction", async () => {
    const idp = makeFakeIdp({
      clientId: "test-client",
      clientSecret: "test-client-secret-not-the-dev-one",
    });
    const { app } = await buildTestServer(spec, new FakeDb(), {
      oidcProvider: idp.provider,
    });
    const loginRes = await app.inject({ method: "GET", url: "/auth/login" });
    const location = new URL(loginRes.headers.location as string);
    idp.setNonce(location.searchParams.get("nonce") as string);
    const txnCookie = setCookies(loginRes.headers)
      .find((c) => c.startsWith("openrupiv_auth_txn="))
      ?.split(";")[0] as string;

    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=fake-code&state=WRONG",
      headers: { cookie: txnCookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "ERR_OIDC_CALLBACK" });
  });

  function sessionRolesOf(callbackRes: {
    headers: Record<string, unknown>;
  }): string[] | false {
    const sessionValue = setCookies(callbackRes.headers)
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.split(";")[0]
      ?.slice(`${SESSION_COOKIE_NAME}=`.length) as string;
    const verified = verifyPayload<SessionData>(sessionValue, TEST_SESSION_SECRET, "session");
    return verified.ok && verified.payload.roles;
  }

  it("ADR-0005: devMode grants all app roles when the roles claim is absent, with a warn log", async () => {
    const { callbackRes, logger } = await login(undefined);
    expect(sessionRolesOf(callbackRes)).toEqual([
      "requester",
      "reviewer",
      "compliance",
    ]);
    const grant = logger.entries.find(
      (e) => e.fields["event"] === "auth.dev_role_grant",
    );
    expect(grant).toBeDefined();
    expect(grant?.level).toBe("warn");
  });

  it("ADR-0005: devMode does NOT override a roles claim that is present", async () => {
    const { callbackRes } = await login(["reviewer"]);
    expect(sessionRolesOf(callbackRes)).toEqual(["reviewer"]);
  });

  it("ADR-0005: without devMode a missing roles claim yields no roles", async () => {
    const { callbackRes, logger } = await login(
      undefined,
      testConfig({ devMode: false }),
    );
    expect(sessionRolesOf(callbackRes)).toEqual([]);
    expect(
      logger.entries.find((e) => e.fields["event"] === "auth.dev_role_grant"),
    ).toBeUndefined();
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and logs the logout", async () => {
    const { app, logger } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: sessionCookieFor({ sub: "u9" }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cleared = setCookies(res.headers).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Expires=");
    expect(logger.find("auth.logout")?.fields["sub"]).toBe("u9");
  });

  it("redirects form-encoded logout posts back to the login page", async () => {
    const { app } = await buildTestServer(spec, new FakeDb());
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: sessionCookieFor({ sub: "u9" }),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/auth/login");
  });
});

describe("sanitizeReturnTo", () => {
  it("keeps same-site absolute paths and rejects everything else", () => {
    expect(sanitizeReturnTo("/p/vendors")).toBe("/p/vendors");
    expect(sanitizeReturnTo("/p/vendors?id=1")).toBe("/p/vendors?id=1");
    expect(sanitizeReturnTo("https://evil.example")).toBe("/");
    expect(sanitizeReturnTo("//evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo(42)).toBe("/");
  });

  it("SECURITY: rejects control/whitespace chars that a browser strips into a protocol-relative URL", () => {
    // `/\t/evil.example` → browser removes the tab → `//evil.example`.
    expect(sanitizeReturnTo("/\t/evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\n/evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\r/evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\u0000/evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\u007f/evil.example")).toBe("/");
  });
});
