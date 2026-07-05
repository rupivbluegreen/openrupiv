import { describe, expect, it } from "vitest";
import type { AppSpec } from "@openrupiv/spec";
import { fixtures, validateSpec } from "@openrupiv/spec";
import { compileApp } from "../src/index";
import type { CompiledFile } from "../src/index";

const EXPECTED_PATHS = [
  "app/README.md",
  "app/migrations/0001_init.sql",
  "app/package.json",
  "app/server.mjs",
  "app/spec.json",
  "app/test/spec.test.mjs",
];

function compileOk(spec: AppSpec): CompiledFile[] {
  const result = compileApp(spec);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.files;
}

function fileByPath(files: CompiledFile[], path: string): CompiledFile {
  const file = files.find((f) => f.path === path);
  expect(file, `missing ${path}`).toBeDefined();
  if (!file) throw new Error("unreachable");
  return file;
}

describe("compileApp — output contract", () => {
  for (const fixture of fixtures.allFixtures) {
    it(`emits exactly the ADR-0004 app directory for ${fixture.app.slug}`, () => {
      const files = compileOk(fixture);
      expect(files.map((f) => f.path)).toEqual(EXPECTED_PATHS);
    });
  }

  it("sorts files by path ascending (code-unit order)", () => {
    const files = compileOk(fixtures.vendorOnboardingSpec);
    const paths = files.map((f) => f.path);
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(sorted);
  });

  it("emits spec.json as the exact canonical serialization", () => {
    const spec = fixtures.vendorOnboardingSpec;
    const files = compileOk(spec);
    const specJson = fileByPath(files, "app/spec.json");
    expect(specJson.contents).toBe(`${JSON.stringify(spec, null, 2)}\n`);
  });

  it("emits spec.json that round-trips through validateSpec", () => {
    for (const fixture of fixtures.allFixtures) {
      const files = compileOk(fixture);
      const parsed: unknown = JSON.parse(fileByPath(files, "app/spec.json").contents);
      const result = validateSpec(parsed);
      expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
    }
  });

  it("emits a zero-dependency package.json with exactly the contract shape", () => {
    const files = compileOk(fixtures.vendorOnboardingSpec);
    const pkg = JSON.parse(fileByPath(files, "app/package.json").contents) as Record<
      string,
      unknown
    >;
    expect(pkg).toEqual({
      name: "vendor-onboarding",
      private: true,
      type: "module",
      scripts: { test: "node --test test/" },
    });
    expect(Object.keys(pkg)).not.toContain("dependencies");
    expect(Object.keys(pkg)).not.toContain("devDependencies");
  });

  it("emits a guarded server.mjs entry", () => {
    const files = compileOk(fixtures.minimalSpec);
    const server = fileByPath(files, "app/server.mjs").contents;
    expect(server).toContain('await import("@openrupiv/runtime")');
    expect(server).toContain("serveAppDir(appDir)");
    expect(server).toContain("ERR_RUNTIME_NOT_INSTALLED");
    expect(server).toContain("process.exit(1)");
  });

  it("emits a node:test-only test file that reads spec.json and the migration", () => {
    const files = compileOk(fixtures.vendorOnboardingSpec);
    const testFile = fileByPath(files, "app/test/spec.test.mjs").contents;
    expect(testFile).toContain('from "node:test"');
    expect(testFile).toContain('from "node:assert/strict"');
    expect(testFile).toContain('from "node:fs"');
    // Zero-dependency promise: no non-builtin imports.
    const imports = [...testFile.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^node:/);
    }
  });

  it("does not mutate its input spec", () => {
    const spec = structuredClone(fixtures.vendorOnboardingSpec);
    compileApp(spec);
    expect(spec).toEqual(fixtures.vendorOnboardingSpec);
  });
});

describe("compileApp — determinism", () => {
  for (const fixture of fixtures.allFixtures) {
    it(`compiles ${fixture.app.slug} to byte-identical output twice`, () => {
      const first = compileOk(fixture);
      const second = compileOk(structuredClone(fixture));
      expect(second.length).toBe(first.length);
      for (const [i, file] of first.entries()) {
        expect(second[i]?.path).toBe(file.path);
        expect(second[i]?.contents).toBe(file.contents);
      }
    });
  }

  it("has no timestamp/randomness/environment sources in src/", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const srcDir = new URL("../src/", import.meta.url);
    const entries = await readdir(srcDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const source = await readFile(new URL(entry, srcDir), "utf8");
      expect(source, `${entry} must not read the clock`).not.toMatch(/\bDate\b/);
      expect(source, `${entry} must not use randomness`).not.toMatch(/Math\.random/);
      expect(source, `${entry} must not read the environment`).not.toMatch(/process\.env/);
      expect(source, `${entry} must not use locale collation`).not.toMatch(/localeCompare/);
    }
  });
});

describe("compileApp — unsupported sections", () => {
  function withSection(section: "policies" | "agents" | "evidence"): AppSpec {
    const spec = structuredClone(fixtures.minimalSpec);
    spec[section] = [{ name: "reserved-entry" }];
    return spec;
  }

  for (const section of ["policies", "agents", "evidence"] as const) {
    it(`rejects a non-empty ${section} section with ERR_UNSUPPORTED_SECTION at /${section}`, () => {
      const result = compileApp(withSection(section));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: "ERR_UNSUPPORTED_SECTION",
        path: `/${section}`,
      });
      expect(result.errors[0]?.message).toContain("not yet supported");
    });
  }

  it("reports every offending section in one pass", () => {
    const spec = structuredClone(fixtures.vendorOnboardingSpec);
    spec.policies = [{ name: "four-eyes" }];
    spec.agents = [{ name: "triage-bot" }];
    spec.evidence = [{ name: "approval-log" }];
    const result = compileApp(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(["/policies", "/agents", "/evidence"]);
    for (const error of result.errors) {
      expect(error.code).toBe("ERR_UNSUPPORTED_SECTION");
    }
  });

  it("accepts empty reserved sections (nothing to drop)", () => {
    const spec = structuredClone(fixtures.minimalSpec);
    spec.policies = [];
    spec.agents = [];
    spec.evidence = [];
    expect(compileApp(spec).ok).toBe(true);
  });
});
