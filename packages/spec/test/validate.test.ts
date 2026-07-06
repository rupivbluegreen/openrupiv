import { describe, expect, it } from "vitest";
import type { AppSpec, SpecErrorCode } from "../src/index";
import { fixtures, validateSpec } from "../src/index";

/** Deep-clone a fixture and mutate it as raw JSON. */
function mutate(
  spec: AppSpec,
  fn: (draft: Record<string, any>) => void,
): unknown {
  const draft = JSON.parse(JSON.stringify(spec));
  fn(draft);
  return draft;
}

function expectError(result: ReturnType<typeof validateSpec>, code: SpecErrorCode, path?: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const match = result.errors.find(
    (e) => e.code === code && (path === undefined || e.path === path),
  );
  expect(
    match,
    `expected ${code}${path ? ` at ${path}` : ""}, got ${JSON.stringify(result.errors, null, 2)}`,
  ).toBeDefined();
}

describe("validateSpec — canonical fixtures", () => {
  for (const fixture of fixtures.allFixtures) {
    it(`accepts ${fixture.app.slug} (round-tripped as untrusted JSON)`, () => {
      const result = validateSpec(JSON.parse(JSON.stringify(fixture)));
      expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
      if (result.ok) expect(result.spec.app.slug).toBe(fixture.app.slug);
    });
  }
});

describe("validateSpec — vendorOnboardingWithAgentSpec fixture", () => {
  it("is a valid v0.2 spec with one agent task proposing the approve transition", () => {
    const result = validateSpec(JSON.parse(JSON.stringify(fixtures.vendorOnboardingWithAgentSpec)));
    expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
  });

  it("carries the same entities/workflows as vendorOnboardingSpec, unchanged", () => {
    expect(fixtures.vendorOnboardingWithAgentSpec.entities).toEqual(fixtures.vendorOnboardingSpec.entities);
    expect(fixtures.vendorOnboardingWithAgentSpec.workflows).toEqual(fixtures.vendorOnboardingSpec.workflows);
  });
});

describe("validateSpec — version and structure", () => {
  it("rejects non-objects", () => {
    for (const bad of [null, 42, "spec", [1]]) {
      expectError(validateSpec(bad), "ERR_SPEC_VERSION", "");
    }
  });

  it("rejects unsupported specVersion", () => {
    const bad = mutate(fixtures.minimalSpec, (d) => (d.specVersion = "2.0"));
    expectError(validateSpec(bad), "ERR_SPEC_VERSION", "/specVersion");
  });

  it("rejects a missing app section", () => {
    const bad = mutate(fixtures.minimalSpec, (d) => delete d.app);
    expectError(validateSpec(bad), "ERR_SCHEMA");
  });

  it("rejects unknown top-level properties", () => {
    const bad = mutate(fixtures.minimalSpec, (d) => (d.widgets = []));
    expectError(validateSpec(bad), "ERR_SCHEMA");
  });

  it("rejects badly cased identifiers via schema patterns", () => {
    const badEntity = mutate(fixtures.minimalSpec, (d) => {
      d.entities[0].name = "note";
    });
    expectError(validateSpec(badEntity), "ERR_SCHEMA", "/entities/0/name");

    const badSlug = mutate(fixtures.minimalSpec, (d) => {
      d.app.slug = "Notes App";
    });
    expectError(validateSpec(badSlug), "ERR_SCHEMA", "/app/slug");
  });

  it("rejects approval count below 2 structurally", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].transitions[2].approval.count = 1;
    });
    expectError(
      validateSpec(bad),
      "ERR_SCHEMA",
      "/workflows/0/transitions/2/approval/count",
    );
  });

  it("rejects an unsupported specVersion string that isn't 0.1 or 0.2", () => {
    const bad = mutate(fixtures.minimalSpec, (d) => (d.specVersion = "0.3"));
    expectError(validateSpec(bad), "ERR_SPEC_VERSION", "/specVersion");
  });
});

describe("validateSpec — v0.2 agents", () => {
  function v02Spec(overrides: Partial<AppSpec> = {}): AppSpec {
    return {
      ...fixtures.vendorOnboardingSpec,
      specVersion: "0.2",
      ...overrides,
    };
  }

  it("accepts specVersion 0.2 with no agents", () => {
    const result = validateSpec(v02Spec());
    expect(result.ok).toBe(true);
  });

  it("accepts a valid agent task proposing an approval-gated transition", () => {
    const spec = v02Spec({
      agents: [
        {
          name: "vendor-risk-review",
          description: "Reads a vendor application and proposes approval.",
          tools: ["read-vendor-application"],
          proposes: [{ workflow: "vendor-approval", transition: "approve" }],
        },
      ],
    });
    const result = validateSpec(spec);
    expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
  });

  it("rejects a non-empty agents array under specVersion 0.1", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.agents = [{ name: "vendor-risk-review" }];
    });
    expectError(validateSpec(bad), "ERR_AGENTS_REQUIRE_V0_2", "/agents");
  });

  it("rejects duplicate agent task names", () => {
    const spec = v02Spec({
      agents: [{ name: "dup" }, { name: "dup" }],
    });
    expectError(validateSpec(spec), "ERR_DUPLICATE_NAME", "/agents/1/name");
  });

  it("rejects proposes referencing an unknown workflow", () => {
    const spec = v02Spec({
      agents: [
        { name: "t1", proposes: [{ workflow: "no-such-workflow", transition: "approve" }] },
      ],
    });
    expectError(validateSpec(spec), "ERR_UNKNOWN_WORKFLOW", "/agents/0/proposes/0/workflow");
  });

  it("rejects proposes referencing an unknown transition", () => {
    const spec = v02Spec({
      agents: [
        { name: "t1", proposes: [{ workflow: "vendor-approval", transition: "no-such-transition" }] },
      ],
    });
    expectError(validateSpec(spec), "ERR_UNKNOWN_TRANSITION", "/agents/0/proposes/0/transition");
  });

  it("rejects proposes referencing a transition with no approval rule", () => {
    const spec = v02Spec({
      agents: [
        { name: "t1", proposes: [{ workflow: "vendor-approval", transition: "submit" }] },
      ],
    });
    expectError(validateSpec(spec), "ERR_AGENT_PROPOSAL_UNGATED", "/agents/0/proposes/0");
  });

  it("rejects a tools entry that is not kebab-case via the schema pattern", () => {
    const spec = v02Spec({
      agents: [{ name: "t1", tools: ["Not_Kebab"] }],
    });
    expectError(validateSpec(spec), "ERR_SCHEMA");
  });
});

describe("validateSpec — entities", () => {
  it("rejects duplicate entity names", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.entities[1].name = "Vendor";
    });
    expectError(validateSpec(bad), "ERR_DUPLICATE_NAME", "/entities/1/name");
  });

  it("rejects duplicate member names across fields and relations", () => {
    const dupField = mutate(fixtures.minimalSpec, (d) => {
      d.entities[0].fields.push({ name: "title", type: "text" });
    });
    expectError(validateSpec(dupField), "ERR_DUPLICATE_NAME", "/entities/0/fields/2/name");

    const dupRelation = mutate(fixtures.projectTrackerSpec, (d) => {
      d.entities[0].relations[0].name = "budget";
    });
    expectError(validateSpec(dupRelation), "ERR_DUPLICATE_NAME", "/entities/0/relations/0/name");
  });

  it("rejects enum fields without values and values on non-enum fields", () => {
    const missing = mutate(fixtures.minimalSpec, (d) => {
      d.entities[0].fields.push({ name: "mood", type: "enum" });
    });
    expectError(validateSpec(missing), "ERR_BAD_ENUM", "/entities/0/fields/2");

    const extra = mutate(fixtures.minimalSpec, (d) => {
      d.entities[0].fields[0].values = ["a"];
    });
    expectError(validateSpec(extra), "ERR_BAD_ENUM", "/entities/0/fields/0/values");
  });

  it("rejects broken references", () => {
    const unknownTarget = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.entities[1].fields[0].entity = "Supplier";
    });
    expectError(validateSpec(unknownTarget), "ERR_BAD_REFERENCE", "/entities/1/fields/0/entity");

    const missingTarget = mutate(fixtures.vendorOnboardingSpec, (d) => {
      delete d.entities[1].fields[0].entity;
    });
    expectError(validateSpec(missingTarget), "ERR_BAD_REFERENCE", "/entities/1/fields/0");

    const targetOnString = mutate(fixtures.minimalSpec, (d) => {
      d.entities[0].fields[0].entity = "Note";
    });
    expectError(validateSpec(targetOnString), "ERR_BAD_REFERENCE", "/entities/0/fields/0/entity");
  });

  it("rejects manyToMany relations to unknown entities", () => {
    const bad = mutate(fixtures.projectTrackerSpec, (d) => {
      d.entities[0].relations[0].to = "Label";
    });
    expectError(validateSpec(bad), "ERR_UNKNOWN_ENTITY", "/entities/0/relations/0/to");
  });

  it("rejects type-incompatible and disallowed defaults", () => {
    const wrongType = mutate(fixtures.projectTrackerSpec, (d) => {
      d.entities[0].fields[1].default = true; // number field
    });
    expectError(validateSpec(wrongType), "ERR_BAD_DEFAULT", "/entities/0/fields/1/default");

    const enumOutside = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.entities[0].fields[3].default = "extreme";
    });
    expectError(validateSpec(enumOutside), "ERR_BAD_DEFAULT", "/entities/0/fields/3/default");

    const onDate = mutate(fixtures.projectTrackerSpec, (d) => {
      d.entities[0].fields[2].default = "2026-01-01";
    });
    expectError(validateSpec(onDate), "ERR_BAD_DEFAULT", "/entities/0/fields/2/default");
  });
});

describe("validateSpec — pages", () => {
  it("rejects pages bound to unknown entities", () => {
    const bad = mutate(fixtures.minimalSpec, (d) => {
      d.pages = [{ name: "todos", type: "list", entity: "Todo" }];
    });
    expectError(validateSpec(bad), "ERR_UNKNOWN_ENTITY", "/pages/0/entity");
  });

  it("rejects pages selecting unknown fields", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.pages[2].fields.push("riskScore");
    });
    expectError(validateSpec(bad), "ERR_UNKNOWN_FIELD", "/pages/2/fields/3");
  });

  it("rejects duplicate page names", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.pages[1].name = "vendors";
    });
    expectError(validateSpec(bad), "ERR_DUPLICATE_NAME", "/pages/1/name");
  });
});

describe("validateSpec — workflows", () => {
  it("rejects workflows on unknown entities", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].entity = "PurchaseOrder";
    });
    expectError(validateSpec(bad), "ERR_UNKNOWN_ENTITY", "/workflows/0/entity");
  });

  it("rejects a stateField that is not an enum field", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].stateField = "justification";
    });
    expectError(validateSpec(bad), "ERR_WORKFLOW_STATE_FIELD", "/workflows/0/stateField");
  });

  it("rejects states outside the enum values", () => {
    const badInitial = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].initial = "pending";
    });
    expectError(validateSpec(badInitial), "ERR_WORKFLOW_STATE", "/workflows/0/initial");

    const badTo = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].transitions[0].to = "archived";
    });
    expectError(validateSpec(badTo), "ERR_WORKFLOW_STATE", "/workflows/0/transitions/0/to");
  });

  it("rejects roles not declared in app.roles", () => {
    const guardRole = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].transitions[0].guard.roles = ["admin"];
    });
    expectError(validateSpec(guardRole), "ERR_UNKNOWN_ROLE", "/workflows/0/transitions/0/guard/roles/0");

    const approvalRole = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].transitions[2].approval.roles = ["auditor"];
    });
    expectError(validateSpec(approvalRole), "ERR_UNKNOWN_ROLE", "/workflows/0/transitions/2/approval/roles/0");
  });

  it("rejects malformed predicates", () => {
    const valueOnSet = mutate(fixtures.projectTrackerSpec, (d) => {
      d.workflows[0].transitions[1].guard.require[0].value = "2026-01-01";
    });
    expectError(
      validateSpec(valueOnSet),
      "ERR_BAD_PREDICATE",
      "/workflows/0/transitions/1/guard/require/0/value",
    );

    const missingValue = mutate(fixtures.projectTrackerSpec, (d) => {
      delete d.workflows[0].transitions[0].guard.require[0].value;
    });
    expectError(validateSpec(missingValue), "ERR_BAD_PREDICATE");

    const orderedOpOnString = mutate(fixtures.projectTrackerSpec, (d) => {
      d.workflows[0].transitions[0].guard.require[0] = {
        field: "name",
        op: "gt",
        value: "x",
      };
    });
    expectError(
      validateSpec(orderedOpOnString),
      "ERR_BAD_PREDICATE",
      "/workflows/0/transitions/0/guard/require/0/op",
    );

    const unknownField = mutate(fixtures.projectTrackerSpec, (d) => {
      d.workflows[0].transitions[0].guard.require[0].field = "cost";
    });
    expectError(
      validateSpec(unknownField),
      "ERR_UNKNOWN_FIELD",
      "/workflows/0/transitions/0/guard/require/0/field",
    );

    const wrongValueType = mutate(fixtures.projectTrackerSpec, (d) => {
      d.workflows[0].transitions[0].guard.require[0].value = "lots";
    });
    expectError(
      validateSpec(wrongValueType),
      "ERR_BAD_PREDICATE",
      "/workflows/0/transitions/0/guard/require/0/value",
    );
  });

  it("collects multiple errors in one pass", () => {
    const bad = mutate(fixtures.vendorOnboardingSpec, (d) => {
      d.workflows[0].initial = "pending";
      d.workflows[0].transitions[0].guard.roles = ["admin"];
      d.pages[0].entity = "Supplier";
    });
    const result = validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
