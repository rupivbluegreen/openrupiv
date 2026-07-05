/**
 * End-to-end through the dev-mode bin wrapper (bin/openrupiv.mjs → tsx →
 * src/main.ts): real process, real exit codes, real stdout/stderr split.
 * `new` is offline by contract, and the failing `generate` below exits at
 * the workspace check — so no network and no API key are ever involved.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateResultJson } from "../src/commands/generate";
import { gitTestEnv, makeTmpDir } from "./helpers";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "openrupiv.mjs");

let tmp: string;

beforeEach(async () => {
  tmp = await makeTmpDir();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runBin(args: string[], cwd: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: gitTestEnv(),
    encoding: "utf8",
    timeout: 180_000,
  });
}

describe("bin/openrupiv.mjs (tsx dev-mode wrapper)", () => {
  it("`new` scaffolds a workspace and exits 0; a rerun exits 4", { timeout: 240_000 }, () => {
    const first = runBin(["new", "e2e-ws"], tmp);
    expect(first.error).toBeUndefined();
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Created workspace e2e-ws/");
    for (const rel of ["openrupiv.yaml", "docker-compose.yaml", "dex/config.yaml", ".env"]) {
      expect(existsSync(path.join(tmp, "e2e-ws", rel)), rel).toBe(true);
    }

    const second = runBin(["new", "e2e-ws"], tmp);
    expect(second.status).toBe(4);
    expect(second.stderr).toContain("ERR_WORKSPACE_EXISTS");
  });

  it("`generate --json` against a non-workspace exits 4 with pure JSON on stdout", { timeout: 240_000 }, async () => {
    await mkdir(path.join(tmp, "not-a-ws"));
    const result = runBin(["generate", "anything", "--dir", "not-a-ws", "--json"], tmp);
    expect(result.status).toBe(4);
    const payload = JSON.parse(result.stdout) as GenerateResultJson;
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("ERR_NOT_A_WORKSPACE");
    expect(result.stderr).toContain("ERR_NOT_A_WORKSPACE");
  });
});
