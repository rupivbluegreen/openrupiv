import { fixtures, type AppSpec } from "@openrupiv/spec";
import { describe, expect, it } from "vitest";
import { compareSpecs } from "../src/compare";

function clone(spec: AppSpec): AppSpec {
  return JSON.parse(JSON.stringify(spec)) as AppSpec;
}

describe("compareSpecs", () => {
  it("reports no diffs for identical specs", () => {
    expect(compareSpecs(fixtures.vendorOnboardingSpec, clone(fixtures.vendorOnboardingSpec))).toEqual([]);
    expect(compareSpecs(fixtures.projectTrackerSpec, clone(fixtures.projectTrackerSpec))).toEqual([]);
    expect(compareSpecs(fixtures.minimalSpec, clone(fixtures.minimalSpec))).toEqual([]);
  });

  it("ignores descriptions, titles, and app metadata", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.app.name = "Totally Different Name";
    actual.app.slug = "totally-different";
    actual.app.description = "Rewritten description.";
    actual.app.version = "9.9.9";
    actual.entities[0]!.description = "Different entity description";
    actual.pages![0]!.title = "Different title";
    expect(compareSpecs(fixtures.vendorOnboardingSpec, actual)).toEqual([]);
  });

  it("ignores field required/unique/default and page field selection", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    delete actual.entities[0]!.fields[0]!.unique;
    delete actual.entities[0]!.fields[1]!.required;
    delete actual.entities[0]!.fields[3]!.default;
    delete actual.pages![2]!.fields;
    expect(compareSpecs(fixtures.vendorOnboardingSpec, actual)).toEqual([]);
  });

  it("is order-insensitive for entities, fields, pages, workflows, and roles", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.entities.reverse();
    actual.entities[0]!.fields.reverse();
    actual.pages!.reverse();
    actual.app.roles!.reverse();
    actual.workflows![0]!.transitions.reverse();
    expect(compareSpecs(fixtures.vendorOnboardingSpec, actual)).toEqual([]);
  });

  it("flags a field type mismatch", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.entities[1]!.fields[2]! = { name: "annualSpend", type: "string" };
    const diffs = compareSpecs(fixtures.vendorOnboardingSpec, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe("/entities/VendorApplication/fields/annualSpend/type");
  });

  it("flags missing and unexpected entities", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.entities = [
      actual.entities[1]!,
      { name: "Invoice", fields: [{ name: "total", type: "number" }] },
    ];
    const diffs = compareSpecs(fixtures.vendorOnboardingSpec, actual);
    expect(diffs.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing entity "Vendor"'),
        expect.stringContaining('unexpected entity "Invoice"'),
      ]),
    );
  });

  it("flags enum value set differences", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.entities[0]!.fields[3]!.values = ["low", "high", "critical"];
    const diffs = compareSpecs(fixtures.vendorOnboardingSpec, actual);
    expect(diffs.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing enum value "medium"'),
        expect.stringContaining('unexpected enum value "critical"'),
      ]),
    );
  });

  it("flags a reference target mismatch", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.entities[1]!.fields[0]!.entity = "VendorApplication";
    const diffs = compareSpecs(fixtures.vendorOnboardingSpec, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe("/entities/VendorApplication/fields/vendor/entity");
  });

  it("flags a missing manyToMany relation", () => {
    const actual = clone(fixtures.projectTrackerSpec);
    delete actual.entities[0]!.relations;
    const diffs = compareSpecs(fixtures.projectTrackerSpec, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.message).toContain('missing relation "tags"');
  });

  it("flags approval count and missing approval rules", () => {
    const weakened = clone(fixtures.vendorOnboardingSpec);
    weakened.workflows![0]!.transitions[2]!.approval = { count: 3, roles: ["reviewer", "compliance"] };
    const countDiffs = compareSpecs(fixtures.vendorOnboardingSpec, weakened);
    expect(countDiffs).toHaveLength(1);
    expect(countDiffs[0]!.path).toBe("/workflows/vendor-approval/transitions/approve/approval/count");

    const dropped = clone(fixtures.vendorOnboardingSpec);
    delete dropped.workflows![0]!.transitions[2]!.approval;
    const droppedDiffs = compareSpecs(fixtures.vendorOnboardingSpec, dropped);
    expect(droppedDiffs).toHaveLength(1);
    expect(droppedDiffs[0]!.message).toBe("missing approval rule");
  });

  it("flags transition state and guard role differences", () => {
    const actual = clone(fixtures.vendorOnboardingSpec);
    actual.workflows![0]!.transitions[0]!.to = "in_review";
    actual.workflows![0]!.transitions[1]!.guard = { roles: ["compliance"] };
    const diffs = compareSpecs(fixtures.vendorOnboardingSpec, actual);
    expect(diffs.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "/workflows/vendor-approval/transitions/submit/to",
        "/workflows/vendor-approval/transitions/start-review/guard/roles",
      ]),
    );
  });

  it("flags guard predicate differences", () => {
    const actual = clone(fixtures.projectTrackerSpec);
    actual.workflows![0]!.transitions[0]!.guard = {
      roles: ["lead"],
      require: [{ field: "budget", op: "gte", value: 0 }],
    };
    const diffs = compareSpecs(fixtures.projectTrackerSpec, actual);
    expect(diffs.map((d) => d.path)).toEqual(
      expect.arrayContaining(["/workflows/project-lifecycle/transitions/kick-off/guard/require"]),
    );
  });

  it("flags missing pages and page type mismatches", () => {
    const actual = clone(fixtures.projectTrackerSpec);
    actual.pages = [
      { name: "projects", type: "list", entity: "Project" },
      { name: "project-form", type: "list", entity: "Project" },
    ];
    const diffs = compareSpecs(fixtures.projectTrackerSpec, actual);
    expect(diffs.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing page "tags"'),
        expect.stringContaining('page type is "list", expected "form"'),
      ]),
    );
  });

  it("flags role vocabulary differences", () => {
    const actual = clone(fixtures.minimalSpec);
    actual.app.roles = ["admin"];
    const diffs = compareSpecs(fixtures.minimalSpec, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.message).toContain('unexpected role "admin"');
  });
});
