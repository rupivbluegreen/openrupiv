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

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import * as oidc from "openid-client";
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

/** Only same-site absolute paths are valid post-login destinations. */
export function sanitizeReturnTo(value: unknown): string {
  if (
    typeof value === "string" &&
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

export function registerAuth(
  app: FastifyInstance,
  config: RuntimeConfig,
  logger: Logger,
  provider: OidcProvider,
  appRoles: readonly string[] = [],
): void {
  const secret = config.sessionSecret;
  const redirectUri = `${config.baseUrl.replace(/\/+$/, "")}/auth/callback`;

  // ---- Session gate: every route, no exceptions beyond the allowlist. ----
  app.addHook("onRequest", async (request, reply) => {
    const rawCookie = request.cookies[SESSION_COOKIE_NAME];
    if (rawCookie) {
      const verified = verifyPayload<SessionData>(rawCookie, secret);
      if (verified.ok) {
        request.session = verified.payload;
      } else {
        logger.warn(
          { event: "auth.session_rejected", reason: verified.reason },
          "session cookie rejected",
        );
      }
    }

    const pathname = pathnameOf(request);
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
        signPayload(txn, secret),
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
    const verifiedTxn = verifyPayload<LoginTransaction>(rawTxn, secret);
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
    }
    const email = typeof claims["email"] === "string" ? claims["email"] : undefined;
    const session = createSession({ sub: claims.sub, email, roles });

    reply.clearCookie(AUTH_TXN_COOKIE_NAME, { path: "/" });
    reply.setCookie(
      SESSION_COOKIE_NAME,
      signPayload(session, secret),
      cookieOptions(config, SESSION_TTL_SECONDS),
    );
    logger.info(
      { event: "auth.login", sub: session.sub, roles: session.roles },
      "user logged in",
    );
    await reply.redirect(txn.returnTo, 303);
  });

  // ---- POST /auth/logout -> destroy session. ----
  app.post("/auth/logout", async (request, reply) => {
    if (request.session) {
      logger.info(
        { event: "auth.logout", sub: request.session.sub },
        "user logged out",
      );
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
