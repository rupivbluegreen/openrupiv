/**
 * Typed, machine-readable runtime errors.
 *
 * Every failure the runtime surfaces — configuration problems, refused dev
 * credentials, migration failures, HTTP-level enforcement rejections — is a
 * `RuntimeError` with a stable `code`. Codes are API; messages are not.
 * There are no silent failures: anything that cannot be enforced throws.
 */

export type RuntimeErrorCode =
  /** Invalid or incomplete runtime configuration (env vars). */
  | "ERR_CONFIG"
  /** ADR-0002: bundled dev client secret without OPENRUPIV_DEV_MODE=true. */
  | "ERR_DEV_CREDENTIALS"
  /** App directory missing or unreadable (spec.json / migrations). */
  | "ERR_APP_DIR"
  /** spec.json is not valid JSON or fails validateSpec. */
  | "ERR_APP_SPEC_INVALID"
  /** A migration file failed to apply (transaction rolled back). */
  | "ERR_MIGRATION_FAILED"
  /** OIDC discovery against the issuer failed. */
  | "ERR_OIDC_DISCOVERY"
  /** OIDC callback failed (state/nonce/PKCE/token validation). */
  | "ERR_OIDC_CALLBACK"
  /** OIDC sub carries a reserved machine-identity prefix ("agent:"/"a2a:"). */
  | "ERR_RESERVED_IDENTITY_PREFIX"
  /** Request has no valid session. */
  | "ERR_UNAUTHENTICATED"
  /** Record or route not found. */
  | "ERR_NOT_FOUND"
  /** Request body failed entity validation. */
  | "ERR_VALIDATION"
  /** Attempt to write a workflow state field through create/update. */
  | "ERR_STATE_FIELD_READONLY"
  /** Transition fired from a state that does not match its `from`. */
  | "ERR_BAD_STATE"
  /** Caller lacks the roles required by the guard or approval rule. */
  | "ERR_FORBIDDEN_ROLE"
  /** A guard field predicate did not hold on the current record. */
  | "ERR_GUARD_FAILED"
  /** n-eyes: the same user attempted a second approval. */
  | "ERR_DUPLICATE_APPROVER"
  /** An audit append failed; the request fails closed (Phase 2 contract §2). */
  | "ERR_AUDIT_APPEND_FAILED"
  /** Internal invariant: a name did not survive SQL identifier checks. */
  | "ERR_SQL_IDENTIFIER"
  /** Unclassified internal error. */
  | "ERR_INTERNAL";

export interface RuntimeErrorOptions {
  /** HTTP status the error maps to when it reaches a route handler. */
  statusCode?: number;
  /** Machine-readable details (e.g. SpecError[], missing env var names). */
  details?: unknown;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: RuntimeErrorOptions = {},
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }

  /** JSON body served to HTTP clients: `{ error, message, details? }`. */
  toBody(): { error: RuntimeErrorCode; message: string; details?: unknown } {
    const body: { error: RuntimeErrorCode; message: string; details?: unknown } =
      { error: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}
