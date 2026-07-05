/**
 * Golden corpus tests (specs/phase-1-contracts.md §3). These run with
 * FakeSpecModel — no network — and validate the harness plus the corpus
 * specs themselves. The live-model run of the same corpus is `pnpm eval`.
 */

import { fixtures, validateSpec } from "@openrupiv/spec";
import { describe, expect, it } from "vitest";
import { compareSpecs } from "../src/compare";
import { generateSpec } from "../src/generate";
import { FakeSpecModel } from "../src/model";
import { loadCorpus } from "../src/corpus";

const corpus = loadCorpus();

describe("golden corpus", () => {
  it("has at least 12 entries", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(12);
  });

  describe.each(corpus)("$name", (entry) => {
    it("expected spec passes validateSpec", () => {
      const result = validateSpec(entry.expected);
      expect(result).toMatchObject({ ok: true });
    });

    it("generateSpec with a replaying FakeSpecModel returns the expected spec", async () => {
      const model = new FakeSpecModel([JSON.stringify(entry.expected)]);
      const result = await generateSpec(entry.prompt, model);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.attempts).toBe(1);
      expect(compareSpecs(entry.expected, result.spec)).toEqual([]);
    });
  });

  it("the 4-eyes vendor onboarding prompt maps to fixtures.vendorOnboardingSpec", () => {
    const entry = corpus.find((e) => e.name === "vendor-onboarding");
    expect(entry).toBeDefined();
    expect(entry!.prompt.toLowerCase()).toContain("vendor onboarding");
    expect(entry!.prompt.toLowerCase()).toContain("4-eyes");
    expect(compareSpecs(fixtures.vendorOnboardingSpec, entry!.expected)).toEqual([]);
  });

  describe("coverage of the v0 schema surface", () => {
    const specs = corpus.map((e) => e.expected);
    const transitions = specs.flatMap((s) =>
      (s.workflows ?? []).flatMap((w) => w.transitions),
    );

    it("includes a plain CRUD app (pages, no workflow, no roles)", () => {
      expect(
        specs.some(
          (s) =>
            (s.pages?.length ?? 0) > 0 &&
            (s.workflows ?? []).length === 0 &&
            (s.app.roles ?? []).length === 0,
        ),
      ).toBe(true);
    });

    it("includes an enum-heavy entity (>= 3 enum fields)", () => {
      expect(
        specs.some((s) =>
          s.entities.some((e) => e.fields.filter((f) => f.type === "enum").length >= 3),
        ),
      ).toBe(true);
    });

    it("includes reference fields", () => {
      expect(
        specs.some((s) => s.entities.some((e) => e.fields.some((f) => f.type === "reference"))),
      ).toBe(true);
    });

    it("includes a manyToMany relation", () => {
      expect(
        specs.some((s) =>
          s.entities.some((e) => (e.relations ?? []).some((r) => r.kind === "manyToMany")),
        ),
      ).toBe(true);
    });

    it("includes a single-approval workflow (role guards only, no approval rule)", () => {
      expect(
        specs.some((s) =>
          (s.workflows ?? []).some(
            (w) =>
              w.transitions.every((t) => !t.approval) &&
              w.transitions.some((t) => (t.guard?.roles?.length ?? 0) > 0),
          ),
        ),
      ).toBe(true);
    });

    it("includes 4-eyes approval rules (count >= 2) on more than one app", () => {
      const approvalSpecs = specs.filter((s) =>
        (s.workflows ?? []).some((w) => w.transitions.some((t) => (t.approval?.count ?? 0) >= 2)),
      );
      expect(approvalSpecs.length).toBeGreaterThanOrEqual(2);
    });

    it("includes predicate guards", () => {
      expect(transitions.some((t) => (t.guard?.require?.length ?? 0) > 0)).toBe(true);
    });

    it("includes a multi-entity app (>= 3 entities)", () => {
      expect(specs.some((s) => s.entities.length >= 3)).toBe(true);
    });

    it("includes a minimal one-entity app", () => {
      expect(
        specs.some(
          (s) =>
            s.entities.length === 1 &&
            (s.workflows ?? []).length === 0 &&
            (s.app.roles ?? []).length === 0,
        ),
      ).toBe(true);
    });

    it("includes a role-rich app (>= 4 roles)", () => {
      expect(specs.some((s) => (s.app.roles ?? []).length >= 4)).toBe(true);
    });
  });
});
