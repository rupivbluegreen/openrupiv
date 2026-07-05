/**
 * The generator-module boundary check: a module that does not implement
 * the §3 contract is a typed environment error (exit 4) — never a no-op.
 */

import { describe, expect, it } from "vitest";
import { CliError, EXIT_ENVIRONMENT } from "../src/errors";
import { assertGeneratorModule } from "../src/generator-contract";
import { fakeGeneratorModule } from "./helpers";

describe("assertGeneratorModule", () => {
  it("rejects an empty module with a typed error naming what is missing", () => {
    let thrown: unknown;
    try {
      assertGeneratorModule({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe("ERR_GENERATOR_UNAVAILABLE");
    expect(err.exitCode).toBe(EXIT_ENVIRONMENT);
    expect(err.message).toContain("generateSpec");
    expect(err.message).toContain("AnthropicSpecModel");
  });

  it("rejects a module with only half the contract", () => {
    expect(() => assertGeneratorModule({ generateSpec: async () => ({}) })).toThrowError(
      /AnthropicSpecModel/,
    );
  });

  it("accepts a module implementing the contract and returns it unchanged", () => {
    const mod = fakeGeneratorModule(["{}"]);
    expect(assertGeneratorModule(mod)).toBe(mod);
  });
});
