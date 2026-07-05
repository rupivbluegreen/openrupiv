/**
 * The dependency seam every command runs against. Commands are pure-ish
 * functions of (arguments, CliDeps); `main.ts` wires the real world in,
 * tests wire fakes (fake generator module, captured writers, pinned
 * randomness) plus real git and a real temp filesystem.
 */

import type { AppSpec, ValidationResult } from "@openrupiv/spec";
import type { CompileResult } from "@openrupiv/compiler";
import type { GeneratorModule } from "./generator-contract";
import type { RunGit } from "./git";

export interface CliDeps {
  /** Directory relative paths (workspace name, --dir) resolve against. */
  cwd: string;
  /** Environment the CLI consults (ANTHROPIC_API_KEY presence — never echoed). */
  env: NodeJS.ProcessEnv;
  /** Write to stdout. In --json mode this receives ONLY the JSON object. */
  stdout: (text: string) => void;
  /** Write to stderr (all human chatter in --json mode). */
  stderr: (text: string) => void;
  /** Run git with args (no shell). */
  runGit: RunGit;
  /** Cryptographic randomness (SESSION_SECRET); injectable for determinism tests. */
  randomBytes: (size: number) => Buffer;
  /** Absolute path of the openRupiv monorepo checkout (compose build context). */
  repoRoot: string;
  /** @openrupiv/spec validateSpec (defense-in-depth re-check of generator output). */
  validateSpec: (input: unknown) => ValidationResult;
  /** @openrupiv/compiler compileApp. */
  compileApp: (spec: AppSpec) => CompileResult;
  /** Load the generator module (dynamic import in production, fake in tests). */
  loadGenerator: () => Promise<GeneratorModule>;
}
