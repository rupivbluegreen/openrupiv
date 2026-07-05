/**
 * `openrupiv new <name>` — deterministic, offline workspace scaffold
 * (specs/phase-1-contracts.md §4): git init -b main, openrupiv.yaml,
 * README quickstart, .gitignore, generated .env (gitignored),
 * docker-compose.yaml, dex/config.yaml, and a DCO-signed initial commit.
 * No network, no LLM.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CliDeps } from "../deps";
import { CliError, EXIT_OK } from "../errors";
import { git } from "../git";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD, workspaceFiles } from "../workspace-files";

/** Directory-safe kebab-case: lowercase start, then lowercase/digits/hyphens. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export async function runNew(name: string, deps: CliDeps): Promise<number> {
  try {
    await createWorkspace(name, deps);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliError) {
      deps.stderr(`openrupiv new: ${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function createWorkspace(name: string, deps: CliDeps): Promise<void> {
  if (!NAME_PATTERN.test(name)) {
    throw new CliError(
      "ERR_BAD_NAME",
      `workspace name ${JSON.stringify(name)} must be kebab-case ` +
        `(lowercase letter first, then lowercase letters, digits, or hyphens; max 64 chars)`,
    );
  }

  const target = path.resolve(deps.cwd, name);
  if (existsSync(target)) {
    throw new CliError(
      "ERR_WORKSPACE_EXISTS",
      `target directory already exists: ${target} — choose another name or remove it first`,
    );
  }

  await mkdir(target, { recursive: true });
  try {
    const sessionSecret = deps.randomBytes(32).toString("hex");
    const files = workspaceFiles({ name, sessionSecret, repoRoot: deps.repoRoot });
    for (const file of files) {
      const abs = path.join(target, ...file.path.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, file.contents, "utf8");
    }

    await git(deps.runGit, target, "init", "-b", "main");
    await git(deps.runGit, target, "add", "-A");
    await git(
      deps.runGit,
      target,
      "commit",
      "-s",
      "-m",
      `chore(${name}): scaffold openrupiv workspace`,
      "-m",
      "Created by `openrupiv new`: workspace config, Compose dev stack " +
        "(postgres + DEV-ONLY Dex IdP + runtime), and quickstart README.",
    );

    const tracked = files.filter((f) => f.path !== ".env").map((f) => f.path);
    deps.stdout(
      `Created workspace ${name}/ (git initialized on main, initial commit signed off)\n` +
        tracked.map((p) => `  ${p}\n`).join("") +
        `  .env  (gitignored — generated SESSION_SECRET, OPENRUPIV_REPO)\n` +
        `\nNext steps:\n` +
        `  cd ${name}\n` +
        `  openrupiv generate "an approval workflow for vendor onboarding with 4-eyes review"\n` +
        `  docker compose up --build   # then open http://localhost:3000 and log in as ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}\n` +
        `\nSee README.md for the full quickstart (including the one-time /etc/hosts entry for Dex).\n`,
    );
  } catch (error) {
    // Never leave a half-created workspace behind.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
