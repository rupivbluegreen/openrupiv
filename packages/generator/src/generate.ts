/**
 * The generate loop (specs/phase-1-contracts.md §3): prompt -> candidate ->
 * validateSpec -> on failure, retry with the machine-readable SpecError[]
 * injected into the prompt; max 3 attempts; fail loudly with the last
 * errors. The output is a spec that passed validateSpec, or a typed failure
 * — nothing else (ADR-0001: the LLM surface ends at the spec).
 */

import { validateSpec, type AppSpec, type SpecError } from "@openrupiv/spec";
import type { SpecModel } from "./model";
import { extractSpecJson } from "./parse";
import {
  buildRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  GENERATE_MAX_TOKENS,
} from "./prompt";

export const MAX_ATTEMPTS = 3;

export type GenerateResult =
  | { ok: true; spec: AppSpec; attempts: number }
  | { ok: false; errors: SpecError[]; attempts: number };

/**
 * Generate a validated app spec from a natural-language description.
 *
 * A model response that is not parseable JSON, or that fails validateSpec,
 * counts as a failed attempt and triggers a retry — it never throws.
 * Transport-level failures from the model (network, auth, rate limits)
 * propagate as their own typed errors; they are not spec failures.
 */
export async function generateSpec(
  description: string,
  model: SpecModel,
): Promise<GenerateResult> {
  const system = buildSystemPrompt();
  let user = buildUserPrompt(description);
  let lastErrors: SpecError[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await model.complete({ system, user, maxTokens: GENERATE_MAX_TOKENS });

    const parsed = extractSpecJson(raw);
    if (parsed.ok) {
      const result = validateSpec(parsed.value);
      if (result.ok) {
        return { ok: true, spec: result.spec, attempts: attempt };
      }
      lastErrors = result.errors;
    } else {
      lastErrors = [
        {
          code: "ERR_SCHEMA",
          path: "",
          message: `the response is not a JSON spec object: ${parsed.reason}`,
        },
      ];
    }

    user = buildRetryPrompt(description, raw, lastErrors);
  }

  return { ok: false, errors: lastErrors, attempts: MAX_ATTEMPTS };
}
