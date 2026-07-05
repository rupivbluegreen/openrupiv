/**
 * The `@openrupiv/generator` contract (specs/phase-1-contracts.md §3) as the
 * CLI consumes it. The generator package is built in parallel; the CLI
 * types the boundary itself and verifies it AT RUNTIME when loading the
 * module. If the generator is missing or does not implement its contract,
 * that is a typed hard error (exit 4) — never a silent no-op.
 */

import type { AppSpec, SpecError } from "@openrupiv/spec";
import { CliError } from "./errors";

export interface SpecModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface SpecModel {
  complete(req: SpecModelRequest): Promise<string>;
}

export type GenerateResult =
  | { ok: true; spec: AppSpec; attempts: number }
  | { ok: false; errors: SpecError[]; attempts: number };

export interface GeneratorModule {
  generateSpec(description: string, model: SpecModel): Promise<GenerateResult>;
  /** Reads ANTHROPIC_API_KEY itself when no apiKey option is given. */
  AnthropicSpecModel: new (opts?: { apiKey?: string; model?: string }) => SpecModel;
}

/**
 * Verify that a loaded module actually implements the generator contract.
 * Split out from the dynamic import so the check is unit-testable without
 * module-system tricks.
 */
export function assertGeneratorModule(mod: unknown): GeneratorModule {
  const candidate = mod as Partial<Record<keyof GeneratorModule, unknown>> | null | undefined;
  const hasGenerate = typeof candidate?.generateSpec === "function";
  const hasModel = typeof candidate?.AnthropicSpecModel === "function";
  if (!hasGenerate || !hasModel) {
    const missing = [
      ...(hasGenerate ? [] : ["generateSpec"]),
      ...(hasModel ? [] : ["AnthropicSpecModel"]),
    ].join(", ");
    throw new CliError(
      "ERR_GENERATOR_UNAVAILABLE",
      `@openrupiv/generator does not implement its contract (missing: ${missing}). ` +
        `The generator package may not be built yet — see specs/phase-1-contracts.md §3.`,
    );
  }
  return mod as GeneratorModule;
}

/** Load `@openrupiv/generator` and verify its contract. */
export async function loadGeneratorModule(): Promise<GeneratorModule> {
  let mod: unknown;
  try {
    mod = await import("@openrupiv/generator");
  } catch (error) {
    throw new CliError(
      "ERR_GENERATOR_UNAVAILABLE",
      `failed to load @openrupiv/generator: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertGeneratorModule(mod);
}
