/**
 * Regression guard for specs/phase-2-contracts.md §4 "Dependencies":
 * "@openrupiv/agents depends on @openrupiv/spec, @openrupiv/policy,
 * @openrupiv/audit only" and propose() "never touches workflow_approvals
 * ... verify this is naturally true from the dependency graph, not just
 * asserted". This checks the two things a *code* path would need: a real
 * `import ... from "@openrupiv/runtime"` statement (there is none), and an
 * actual SQL statement naming `workflow_approvals` (there is none -- and
 * `test/agent-runtime.test.ts`'s propose() tests additionally exercise this
 * behaviorally against every statement the FakeDb actually receives).
 *
 * Deliberately narrower than a blanket text search for either string: this
 * package's own doc comments legitimately mention both
 * (`@openrupiv/runtime`, `workflow_approvals`) to explain *why* no such
 * import or query exists, and a naive substring match would flag its own
 * documentation as a violation.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, "..");

const RUNTIME_IMPORT = /\bfrom\s+["']@openrupiv\/runtime["']/;
const WORKFLOW_APPROVALS_SQL = /\b(INSERT INTO|SELECT[^;]*FROM|UPDATE|DELETE FROM)\s+"?workflow_approvals\b/i;

describe("dependency graph (specs/phase-2-contracts.md §4 'Dependencies')", () => {
  it("package.json declares only @openrupiv/spec, @openrupiv/policy, @openrupiv/audit (+ ajv) as dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    expect(deps).toEqual(["@openrupiv/audit", "@openrupiv/policy", "@openrupiv/spec", "ajv"].sort());
  });

  it("no source file imports @openrupiv/runtime or issues SQL against workflow_approvals", () => {
    const srcDir = path.join(PACKAGE_ROOT, "src");
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith(".ts")) continue;
      const contents = readFileSync(path.join(srcDir, file), "utf8");
      if (RUNTIME_IMPORT.test(contents) || WORKFLOW_APPROVALS_SQL.test(contents)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
