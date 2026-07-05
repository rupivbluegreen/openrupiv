/**
 * Public result types of the compiler, per specs/phase-1-contracts.md §1.
 *
 * The error shape is `@openrupiv/spec`'s `SpecError` with one additional
 * code, `ERR_UNSUPPORTED_SECTION`: spec sections whose shape is versioned
 * but whose behavior the v0 compiler cannot project (policies, agents,
 * evidence) are rejected with a typed error — never silently dropped
 * (CLAUDE.md non-negotiable #2).
 */

import type { SpecError } from "@openrupiv/spec";

export interface CompiledFile {
  /** Workspace-relative POSIX path, e.g. "app/spec.json". */
  path: string;
  contents: string;
}

export type CompilerErrorCode = SpecError["code"] | "ERR_UNSUPPORTED_SECTION";

export interface CompilerError {
  code: CompilerErrorCode;
  /** JSON Pointer (RFC 6901) to the offending location in the spec. */
  path: string;
  message: string;
}

export type CompileResult =
  | { ok: true; files: CompiledFile[] }
  | { ok: false; errors: CompilerError[] };
