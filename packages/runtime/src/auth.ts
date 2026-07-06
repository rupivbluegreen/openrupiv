/**
 * OIDC relying party (Authorization Code + PKCE) and session enforcement.
 *
 * SECURITY-CRITICAL — human maintainer review required (CLAUDE.md).
 *
 * - openid-client v6 functional API: discovery(), buildAuthorizationUrl(),
 *   authorizationCodeGrant(). ID-token validation (issuer, audience, expiry,
 *   signature via JWKS, nonce) is performed by the library during the code
 *   grant; we never accept unvalidated claims.
 * - Login state (state, nonce, PKCE verifier) lives in a short-lived
 *   HMAC-signed HttpOnly cookie; the session is a longer-lived signed cookie
 *   (see session.ts). No server-side session store in v0.
 * - EVERY route requires a session except /healthz and /auth/*. There is no
 *   anonymous mode (ADR-0003).
 * - Plain-http issuers are allowed ONLY in explicit dev mode; otherwise the
 *   library's HTTPS-only enforcement stands.
 */

import { createHash } from "node:crypto";
import type { AuditRecordInput, AuditStore } from "@openrupiv/audit";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import * as oidc from "openid-client";
import { auditBestEffort } from "./audit";
import type { RuntimeConfig } from "./config";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";
import {
  AUTH_TXN_COOKIE_NAME,
  AUTH_TXN_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  cookieOptions,
  createSession,
  isSessionData,
  signPayload,
  verifyPayload,
  type LoginTransaction,
  type SessionData,
} from "./session";

declare module "fastify" {
  interface FastifyRequest {
    /** Verified session identity; set by the auth hook when valid. */
    session?: SessionData;
  }
}

/** Seam for tests: production uses cached OIDC discovery. */
export interface OidcProvider {
  getConfiguration(): Promise<oidc.Configuration>;
}

/**
 * Lazily discover the issuer once and cache the Configuration. Failures are
 * not cached, so a temporarily unreachable IdP does not poison the process.
 */
export function defaultOidcProvider(
  config: RuntimeConfig,
  logger: Logger,
): OidcProvider {
  let cached: Promise<oidc.Configuration> | undefined;
  return {
    getConfiguration() {
      cached ??= (async () => {
        const issuerUrl = new URL(config.oidc.issuer);
        const options: oidc.DiscoveryRequestOptions = {};
        if (config.devMode && issuerUrl.protocol === "http:") {
          // Explicitly opted-in dev mode only; production keeps HTTPS-only.
          options.execute = [oidc.allowInsecureRequests];
        }
        try {
          const configuration = await oidc.discovery(
            issuerUrl,
            config.oidc.clientId,
            config.oidc.clientSecret,
            undefined,
            options,
          );
          logger.info(
            { event: "oidc.discovered", issuer: config.oidc.issuer },
            "OIDC discovery complete",
          );
          return configuration;
        } catch (error) {
          cached = undefined;
          const message = error instanceof Error ? error.message : String(error);
          logger.error(
            { event: "oidc.discovery_failed", issuer: config.oidc.issuer, reason: message },
            "OIDC discovery failed",
          );
          throw new RuntimeError(
            "ERR_OIDC_DISCOVERY",
            `OIDC discovery failed for issuer ${config.oidc.issuer}: ${message}`,
            { statusCode: 502 },
          );
        }
      })();
      return cached;
    },
  };
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/healthz" || pathname.startsWith("/auth/");
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

/**
 * Only same-site absolute paths are valid post-login destinations. Reject any
 * control/whitespace character first: a browser strips embedded tab/CR/LF from
 * a URL, so `/\t/evil.example` would collapse to the protocol-relative
 * `//evil.example` — an open redirect that prefix checks alone miss.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (
    typeof value === "string" &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
  ) {
    return value;
  }
  return "/";
}

function extractRoles(claimValue: unknown): string[] {
  if (Array.isArray(claimValue)) {
    return claimValue.filter((r): r is string => typeof r === "string");
  }
  if (typeof claimValue === "string" && claimValue !== "") return [claimValue];
  return [];
}

function pathnameOf(request: FastifyRequest): string {
  const url = request.raw.url ?? "/";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Bounds how often an invalid session cookie durably audits
 * `auth.session_rejected` (finding "unauth-unbounded-audit-writes"): one
 * stale browser cookie must not re-append (and re-take the audit chain's
 * tail lock) on every single subsequent request.
 *
 * Two independent caps, both "fail open" toward SKIPPING the append (never
 * toward silently dropping the observability signal — the structured warn
 * log always fires regardless, at full fidelity, in the caller):
 *   - Per-cookie dedup: the SAME rejected cookie value is audited once per
 *     TTL window, keyed by a hash (never the raw cookie) so nothing
 *     sensitive is retained.
 *   - A coarser rolling-window cap on NEW distinct rejections, so a caller
 *     who defeats the per-cookie dedup by sending a fresh garbage cookie on
 *     every request still cannot grow the log unboundedly.
 * Both caches are bounded in memory (capped entries, TTL-expired), so the
 * limiter itself cannot become the unbounded-growth problem it exists to
 * prevent.
 */
export function createRejectedCookieLimiter(
  options: {
    dedupTtlMs?: number;
    dedupMaxEntries?: number;
    windowMs?: number;
    windowMaxAppends?: number;
    now?: () => number;
  } = {},
): { shouldAppend: (cookieValue: string) => boolean } {
  const dedupTtlMs = options.dedupTtlMs ?? 5 * 60_000;
  const dedupMaxEntries = options.dedupMaxEntries ?? 500;
  const windowMs = options.windowMs ?? 60_000;
  const windowMaxAppends = options.windowMaxAppends ?? 20;
  const now = options.now ?? (() => Date.now());

  const seen = new Map<string, number>(); // sha256(cookie) -> expiry (epoch ms)
  let windowStart = now();
  let windowCount = 0;

  return {
    shouldAppend(cookieValue: string): boolean {
      const t = now();
      const hash = createHash("sha256").update(cookieValue).digest("hex");
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

export function registerAuth(
  app: FastifyInstance,
  config: RuntimeConfig,
  logger: Logger,
  provider: OidcProvider,
  appRoles: readonly string[] = [],
  audit?: AuditStore,
): void {
  const secret = config.sessionSecret;
  const redirectUri = `${config.baseUrl.replace(/\/+$/, "")}/auth/callback`;

  // Auth events have no DB side effect to bind to, so they append
  // BEST-EFFORT (contract §2): an audit failure is logged at error level with
  // the event preserved and never blocks login/logout. attributes carry no
  // secrets/tokens — only subs, roles, and rejection reasons.
  const record = (input: AuditRecordInput): Promise<void> =>
    audit ? auditBestEffort(audit, logger, input) : Promise.resolve();

  // Finding "unauth-unbounded-audit-writes": bounds how often a rejected
  // session cookie durably audits, independent of the request rate.
  const rejectedCookieLimiter = createRejectedCookieLimiter();

  // ---- Session gate: every route, no exceptions beyond the allowlist. ----
  app.addHook("onRequest", async (request, reply) => {
    const pathname = pathnameOf(request);
    const rawCookie = request.cookies[SESSION_COOKIE_NAME];
    if (rawCookie) {
      const verified = verifyPayload<SessionData>(rawCookie, secret, "session");
      if (verified.ok && isSessionData(verified.payload)) {
        request.session = verified.payload;
      } else {
        const reason = verified.ok ? "not_session_data" : verified.reason;
        // Always logged, at full fidelity, regardless of path or dedup below
        // — only the durable audit append (and its chain-tail lock) is
        // bounded, never the observability signal.
        logger.warn(
          { event: "auth.session_rejected", reason },
          "session cookie rejected",
        );
        // The cookie will never verify again (bad signature, expiry, wrong
        // purpose, ...) — clear it so the browser stops resending it and
        // re-triggering this rejection on every subsequent request. Options
        // must match how the cookie was originally set for the browser to
        // actually delete it.
        reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions(config, 0));
        // Public paths (/healthz, /auth/*) must never pay a DB round trip
        // for garbage cookie junk — a stray cookie on /healthz should stay
        // as cheap as /healthz always has been.
        if (!isPublicPath(pathname) && rejectedCookieLimiter.shouldAppend(rawCookie)) {
          await record({
            event: "auth.session_rejected",
            actor: "system",
            actorType: "system",
            attributes: { reason },
          });
        }
      }
    }

    if (isPublicPath(pathname)) return;

    if (!request.session) {
      if (wantsHtml(request)) {
        const url = request.raw.url ?? "/";
        await reply.redirect(
          `/auth/login?returnTo=${encodeURIComponent(url)}`,
          302,
        );
        return reply;
      }
      await reply.code(401).send({
        error: "ERR_UNAUTHENTICATED",
        message: "authentication required; start at /auth/login",
      });
      return reply;
    }
    return undefined;
  });

  // ---- GET /auth/login -> redirect to the IdP with PKCE. ----
  app.get<{ Querystring: { returnTo?: string } }>(
    "/auth/login",
    async (request, reply) => {
      const configuration = await provider.getConfiguration();

      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const nowSeconds = Math.floor(Date.now() / 1000);

      const txn: LoginTransaction = {
        state,
        nonce,
        codeVerifier,
        returnTo: sanitizeReturnTo(request.query.returnTo),
        iat: nowSeconds,
        exp: nowSeconds + AUTH_TXN_TTL_SECONDS,
      };
      reply.setCookie(
        AUTH_TXN_COOKIE_NAME,
        signPayload(txn, secret, "txn"),
        cookieOptions(config, AUTH_TXN_TTL_SECONDS),
      );

      const scopes = ["openid", "profile", "email"];
      if (config.oidc.rolesClaim === "groups") scopes.push("groups");

      const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      await reply.redirect(authorizationUrl.href, 302);
    },
  );

  // ---- GET /auth/callback -> code exchange, ID-token validation, session. ----
  app.get("/auth/callback", async (request, reply) => {
    const rawTxn = request.cookies[AUTH_TXN_COOKIE_NAME];
    if (!rawTxn) {
      throw new RuntimeError(
        "ERR_OIDC_CALLBACK",
        "no login transaction found; start again at /auth/login",
        { statusCode: 400 },
      );
    }
    const verifiedTxn = verifyPayload<LoginTransaction>(rawTxn, secret, "txn");
    if (!verifiedTxn.ok) {
      throw new RuntimeError(
        "ERR_OIDC_CALLBACK",
        `login transaction rejected (${verifiedTxn.reason}); start again at /auth/login`,
        { statusCode: 400 },
      );
    }
    const txn = verifiedTxn.payload;

    const configuration = await provider.getConfiguration();
    const currentUrl = new URL(request.raw.url ?? "/auth/callback", config.baseUrl);

    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: txn.codeVerifier,
        expectedState: txn.state,
        expectedNonce: txn.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { event: "auth.callback_failed", reason: message },
        "OIDC callback rejected",
      );
      throw new RuntimeError(
        "ERR_OIDC_CALLBACK",
        `authorization code exchange failed: ${message}`,
        { statusCode: 401 },
      );
    }

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || claims.sub === "") {
      throw new RuntimeError(
        "ERR_OIDC_CALLBACK",
        "ID token is missing a sub claim",
        { statusCode: 401 },
      );
    }

    let roles = extractRoles(claims[config.oidc.rolesClaim]);
    if (roles.length === 0 && config.devMode && appRoles.length > 0) {
      // ADR-0005: dev-mode-only role grant. The bundled Dex dev IdP cannot
      // emit a roles claim for static users, so with OPENRUPIV_DEV_MODE=true
      // (and only then) a user arriving with NO roles is granted every role
      // the app spec declares. Production deployments are unaffected: with
      // devMode=false the user simply has no roles and guarded transitions
      // return 403.
      roles = [...appRoles];
      logger.warn(
        { event: "auth.dev_role_grant", sub: claims.sub, roles },
        "DEV MODE: granting all app roles to user with no roles claim — never enable OPENRUPIV_DEV_MODE in production",
      );
      await record({
        event: "auth.dev_role_grant",
        actor: claims.sub,
        actorType: "human",
        attributes: { roles },
      });
    }
    const email = typeof claims["email"] === "string" ? claims["email"] : undefined;
    const session = createSession({ sub: claims.sub, email, roles });

    reply.clearCookie(AUTH_TXN_COOKIE_NAME, { path: "/" });
    reply.setCookie(
      SESSION_COOKIE_NAME,
      signPayload(session, secret, "session"),
      cookieOptions(config, SESSION_TTL_SECONDS),
    );
    logger.info(
      { event: "auth.login", sub: session.sub, roles: session.roles },
      "user logged in",
    );
    await record({
      event: "auth.login",
      actor: session.sub,
      actorType: "human",
      attributes: { roles: session.roles },
    });
    await reply.redirect(txn.returnTo, 303);
  });

  // ---- POST /auth/logout -> destroy session. ----
  app.post("/auth/logout", async (request, reply) => {
    if (request.session) {
      logger.info(
        { event: "auth.logout", sub: request.session.sub },
        "user logged out",
      );
      await record({
        event: "auth.logout",
        actor: request.session.sub,
        actorType: "human",
      });
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    const contentType = request.headers["content-type"] ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      await reply.redirect("/auth/login", 303);
      return;
    }
    await reply.send({ ok: true });
  });
}
