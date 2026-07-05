/**
 * `compileApp` — the deterministic spec → app-directory projection
 * (ADR-0001, ADR-0004; contract in specs/phase-1-contracts.md §1).
 *
 * Determinism rules enforced here and tested in `test/`:
 * - output is a pure function of the spec: no timestamps, no randomness,
 *   no environment reads anywhere under `src/`;
 * - `files` is sorted by `path` ascending (plain code-unit order — never
 *   locale-dependent collation);
 * - the same spec always produces byte-identical files.
 */

import type { AppSpec } from "@openrupiv/spec";
import { renderAppReadme } from "./app-readme";
import { renderSpecTest } from "./app-test";
import { renderMigration } from "./sql";
import { renderAppPackageJson, SERVER_ENTRY } from "./templates";
import type { CompiledFile, CompileResult, CompilerError } from "./types";

/** Spec sections whose shape is reserved but whose behavior v0 cannot project. */
const UNSUPPORTED_SECTIONS = ["policies", "agents", "evidence"] as const;

/**
 * Compile an already-validated spec (callers run `validateSpec` first)
 * into the ADR-0004 app directory. Returns every error it can find in one
 * pass rather than failing on the first.
 */
export function compileApp(spec: AppSpec): CompileResult {
  const errors: CompilerError[] = [];

  for (const section of UNSUPPORTED_SECTIONS) {
    const entries = spec[section];
    if (entries !== undefined && entries.length > 0) {
      errors.push({
        code: "ERR_UNSUPPORTED_SECTION",
        path: `/${section}`,
        message:
          `spec section "${section}" (${entries.length} ${entries.length === 1 ? "entry" : "entries"}) ` +
          `is not yet supported: the v0 compiler cannot enforce it, and silently dropping it ` +
          `would be a stubbed control. Remove the section or wait for the phase that implements it.`,
      });
    }
  }

  const migration = renderMigration(spec);
  if (!migration.ok) errors.push(...migration.errors);

  if (errors.length > 0 || !migration.ok) {
    return { ok: false, errors };
  }

  const files: CompiledFile[] = [
    { path: "app/spec.json", contents: `${JSON.stringify(spec, null, 2)}\n` },
    { path: "app/migrations/0001_init.sql", contents: migration.sql },
    { path: "app/README.md", contents: renderAppReadme(spec) },
    { path: "app/package.json", contents: renderAppPackageJson(spec) },
    { path: "app/test/spec.test.mjs", contents: renderSpecTest(spec) },
    { path: "app/server.mjs", contents: SERVER_ENTRY },
  ];

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { ok: true, files };
}
