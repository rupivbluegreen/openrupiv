/**
 * `openrupiv generate` — the full pipeline against a real temp workspace
 * with real git and the REAL @openrupiv/compiler; only the LLM seam is a
 * fake generator module replaying fixtures.vendorOnboardingSpec (no
 * network, no ANTHROPIC_API_KEY). Verifies the contract exit codes
 * (0/2/3/4), the --json output shape and stdout purity, the workspace
 * commit, and that the API key value never leaks into output.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import type { AppSpec } from "@openrupiv/spec";
import { runGenerate, type GenerateResultJson } from "../src/commands/generate";
import { runNew } from "../src/commands/new";
import {
  EXIT_COMPILE_FAILED,
  EXIT_ENVIRONMENT,
  EXIT_GENERATE_FAILED,
  EXIT_OK,
} from "../src/errors";
import type { RunGit } from "../src/git";
import { makeRunGit } from "../src/git";
import {
  CANARY_API_KEY,
  fakeGeneratorModule,
  gitOut,
  gitTestEnv,
  makeDeps,
  makeTmpDir,
  type TestContext,
} from "./helpers";

const FIXTURE = fixtures.vendorOnboardingSpec;
const FIXTURE_JSON = JSON.stringify(FIXTURE);
const EXPECTED_FILES = [
  "app/README.md",
  "app/migrations/0001_init.sql",
  "app/package.json",
  "app/server.mjs",
  "app/spec.json",
  "app/test/spec.test.mjs",
];

let tmp: string;
let ws: string;

beforeEach(async () => {
  tmp = await makeTmpDir();
  const { deps } = makeDeps(tmp);
  expect(await runNew("ws", deps)).toBe(EXIT_OK);
  ws = path.join(tmp, "ws");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Deps wired for generation: API key present, fake generator replaying `responses`. */
function generateDeps(responses: string[]): TestContext & {
  generator: ReturnType<typeof fakeGeneratorModule>;
} {
  const env = gitTestEnv({ ANTHROPIC_API_KEY: CANARY_API_KEY });
  const generator = fakeGeneratorModule(responses);
  const ctx = makeDeps(ws, { env, loadGenerator: async () => generator });
  return { ...ctx, generator };
}

describe("openrupiv generate — happy path (exit 0)", () => {
  it("writes the compiled app, commits it DCO-signed, and prints next steps", async () => {
    const { deps, out, generator } = generateDeps([FIXTURE_JSON]);
    const code = await runGenerate("vendor onboarding with 4-eyes review", {}, deps);
    expect(code).toBe(EXIT_OK);

    // The description is forwarded verbatim to the generator.
    expect(generator.descriptions).toEqual(["vendor onboarding with 4-eyes review"]);

    // All compiled files exist; spec.json round-trips the fixture exactly.
    for (const rel of EXPECTED_FILES) {
      expect(existsSync(path.join(ws, rel)), `${rel} should exist`).toBe(true);
    }
    const specOnDisk = JSON.parse(readFileSync(path.join(ws, "app/spec.json"), "utf8")) as AppSpec;
    expect(specOnDisk).toEqual(FIXTURE);
    expect(readFileSync(path.join(ws, "app/migrations/0001_init.sql"), "utf8")).toContain(
      "vendor_application",
    );

    // Workspace repo: scaffold commit + generation commit, signed off, clean tree.
    expect(await gitOut(ws, "rev-list", "--count", "HEAD")).toBe("2");
    const body = await gitOut(ws, "log", "-1", "--format=%B");
    expect(body).toContain("feat(app): generate vendor-onboarding");
    expect(body).toContain("Signed-off-by: Test User <test@example.com>");
    expect(await gitOut(ws, "status", "--porcelain")).toBe("");
    expect((await gitOut(ws, "ls-files")).split("\n")).toContain("app/spec.json");

    // Human output: file list + next steps.
    const stdout = out.text();
    for (const rel of EXPECTED_FILES) expect(stdout).toContain(rel);
    expect(stdout).toContain("docker compose up");
    expect(stdout).toContain("dev@example.com");
  });

  it("--json emits exactly one JSON object on stdout and nothing else", async () => {
    const { deps, out, err } = generateDeps([FIXTURE_JSON]);
    const code = await runGenerate("vendor onboarding", { json: true }, deps);
    expect(code).toBe(EXIT_OK);

    // JSON.parse over the ENTIRE stdout proves there is no extra chatter.
    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload).toEqual({
      ok: true,
      files: EXPECTED_FILES,
      errors: [],
      attempts: 1,
    });
    // Human chatter went to stderr instead.
    expect(err.text()).toContain("Generating app spec");
  });

  it("re-generating identical output succeeds without a new commit", async () => {
    const first = generateDeps([FIXTURE_JSON]);
    expect(await runGenerate("vendor onboarding", {}, first.deps)).toBe(EXIT_OK);
    const second = generateDeps([FIXTURE_JSON]);
    const code = await runGenerate("vendor onboarding", {}, second.deps);
    expect(code).toBe(EXIT_OK);
    expect(await gitOut(ws, "rev-list", "--count", "HEAD")).toBe("2");
    expect(second.out.text()).toContain("nothing new to commit");
  });

  it("succeeds on a retry after invalid model output (attempts reported)", async () => {
    const invalid = JSON.stringify({ specVersion: "9.9" });
    const { deps, out } = generateDeps([invalid, FIXTURE_JSON]);
    const code = await runGenerate("vendor onboarding", { json: true }, deps);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload.ok).toBe(true);
    expect(payload.attempts).toBe(2);
  });

  it("--dir resolves the workspace from elsewhere", async () => {
    const env = gitTestEnv({ ANTHROPIC_API_KEY: CANARY_API_KEY });
    const generator = fakeGeneratorModule([FIXTURE_JSON]);
    // cwd is the tmp root, not the workspace.
    const { deps } = makeDeps(tmp, { env, loadGenerator: async () => generator });
    const code = await runGenerate("vendor onboarding", { dir: "ws" }, deps);
    expect(code).toBe(EXIT_OK);
    expect(existsSync(path.join(ws, "app/spec.json"))).toBe(true);
  });
});

describe("openrupiv generate — generation failure (exit 2)", () => {
  it("exhausts 3 attempts on persistently invalid specs and reports the last errors", async () => {
    const invalid = JSON.stringify({ specVersion: "9.9" });
    const { deps, out, err } = generateDeps([invalid]);
    const code = await runGenerate("hopeless", { json: true }, deps);
    expect(code).toBe(EXIT_GENERATE_FAILED);

    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload.ok).toBe(false);
    expect(payload.attempts).toBe(3);
    expect(payload.files).toEqual([]);
    expect(payload.errors[0]?.code).toBe("ERR_SPEC_VERSION");
    expect(err.text()).toContain("ERR_SPEC_VERSION");

    // Nothing was written, nothing was committed.
    expect(existsSync(path.join(ws, "app"))).toBe(false);
    expect(await gitOut(ws, "rev-list", "--count", "HEAD")).toBe("1");
  });
});

describe("openrupiv generate — compile failure (exit 3)", () => {
  it("rejects unsupported sections (policies) with ERR_UNSUPPORTED_SECTION", async () => {
    const withPolicies = JSON.stringify({
      ...FIXTURE,
      policies: [{ name: "deny-all" }],
    });
    const { deps, out } = generateDeps([withPolicies]);
    const code = await runGenerate("vendor onboarding with policies", { json: true }, deps);
    expect(code).toBe(EXIT_COMPILE_FAILED);

    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload.ok).toBe(false);
    expect(payload.attempts).toBe(1);
    expect(payload.errors[0]?.code).toBe("ERR_UNSUPPORTED_SECTION");
    expect(payload.errors[0]?.path).toBe("/policies");
    expect(existsSync(path.join(ws, "app"))).toBe(false);
  });

  it("refuses compiled paths that escape ./app (defense in depth)", async () => {
    const { deps, err } = generateDeps([FIXTURE_JSON]);
    deps.compileApp = () => ({
      ok: true,
      files: [{ path: "app/../evil.txt", contents: "boom" }],
    });
    const code = await runGenerate("escape attempt", {}, deps);
    expect(code).toBe(EXIT_COMPILE_FAILED);
    expect(err.text()).toContain("ERR_COMPILED_PATH");
    expect(existsSync(path.join(ws, "evil.txt"))).toBe(false);
  });
});

describe("openrupiv generate — environment failures (exit 4)", () => {
  it("requires ANTHROPIC_API_KEY with a helpful, non-echoing message", async () => {
    const env = gitTestEnv(); // no key
    const generator = fakeGeneratorModule([FIXTURE_JSON]);
    const { deps, err } = makeDeps(ws, { env, loadGenerator: async () => generator });
    const code = await runGenerate("vendor onboarding", {}, deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_MISSING_API_KEY");
    expect(err.text()).toContain("ANTHROPIC_API_KEY");
  });

  it("never echoes the API key value in any output, success or failure", async () => {
    const ok = generateDeps([FIXTURE_JSON]);
    await runGenerate("vendor onboarding", { json: true }, ok.deps);
    const bad = generateDeps([JSON.stringify({ specVersion: "9.9" })]);
    await runGenerate("vendor onboarding", {}, bad.deps);
    for (const text of [ok.out.text(), ok.err.text(), bad.out.text(), bad.err.text()]) {
      expect(text).not.toContain(CANARY_API_KEY);
    }
  });

  it("rejects a directory that is not a workspace (human and --json)", async () => {
    const stray = path.join(tmp, "stray");
    await mkdir(stray);
    const env = gitTestEnv({ ANTHROPIC_API_KEY: CANARY_API_KEY });
    const human = makeDeps(stray, { env });
    expect(await runGenerate("x", {}, human.deps)).toBe(EXIT_ENVIRONMENT);
    expect(human.err.text()).toContain("ERR_NOT_A_WORKSPACE");

    const machine = makeDeps(stray, { env });
    expect(await runGenerate("x", { json: true }, machine.deps)).toBe(EXIT_ENVIRONMENT);
    const payload = JSON.parse(machine.out.text()) as GenerateResultJson;
    expect(payload).toEqual({
      ok: false,
      files: [],
      errors: [
        { code: "ERR_NOT_A_WORKSPACE", path: "", message: expect.stringContaining("openrupiv.yaml") },
      ],
      attempts: 0,
    });
  });

  it("rejects a workspace whose openrupiv.yaml declares an unsupported version", async () => {
    await writeFile(path.join(ws, "openrupiv.yaml"), 'specVersion: "9.9"\napp: null\n', "utf8");
    const { deps, err } = generateDeps([FIXTURE_JSON]);
    expect(await runGenerate("x", {}, deps)).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_BAD_WORKSPACE_CONFIG");
  });

  it("rejects a workspace without a git repository", async () => {
    await rm(path.join(ws, ".git"), { recursive: true, force: true });
    const { deps, err } = generateDeps([FIXTURE_JSON]);
    expect(await runGenerate("x", {}, deps)).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_NOT_A_WORKSPACE");
  });

  it("reports an unavailable generator module as a typed environment error", async () => {
    const env = gitTestEnv({ ANTHROPIC_API_KEY: CANARY_API_KEY });
    const { deps, out } = makeDeps(ws, { env }); // default loadGenerator throws
    const code = await runGenerate("x", { json: true }, deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    const payload = JSON.parse(out.text()) as GenerateResultJson;
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("ERR_GENERATOR_UNAVAILABLE");
  });

  it("maps a failing workspace commit to exit 4 (ERR_GIT)", async () => {
    const { deps, err, env } = generateDeps([FIXTURE_JSON]);
    const real = makeRunGit(env);
    const failingCommit: RunGit = async (args, opts) => {
      if (args[0] === "commit") {
        return { code: 128, stdout: "", stderr: "fatal: empty ident name not allowed" };
      }
      return real(args, opts);
    };
    deps.runGit = failingCommit;
    const code = await runGenerate("vendor onboarding", {}, deps);
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.text()).toContain("ERR_GIT");
  });
});
