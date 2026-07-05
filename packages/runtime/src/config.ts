/**
 * Runtime configuration from the environment, per specs/phase-1-contracts.md §2.
 *
 * SECURITY: this module enforces two hard gates —
 *  - SESSION_SECRET must be at least 32 characters (session cookies are
 *    HMAC-signed with it), and
 *  - the bundled dev-only OIDC client secret is refused unless
 *    OPENRUPIV_DEV_MODE=true (ADR-0002).
 * Both are re-checked in `createServer` (defense in depth against configs
 * built without `configFromEnv`).
 */

import { RuntimeError } from "./errors";

export interface RuntimeConfig {
  databaseUrl: string; // DATABASE_URL
  oidc: {
    issuer: string; // OIDC_ISSUER
    clientId: string; // OIDC_CLIENT_ID
    clientSecret: string; // OIDC_CLIENT_SECRET
    rolesClaim: string; // OIDC_ROLES_CLAIM, default "roles"
  };
  sessionSecret: string; // SESSION_SECRET (>= 32 chars enforced)
  baseUrl: string; // BASE_URL, e.g. http://localhost:3000
  port: number; // PORT, default 3000
  devMode: boolean; // OPENRUPIV_DEV_MODE === "true"
}

/** The conspicuous dev-only client secret shipped with the Compose Dex stack. */
export const DEV_CLIENT_SECRET = "openrupiv-dev-secret";

export const MIN_SESSION_SECRET_LENGTH = 32;

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function isValidUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a RuntimeConfig from environment variables. Throws a RuntimeError
 * with code ERR_CONFIG (all problems listed in `details`) or
 * ERR_DEV_CREDENTIALS (ADR-0002 refusal). Never returns a partial config.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const problems: string[] = [];

  const databaseUrl = readVar(env, "DATABASE_URL");
  if (!databaseUrl) problems.push("DATABASE_URL is required");

  const issuer = readVar(env, "OIDC_ISSUER");
  if (!issuer) {
    problems.push("OIDC_ISSUER is required");
  } else if (!isValidUrl(issuer)) {
    problems.push(`OIDC_ISSUER is not a valid URL: ${JSON.stringify(issuer)}`);
  }

  const clientId = readVar(env, "OIDC_CLIENT_ID");
  if (!clientId) problems.push("OIDC_CLIENT_ID is required");

  const clientSecret = readVar(env, "OIDC_CLIENT_SECRET");
  if (!clientSecret) problems.push("OIDC_CLIENT_SECRET is required");

  const rolesClaim = readVar(env, "OIDC_ROLES_CLAIM") ?? "roles";

  const sessionSecret = readVar(env, "SESSION_SECRET");
  if (!sessionSecret) {
    problems.push("SESSION_SECRET is required");
  } else if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${sessionSecret.length})`,
    );
  }

  let port = 3000;
  const portRaw = readVar(env, "PORT");
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`PORT must be an integer in 1..65535: ${JSON.stringify(portRaw)}`);
    } else {
      port = parsed;
    }
  }

  const devMode = env["OPENRUPIV_DEV_MODE"] === "true";

  const baseUrl = readVar(env, "BASE_URL") ?? `http://localhost:${port}`;
  if (!isValidUrl(baseUrl)) {
    problems.push(`BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}`);
  }

  if (problems.length > 0) {
    throw new RuntimeError(
      "ERR_CONFIG",
      `invalid runtime configuration: ${problems.join("; ")}`,
      { details: problems },
    );
  }

  const config: RuntimeConfig = {
    databaseUrl: databaseUrl as string,
    oidc: {
      issuer: issuer as string,
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      rolesClaim,
    },
    sessionSecret: sessionSecret as string,
    baseUrl: baseUrl.replace(/\/+$/, "") || baseUrl,
    port,
    devMode,
  };

  assertRuntimeConfig(config);
  return config;
}

/**
 * Security gates re-checked wherever a RuntimeConfig enters the system
 * (configFromEnv AND createServer), so a hand-built config cannot bypass
 * them. Throws; never degrades to a warning.
 */
export function assertRuntimeConfig(config: RuntimeConfig): void {
  if (config.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new RuntimeError(
      "ERR_CONFIG",
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${config.sessionSecret.length})`,
      { details: ["SESSION_SECRET too short"] },
    );
  }
  if (config.oidc.clientSecret === DEV_CLIENT_SECRET && !config.devMode) {
    throw new RuntimeError(
      "ERR_DEV_CREDENTIALS",
      "refusing to start: OIDC_CLIENT_SECRET is the bundled dev-only Dex secret. " +
        "This credential is for local development only (ADR-0002). " +
        "Either configure a real identity provider, or — for local development " +
        "ONLY — set OPENRUPIV_DEV_MODE=true.",
    );
  }
}
