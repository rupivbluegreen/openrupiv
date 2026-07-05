/**
 * Process entry point (dev-mode: executed via tsx by bin/openrupiv.mjs, or
 * directly with `pnpm --filter @openrupiv/cli exec tsx src/main.ts …`).
 * Everything testable lives behind runCli/CliDeps — this file only binds
 * the real world.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compileApp } from "@openrupiv/compiler";
import { validateSpec } from "@openrupiv/spec";
import type { CliDeps } from "./deps";
import { loadGeneratorModule } from "./generator-contract";
import { makeRunGit } from "./git";
import { runCli } from "./program";

function realDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    runGit: makeRunGit(process.env),
    randomBytes: (size) => randomBytes(size),
    // src/main.ts → packages/cli/src → monorepo root is three levels up.
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    validateSpec,
    compileApp,
    loadGenerator: loadGeneratorModule,
  };
}

const code = await runCli(process.argv.slice(2), realDeps()).catch((error: unknown) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`openrupiv: unexpected internal error: ${detail}\n`);
  return 1;
});
// exitCode (not process.exit) so stdio flushes before the process ends.
process.exitCode = code;
