/**
 * The "delete the platform" proof: write a compiled app to a temp
 * directory and run its own test suite with plain `node --test` — no
 * pnpm install, no node_modules, no platform code. Also proves the
 * generated tests actually assert (a tampered artifact fails).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppSpec } from "@openrupiv/spec";
import { fixtures } from "@openrupiv/spec";
import { compileApp } from "../src/index";
import type { CompiledFile } from "../src/index";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCompiledApp(spec: AppSpec): string {
  const result = compileApp(spec);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("unreachable");
  const workspace = mkdtempSync(join(tmpdir(), "openrupiv-compiler-"));
  tempDirs.push(workspace);
  for (const file of result.files satisfies CompiledFile[]) {
    const target = join(workspace, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
  }
  return join(workspace, "app");
}

function runAppTests(appDir: string): SpawnSyncReturns<string> {
  // Exactly the app package.json's test script: `node --test` (bare form —
  // positional directory args resolve differently across Node 20/22).
  return spawnSync(process.execPath, ["--test"], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("compiled app runs standalone with plain node", () => {
  for (const fixture of fixtures.allFixtures) {
    it(`${fixture.app.slug}: node --test passes with zero installs`, () => {
      const appDir = writeCompiledApp(fixture);
      const run = runAppTests(appDir);
      expect(
        run.status,
        `exit ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      ).toBe(0);
      expect(run.stdout).toContain("pass");
      expect(run.stdout).toContain("fail 0");
    });
  }

  it("declares zero dependencies in the compiled package.json", () => {
    const appDir = writeCompiledApp(fixtures.vendorOnboardingSpec);
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkg["devDependencies"]).toBeUndefined();
  });

  it("fails loudly when the migration is missing a required table", () => {
    const appDir = writeCompiledApp(fixtures.vendorOnboardingSpec);
    const migrationPath = join(appDir, "migrations", "0001_init.sql");
    const tampered = readFileSync(migrationPath, "utf8").replace(
      "CREATE TABLE vendor_application (",
      "CREATE TABLE somewhere_else (",
    );
    writeFileSync(migrationPath, tampered);
    const run = runAppTests(appDir);
    expect(run.status, "tampered migration must fail the app's own tests").not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("vendor_application");
  });

  it("fails loudly when spec.json is tampered below the 4-eyes threshold", () => {
    const appDir = writeCompiledApp(fixtures.vendorOnboardingSpec);
    const specPath = join(appDir, "spec.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
      workflows: { transitions: { approval?: { count: number } }[] }[];
    };
    const approve = spec.workflows[0]?.transitions.find((t) => t.approval !== undefined);
    expect(approve?.approval).toBeDefined();
    if (approve?.approval) approve.approval.count = 1;
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    const run = runAppTests(appDir);
    expect(run.status, "a 1-approver approval rule must fail the app's own tests").not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("distinct approvers");
  });
});
