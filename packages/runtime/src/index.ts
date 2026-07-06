/**
 * @openrupiv/runtime — serves a compiled app directory (ADR-0004):
 * OIDC-authenticated (ADR-0002/0003), Postgres-backed, workflow-enforcing.
 * Public contract per specs/phase-1-contracts.md §2.
 */

export {
  configFromEnv,
  assertRuntimeConfig,
  DEV_CLIENT_SECRET,
  MIN_SESSION_SECRET_LENGTH,
  type RuntimeConfig,
} from "./config";
export { RuntimeError, type RuntimeErrorCode } from "./errors";
export { createLogger, redact, type Logger, type LogSink } from "./logger";
export { createPgDb, type Db, type Queryable, type QueryResultLike } from "./db";
export { applyMigrations, ensureInfraTables } from "./migrate";
export {
  createSession,
  isSessionData,
  signPayload,
  verifyPayload,
  cookieOptions,
  SESSION_COOKIE_NAME,
  type CookiePurpose,
  type SessionData,
  type VerifyResult,
} from "./session";
export { defaultOidcProvider, type OidcProvider } from "./auth";
export {
  createDbAuditStore,
  appendOrFail,
  appendAllOrFail,
  auditBestEffort,
} from "./audit";
export { AUDIT_READ_ROLES, registerAdminAuditRoutes } from "./admin";
export { escapeHtml } from "./pages";
export {
  executeTransition,
  type TransitionOutcome,
  type ExecuteTransitionInput,
} from "./workflows";
export {
  createServer,
  loadAppDir,
  serveAppDir,
  type ServerDeps,
} from "./server";
