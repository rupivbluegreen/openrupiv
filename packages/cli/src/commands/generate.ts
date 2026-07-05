/**
 * `openrupiv generate "<description>" [--dir] [--json]` — the ADR-0001
 * pipeline: LLM → spec (generator, validated, retried) → deterministic
 * compile → files written into the workspace ./app → DCO-signed commit in
 * the WORKSPACE repo.
 *
 * Exit codes (specs/phase-1-contracts.md §4): 0 ok, 2 generation/validation
 * failed after retries, 3 compile failed, 4 environment error.
 *
 * --json: stdout carries EXACTLY ONE JSON object
 * `{ ok, files, errors, attempts }` and nothing else; all human chatter
 * goes to stderr.
 *
 * Security: ANTHROPIC_API_KEY is only ever checked for presence — its value
 * is never read into a message, logged, or written to disk by the CLI.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppSpec } from "@openrupiv/spec";
import type { CompiledFile } from "@openrupiv/compiler";
import type { CliDeps } from "../deps";
import {
  CliError,
  EXIT_COMPILE_FAILED,
  EXIT_GENERATE_FAILED,
  EXIT_OK,
  type ReportedError,
} from "../errors";
import { git } from "../git";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD } from "../workspace-files";

export interface GenerateOptions {
  /** Workspace directory; defaults to the current directory. */
  dir?: string;
  /** Emit the machine-readable result object on stdout. */
  json?: boolean;
}

/** The --json payload shape fixed by the contract. */
export interface GenerateResultJson {
  ok: boolean;
  files: string[];
  errors: ReportedError[];
  attempts: number;
}

export async function runGenerate(
  description: string,
  opts: GenerateOptions,
  deps: CliDeps,
): Promise<number> {
  const json = opts.json === true;
  // Human chatter: stdout normally, stderr in --json mode (stdout is JSON-only).
  const info = (text: string) => (json ? deps.stderr : deps.stdout)(text);

  let payload: GenerateResultJson;
  let exitCode: number;
  try {
    const outcome = await doGenerate(description, opts, deps, info);
    payload = outcome.payload;
    exitCode = outcome.exitCode;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    payload = { ok: false, files: [], errors: [error.toReportedError()], attempts: 0 };
    exitCode = error.exitCode;
  }

  if (json) {
    deps.stdout(`${JSON.stringify(payload)}\n`);
  }
  if (!payload.ok) {
    deps.stderr(
      `openrupiv generate: failed with ${payload.errors.length} error(s) after ` +
        `${payload.attempts} attempt(s) (exit ${exitCode})\n`,
    );
    for (const err of payload.errors) {
      deps.stderr(`  ${err.code} ${err.path === "" ? "(root)" : err.path} — ${err.message}\n`);
    }
  }
  return exitCode;
}

async function doGenerate(
  description: string,
  opts: GenerateOptions,
  deps: CliDeps,
  info: (text: string) => void,
): Promise<{ payload: GenerateResultJson; exitCode: number }> {
  const workspace = await resolveWorkspace(opts.dir, deps);
  requireApiKey(deps.env);

  const generator = await deps.loadGenerator();
  const model = new generator.AnthropicSpecModel();

  info(`Generating app spec from description (up to 3 attempts)…\n`);
  const generated = await generator.generateSpec(description, model);
  if (!generated.ok) {
    return {
      exitCode: EXIT_GENERATE_FAILED,
      payload: { ok: false, files: [], errors: generated.errors, attempts: generated.attempts },
    };
  }

  // Defense in depth: the generator contract promises a validated spec, but
  // the CLI is the last gate before files hit disk — re-check, never trust.
  const validated = deps.validateSpec(generated.spec);
  if (!validated.ok) {
    return {
      exitCode: EXIT_GENERATE_FAILED,
      payload: { ok: false, files: [], errors: validated.errors, attempts: generated.attempts },
    };
  }

  const compiled = deps.compileApp(validated.spec);
  if (!compiled.ok) {
    return {
      exitCode: EXIT_COMPILE_FAILED,
      payload: { ok: false, files: [], errors: compiled.errors, attempts: generated.attempts },
    };
  }

  await writeCompiledFiles(workspace, compiled.files);
  const commit = await commitGenerated(workspace, validated.spec, description, deps);

  const filePaths = compiled.files.map((f) => f.path);
  info(
    `Generated app "${validated.spec.app.slug}" (${generated.attempts} attempt(s)):\n` +
      filePaths.map((p) => `  ${p}\n`).join("") +
      (commit === null
        ? `No changes against the previous generation — nothing new to commit.\n`
        : `Committed to the workspace repository (${commit}).\n`) +
      `\nNext steps:\n` +
      `  docker compose up --build\n` +
      `  open http://localhost:3000 and log in as ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}\n` +
      `  (first time: \`echo "127.0.0.1 dex" | sudo tee -a /etc/hosts\` so the login redirect resolves — see README.md)\n`,
  );

  return {
    exitCode: EXIT_OK,
    payload: { ok: true, files: filePaths, errors: [], attempts: generated.attempts },
  };
}

/** Presence check only — the key's VALUE is never read into any output. */
function requireApiKey(env: NodeJS.ProcessEnv): void {
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new CliError(
      "ERR_MISSING_API_KEY",
      "ANTHROPIC_API_KEY is not set. `openrupiv generate` calls the Anthropic API to " +
        "produce the app spec (and only the spec — ADR-0001). Export your key first, " +
        "e.g. `export ANTHROPIC_API_KEY=<your key>`. The key is read from the " +
        "environment only: openrupiv never writes it to disk and never echoes it.",
    );
  }
}

async function resolveWorkspace(dir: string | undefined, deps: CliDeps): Promise<string> {
  const workspace = path.resolve(deps.cwd, dir ?? ".");
  const configPath = path.join(workspace, "openrupiv.yaml");
  if (!existsSync(configPath)) {
    throw new CliError(
      "ERR_NOT_A_WORKSPACE",
      `${workspace} is not an openrupiv workspace (no openrupiv.yaml). ` +
        `Run \`openrupiv new <name>\` first, or pass --dir <workspace>.`,
    );
  }
  if (!existsSync(path.join(workspace, ".git"))) {
    throw new CliError(
      "ERR_NOT_A_WORKSPACE",
      `${workspace} is not a git repository — generated apps are committed to the ` +
        `workspace repo. \`openrupiv new\` creates it; run git init -b main to repair.`,
    );
  }

  let config: unknown;
  try {
    config = parseYaml(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new CliError(
      "ERR_BAD_WORKSPACE_CONFIG",
      `failed to parse openrupiv.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const specVersion =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>)["specVersion"]
      : undefined;
  if (specVersion !== "0.1") {
    throw new CliError(
      "ERR_BAD_WORKSPACE_CONFIG",
      `openrupiv.yaml declares specVersion ${JSON.stringify(specVersion)}; ` +
        `this CLI supports "0.1"`,
    );
  }
  return workspace;
}

/**
 * Replace the workspace ./app directory with the compiled files. Every path
 * must stay inside ./app — a compiler emitting anything else is a compile
 * failure (exit 3), enforced here as the last line of defense.
 */
async function writeCompiledFiles(workspace: string, files: CompiledFile[]): Promise<void> {
  const appRoot = path.resolve(workspace, "app");
  for (const file of files) {
    const abs = path.resolve(workspace, ...file.path.split("/"));
    const insideApp = abs === appRoot || abs.startsWith(appRoot + path.sep);
    if (!file.path.startsWith("app/") || path.isAbsolute(file.path) || !insideApp) {
      throw new CliError(
        "ERR_COMPILED_PATH",
        `compiler emitted a file outside the workspace app directory: ${JSON.stringify(file.path)}`,
        EXIT_COMPILE_FAILED,
      );
    }
  }
  await rm(appRoot, { recursive: true, force: true });
  for (const file of files) {
    const abs = path.resolve(workspace, ...file.path.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, "utf8");
  }
}

/**
 * Stage and commit the generation with the user's own git identity,
 * DCO-signed. Returns the short commit hash, or null when regeneration
 * produced byte-identical output (nothing to commit is not an error —
 * determinism makes it the expected steady state, ADR-0001).
 */
async function commitGenerated(
  workspace: string,
  spec: AppSpec,
  description: string,
  deps: CliDeps,
): Promise<string | null> {
  await git(deps.runGit, workspace, "add", "-A");
  const status = await git(deps.runGit, workspace, "status", "--porcelain");
  if (status.trim() === "") {
    return null;
  }
  await git(
    deps.runGit,
    workspace,
    "commit",
    "-s",
    "-m",
    `feat(app): generate ${spec.app.slug}`,
    "-m",
    `Prompt: ${description}\n\nSpec generated by the LLM, validated against spec v0.1, and\nprojected deterministically by @openrupiv/compiler (ADR-0001).`,
  );
  const sha = await git(deps.runGit, workspace, "rev-parse", "--short", "HEAD");
  return sha.trim();
}
