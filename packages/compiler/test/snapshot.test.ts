/**
 * Full-output snapshots per corpus spec (ADR-0001: spec → code is a
 * byte-identical projection, so the snapshot IS the contract of record).
 * Regenerate deliberately with `vitest run -u` and review the diff like
 * any other code change.
 */
import { describe, expect, it } from "vitest";
import { fixtures } from "@openrupiv/spec";
import { compileApp } from "../src/index";

function renderTree(spec: (typeof fixtures.allFixtures)[number]): string {
  const result = compileApp(spec);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.files
    .map((file) => `================ ${file.path} ================\n${file.contents}`)
    .join("\n");
}

describe("compileApp — full output snapshots", () => {
  it("vendorOnboardingSpec", () => {
    expect(renderTree(fixtures.vendorOnboardingSpec)).toMatchSnapshot();
  });

  it("minimalSpec", () => {
    expect(renderTree(fixtures.minimalSpec)).toMatchSnapshot();
  });

  it("projectTrackerSpec", () => {
    expect(renderTree(fixtures.projectTrackerSpec)).toMatchSnapshot();
  });
});
