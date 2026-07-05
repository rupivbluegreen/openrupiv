/**
 * Typed CLI errors and the exit-code vocabulary fixed by
 * specs/phase-1-contracts.md §4:
 *
 *   0 — success
 *   2 — generation/validation failed (after the generator's retries)
 *   3 — compile failed
 *   4 — environment error (missing API key, not a workspace, git failure, …)
 *
 * 1 is reserved for usage errors (unknown command, missing argument) and
 * unexpected internal errors — it is never used for the outcomes above.
 * Every failure is machine-readable: a stable `code`, a JSON-Pointer-ish
 * `path` where applicable, and a human message. Codes are API; messages
 * are not.
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_GENERATE_FAILED = 2;
export const EXIT_COMPILE_FAILED = 3;
export const EXIT_ENVIRONMENT = 4;

export type CliErrorCode =
  /** Workspace name is not a safe kebab-case identifier. */
  | "ERR_BAD_NAME"
  /** Target directory for `new` already exists. */
  | "ERR_WORKSPACE_EXISTS"
  /** `generate` was pointed at a directory that is not an openrupiv workspace. */
  | "ERR_NOT_A_WORKSPACE"
  /** openrupiv.yaml exists but is unreadable or declares an unsupported version. */
  | "ERR_BAD_WORKSPACE_CONFIG"
  /** ANTHROPIC_API_KEY is not set (the value itself is never echoed). */
  | "ERR_MISSING_API_KEY"
  /** @openrupiv/generator could not be loaded or does not implement its contract. */
  | "ERR_GENERATOR_UNAVAILABLE"
  /** A git invocation failed (missing binary, missing identity, …). */
  | "ERR_GIT"
  /** The compiler emitted a file path outside the workspace ./app directory. */
  | "ERR_COMPILED_PATH";

/**
 * The error shape reported to machines (and, formatted, to humans). It is
 * deliberately the same `{ code, path, message }` shape as
 * `@openrupiv/spec`'s SpecError and the compiler's CompilerError so `--json`
 * consumers handle one format regardless of which stage failed.
 */
export interface ReportedError {
  code: string;
  path: string;
  message: string;
}

export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: CliErrorCode;
  readonly exitCode: number;

  constructor(code: CliErrorCode, message: string, exitCode: number = EXIT_ENVIRONMENT) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }

  toReportedError(): ReportedError {
    return { code: this.code, path: "", message: this.message };
  }
}
