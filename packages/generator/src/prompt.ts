/**
 * Prompt construction. The system prompt embeds the actual JSON Schema from
 * @openrupiv/spec (so prompt and validator can never drift) plus two fixture
 * examples, and instructs the model to output ONLY the JSON spec. The retry
 * prompt feeds the validator's machine-readable SpecError[] back verbatim.
 */

import { appSpecSchema, fixtures, type SpecError } from "@openrupiv/spec";

/** Output budget per attempt; specs are small relative to this. */
export const GENERATE_MAX_TOKENS = 8192;

const SCHEMA_JSON = JSON.stringify(appSpecSchema, null, 2);
const EXAMPLE_APPROVAL = JSON.stringify(fixtures.vendorOnboardingSpec, null, 2);
const EXAMPLE_RELATIONS = JSON.stringify(fixtures.projectTrackerSpec, null, 2);

const SYSTEM_PROMPT = [
  'You are the openRupiv spec generator. You convert a natural-language description of a business application into an app spec: a single JSON document with specVersion "0.1". You produce the spec ONLY — never application code (the spec is compiled to code deterministically elsewhere).',
  "",
  "The spec MUST conform to this JSON Schema:",
  "",
  SCHEMA_JSON,
  "",
  "Semantic rules the schema cannot express (the validator enforces all of these):",
  '- Every "reference" field must declare an "entity" naming another entity defined in this spec.',
  '- Every "enum" field must declare "values"; non-enum fields must not.',
  '- "default" is not allowed on date, datetime, or reference fields; an enum default must be one of its values.',
  '- A workflow\'s "stateField" must name an enum field on the workflow\'s entity; "initial" and every transition "from"/"to" must be values of that field.',
  '- Every role used in a guard or approval must be declared in "app.roles".',
  '- Guard predicates: "gt"/"gte"/"lt"/"lte" apply only to number, date, or datetime fields; "set"/"notSet" must not carry a "value"; every other op requires one.',
  '- "approval.count" must be >= 2 and means the transition completes only after that many DISTINCT users approve (n-eyes). A single-approver step is just a role-guarded transition WITHOUT an "approval" rule.',
  '- Omit "policies", "agents", and "evidence" entirely — they are not supported yet.',
  "",
  "Example 1 — an approval workflow with 4-eyes (two distinct approvers) review:",
  EXAMPLE_APPROVAL,
  "",
  "Example 2 — many-to-many relations and field-predicate guards:",
  EXAMPLE_RELATIONS,
  "",
  "Output ONLY the JSON spec object. No markdown code fences, no prose, no explanation before or after the JSON.",
].join("\n");

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildUserPrompt(description: string): string {
  return `Generate the app spec for this description:\n\n${description}`;
}

export function buildRetryPrompt(
  description: string,
  previousResponse: string,
  errors: SpecError[],
): string {
  return [
    "Generate the app spec for this description:",
    "",
    description,
    "",
    "Your previous response failed validation.",
    "",
    "Previous response:",
    previousResponse,
    "",
    "Machine-readable validation errors (code, JSON Pointer path, message):",
    JSON.stringify(errors, null, 2),
    "",
    "Fix every error and output ONLY the corrected JSON spec object. No code fences, no prose.",
  ].join("\n");
}
