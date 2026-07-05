/**
 * Shared test scaffolding: captured writers, hermetic git environment
 * (identity from env vars, host config suppressed), temp workspaces, and a
 * contract-faithful fake `@openrupiv/generator` module. Tests use real git,
 * a real temp filesystem, and the REAL @openrupiv/compiler — only the LLM
 * seam is faked (no network, no ANTHROPIC_API_KEY needed).
 */

import crypto from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compileApp } from "@openrupiv/compiler";
import { validateSpec, type SpecError } from "@openrupiv/spec";
import type { CliDeps } from "../src/deps";
import { CliError } from "../src/errors";
import type {
  GenerateResult,
  GeneratorModule,
  SpecModel,
  SpecModelRequest,
} from "../src/generator-contract";
import { makeRunGit } from "../src/git";

/** The monorepo root (test/ → packages/cli → packages → root). */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** A value that must NEVER appear in CLI output (leak canary). */
export const CANARY_API_KEY = "sk-ant-test-canary-never-print-me";

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openrupiv-cli-test-"));
}

/**
 * Hermetic git environment: a fixed identity via env vars, host/global
 * config suppressed so the suite behaves identically on any machine or CI.
 */
export function gitTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  // Tests opt in to a key explicitly (via `extra`); the ambient one must
  // never leak in.
  delete env["ANTHROPIC_API_KEY"];
  Object.assign(env, extra);
  return env;
}

export interface Capture {
  write: (text: string) => void;
  text: () => string;
}

export function capture(): Capture {
  const chunks: string[] = [];
  return {
    write: (text) => {
      chunks.push(text);
    },
    text: () => chunks.join(""),
  };
}

export interface TestContext {
  deps: CliDeps;
  out: Capture;
  err: Capture;
  env: NodeJS.ProcessEnv;
}

export function makeDeps(cwd: string, overrides: Partial<CliDeps> = {}): TestContext {
  const out = capture();
  const err = capture();
  const env = overrides.env ?? gitTestEnv();
  const deps: CliDeps = {
    cwd,
    env,
    stdout: out.write,
    stderr: err.write,
    runGit: makeRunGit(env),
    randomBytes: (size) => crypto.randomBytes(size),
    repoRoot: REPO_ROOT,
    validateSpec,
    compileApp,
    loadGenerator: async () => {
      throw new CliError(
        "ERR_GENERATOR_UNAVAILABLE",
        "no generator module injected in this test",
      );
    },
    ...overrides,
  };
  return { deps, out, err, env };
}

/** Run git and return trimmed stdout, for assertions on workspace repos. */
export async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const run = makeRunGit(gitTestEnv());
  const result = await run(args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in test: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export interface FakeGeneratorModule extends GeneratorModule {
  /** Descriptions passed to generateSpec, for asserting argument forwarding. */
  descriptions: string[];
}

/**
 * A contract-faithful stand-in for `@openrupiv/generator`
 * (specs/phase-1-contracts.md §3): `AnthropicSpecModel` replays canned
 * responses (repeating the last one when exhausted), and `generateSpec`
 * runs the real contract loop — parse (fences stripped) → validateSpec →
 * retry on failure, max 3 attempts, last errors on exhaustion.
 */
export function fakeGeneratorModule(responses: string[]): FakeGeneratorModule {
  class ReplayModel implements SpecModel {
    private queue = [...responses];
    private last: string | undefined;
    constructor(_opts?: { apiKey?: string; model?: string }) {}
    async complete(_req: SpecModelRequest): Promise<string> {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.last = next;
        return next;
      }
      if (this.last !== undefined) return this.last;
      throw new Error("ReplayModel has no canned responses");
    }
  }

  const descriptions: string[] = [];
  return {
    descriptions,
    AnthropicSpecModel: ReplayModel,
    async generateSpec(description: string, model: SpecModel): Promise<GenerateResult> {
      descriptions.push(description);
      let errors: SpecError[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const raw = await model.complete({
          system: "fake-system-prompt",
          user: description,
          maxTokens: 8192,
        });
        let candidate: unknown;
        try {
          candidate = JSON.parse(stripFences(raw));
        } catch (error) {
          errors = [
            {
              code: "ERR_SCHEMA",
              path: "",
              message: `candidate is not JSON: ${error instanceof Error ? error.message : String(error)}`,
            },
          ];
          continue;
        }
        const result = validateSpec(candidate);
        if (result.ok) return { ok: true, spec: result.spec, attempts: attempt };
        errors = result.errors;
      }
      return { ok: false, errors, attempts: 3 };
    },
  };
}
