import { fixtures } from "@openrupiv/spec";
import { describe, expect, it } from "vitest";
import { compareSpecs } from "../src/compare";
import { generateSpec, MAX_ATTEMPTS } from "../src/generate";
import { FakeSpecModel } from "../src/model";
import { GENERATE_MAX_TOKENS } from "../src/prompt";

const VALID = JSON.stringify(fixtures.minimalSpec);
const GARBAGE = "I'm sorry, I can't produce JSON for that right now.";
/** Structurally fine, semantically broken: reference to an unknown entity. */
const INVALID = JSON.stringify({
  specVersion: "0.1",
  app: { name: "Broken", slug: "broken", version: "0.1.0" },
  entities: [
    {
      name: "Order",
      fields: [{ name: "customer", type: "reference", entity: "Customer" }],
    },
  ],
});

describe("generateSpec", () => {
  it("returns the validated spec on the first attempt", async () => {
    const model = new FakeSpecModel([VALID]);
    const result = await generateSpec("a tiny notes app", model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(1);
    expect(compareSpecs(fixtures.minimalSpec, result.spec)).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it("accepts a spec wrapped in code fences and prose", async () => {
    const model = new FakeSpecModel([
      "Here you go:\n\n```json\n" + JSON.stringify(fixtures.vendorOnboardingSpec, null, 2) + "\n```\nDone!",
    ]);
    const result = await generateSpec("vendor onboarding", model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(compareSpecs(fixtures.vendorOnboardingSpec, result.spec)).toEqual([]);
  });

  it("sends the system prompt with schema, examples, and JSON-only instruction", async () => {
    const model = new FakeSpecModel([VALID]);
    await generateSpec("a tiny notes app", model);
    const request = model.requests[0]!;
    expect(request.maxTokens).toBe(GENERATE_MAX_TOKENS);
    expect(request.user).toContain("a tiny notes app");
    // The actual JSON Schema is embedded (identifiable by its $id).
    expect(request.system).toContain("https://openrupiv.invalid/schemas/app-spec/0.1.json");
    // Both fixture examples are embedded.
    expect(request.system).toContain('"vendor-onboarding"');
    expect(request.system).toContain('"project-tracker"');
    // The model is told to output only the JSON spec.
    expect(request.system).toContain("Output ONLY the JSON spec object");
  });

  it("retries after garbage and after an invalid spec, succeeding on attempt 3", async () => {
    const model = new FakeSpecModel([GARBAGE, INVALID, VALID]);
    const result = await generateSpec("a tiny notes app", model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(3);
    expect(model.requests).toHaveLength(3);

    // Attempt 2 prompt carries the parse failure as a machine-readable error.
    expect(model.requests[1]!.user).toContain("ERR_SCHEMA");
    expect(model.requests[1]!.user).toContain(GARBAGE);
    // Attempt 3 prompt carries the validator's errors for the invalid spec.
    expect(model.requests[2]!.user).toContain("ERR_BAD_REFERENCE");
    expect(model.requests[2]!.user).toContain("/entities/0/fields/0/entity");
    // The original description is preserved on every retry.
    expect(model.requests[2]!.user).toContain("a tiny notes app");
  });

  it("fails with the last errors after exhausting all attempts", async () => {
    // A fourth scripted response proves the loop stops at MAX_ATTEMPTS.
    const model = new FakeSpecModel([GARBAGE, GARBAGE, INVALID, VALID]);
    const result = await generateSpec("a tiny notes app", model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(model.requests).toHaveLength(MAX_ATTEMPTS);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.code).toBe("ERR_BAD_REFERENCE");
  });

  it("treats a non-JSON response as a validation failure, not a crash", async () => {
    const model = new FakeSpecModel([GARBAGE, GARBAGE, GARBAGE]);
    const result = await generateSpec("a tiny notes app", model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(MAX_ATTEMPTS);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("ERR_SCHEMA");
    expect(result.errors[0]!.message).toContain("not a JSON spec object");
  });

  it("rejects a spec that declares an unsupported specVersion", async () => {
    const wrongVersion = JSON.stringify({ ...fixtures.minimalSpec, specVersion: "2.0" });
    const model = new FakeSpecModel([wrongVersion, wrongVersion, wrongVersion]);
    const result = await generateSpec("a tiny notes app", model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe("ERR_SPEC_VERSION");
  });
});
