/**
 * Commander wiring through `runCli`: command/option parsing, help/version,
 * and the usage exit code (1) staying distinct from the contract's 0/2/3/4.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { runNew } from "../src/commands/new";
import type { GenerateResultJson } from "../src/commands/generate";
import { EXIT_OK, EXIT_USAGE } from "../src/errors";
import { runCli } from "../src/program";
import {
  CANARY_API_KEY,
  fakeGeneratorModule,
  gitTestEnv,
  makeDeps,
  makeTmpDir,
} from "./helpers";

let tmp: string;

beforeEach(async () => {
  tmp = await makeTmpDir();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runCli", () => {
  it("wires `new <name>` through to the command", async () => {
    const { deps } = makeDeps(tmp);
    const code = await runCli(["new", "wired"], deps);
    expect(code).toBe(EXIT_OK);
    expect(existsSync(path.join(tmp, "wired", "openrupiv.yaml"))).toBe(true);
  });

  it("wires `generate --dir --json` through to the command", async () => {
    const scaffold = makeDeps(tmp);
    expect(await runCli(["new", "ws"], scaffold.deps)).toBe(EXIT_OK);

    const env = gitTestEnv({ ANTHROPIC_API_KEY: CANARY_API_KEY });
    const generator = fakeGeneratorModule([JSON.stringify(fixtures.vendorOnboardingSpec)]);
    const { deps, out } = makeDeps(tmp, { env, loadGenerator: async () => generator });
    const code = await runCli(
      ["generate", "vendor onboarding with 4-eyes review", "--dir", "ws", "--json"],
      deps,
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload.ok).toBe(true);
    expect(generator.descriptions).toEqual(["vendor onboarding with 4-eyes review"]);
  });

  it("--help exits 0 and prints usage", async () => {
    const { deps, out } = makeDeps(tmp);
    expect(await runCli(["--help"], deps)).toBe(EXIT_OK);
    expect(out.text()).toContain("Usage: openrupiv");
    expect(out.text()).toContain("generate");
  });

  it("--version exits 0", async () => {
    const { deps, out } = makeDeps(tmp);
    expect(await runCli(["--version"], deps)).toBe(EXIT_OK);
    expect(out.text()).toContain("0.1.0");
  });

  it("unknown commands exit 1 (usage), never a contract outcome code", async () => {
    const { deps, err } = makeDeps(tmp);
    expect(await runCli(["frobnicate"], deps)).toBe(EXIT_USAGE);
    expect(err.text()).toContain("unknown command");
  });

  it("a missing required argument exits 1 (usage)", async () => {
    const { deps, err } = makeDeps(tmp);
    expect(await runCli(["new"], deps)).toBe(EXIT_USAGE);
    expect(err.text()).toContain("missing required argument");
  });

  it("does not run `new` twice into the same directory even via the program layer", async () => {
    const first = makeDeps(tmp);
    expect(await runNew("dup", first.deps)).toBe(EXIT_OK);
    const second = makeDeps(tmp);
    expect(await runCli(["new", "dup"], second.deps)).toBe(4);
    expect(second.err.text()).toContain("ERR_WORKSPACE_EXISTS");
  });
});
