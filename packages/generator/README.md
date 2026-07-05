# @openrupiv/generator

Natural-language description → validated openRupiv app spec. Nothing else.

Per **ADR-0001**, the LLM surface of openRupiv ends at the spec: this package
turns a prompt like *"an approval workflow for vendor onboarding with 4-eyes
review"* into an `AppSpec` that passes `validateSpec` from
[`@openrupiv/spec`](../spec), or into a typed failure. It never emits
application code — code is a deterministic projection of the spec, owned by
[`@openrupiv/compiler`](../compiler).

Contract: `specs/phase-1-contracts.md` §3.

## API

```ts
import {
  AnthropicSpecModel,
  FakeSpecModel,
  compareSpecs,
  generateSpec,
  loadCorpus,
  type GenerateResult,
  type SpecModel,
} from "@openrupiv/generator";

const model = new AnthropicSpecModel(); // key from ANTHROPIC_API_KEY
const result: GenerateResult = await generateSpec(
  "an approval workflow for vendor onboarding with 4-eyes review",
  model,
);

if (result.ok) {
  result.spec;      // AppSpec — already passed validateSpec
  result.attempts;  // 1..3
} else {
  result.errors;    // SpecError[] — the last validation errors
  result.attempts;  // 3
}
```

### The generate loop

`generateSpec(description, model)`:

1. Builds a system prompt that embeds the **actual JSON Schema**
   (`appSpecSchema`, stringified — prompt and validator cannot drift), the
   semantic rules the schema cannot express, and two fixture examples
   (`fixtures.vendorOnboardingSpec`, `fixtures.projectTrackerSpec`). The
   model is instructed to output **only** the JSON spec.
2. Parses the candidate tolerantly: markdown code fences, leading/trailing
   prose, and braces inside strings are all handled. A response with no
   parseable JSON object is a *validation failure* (fed back through the
   retry loop), never a crash.
3. Runs `validateSpec`. On failure, retries with the machine-readable
   `SpecError[]` (code + JSON Pointer path + message) and the previous
   response injected into the prompt — max **3 attempts** — then returns
   `{ ok: false, errors, attempts: 3 }` carrying the last errors.

Transport-level failures (network, auth, rate limits) are *not* spec
failures; they propagate as the SDK's typed errors or as `GeneratorError`.

### Models

| Class | Purpose |
|---|---|
| `AnthropicSpecModel` | Real model via `@anthropic-ai/sdk`. Key from the constructor or `ANTHROPIC_API_KEY`; a missing key is a typed `GeneratorError` (`ERR_NO_API_KEY`). Model id defaults to `claude-sonnet-5`, overridable via `{ model }`. The key is never logged and never written to disk. |
| `FakeSpecModel` | Scripted responses for tests: returns the given strings in order, records every request (`.requests`), and fails with `ERR_FAKE_EXHAUSTED` when the script runs out. |

Both sit behind the narrow `SpecModel` seam (`complete(request) -> text`),
so tests run offline and evals can swap models.

### Semantic comparison

`compareSpecs(expected, actual)` returns `SpecDiff[]` (empty = semantically
equivalent). Per the contract, **names and field types matter;
descriptions/titles are free**:

- Compared (order-insensitive, by name): role vocabulary; entity names;
  field names, types, enum value sets, reference targets; relation
  names/kinds/targets; page names, types, bound entities; workflow names,
  entities, state fields, initial states; transition names, from/to states,
  guard roles, guard predicates, approval presence/count/roles.
- Free: app name/slug/description/version, all descriptions and titles,
  page field selection/ordering, field `required`/`unique`/`default`,
  array ordering.

## Golden corpus

`corpus/*.json` — 13 entries of `{ "prompt": string, "expected": AppSpec }`
covering the whole v0 schema surface: plain CRUD, enum-heavy, references,
manyToMany, single-approval (role-guarded) workflow, 4-eyes approval
workflows, predicate guards, multi-entity apps, a minimal one-entity app,
and a role-rich app. The vendor-onboarding entry is semantically equivalent
to `fixtures.vendorOnboardingSpec` (asserted in CI).

The golden tests (CI, no network) verify that:

- every corpus `expected` passes `validateSpec` (an invalid corpus file is a
  typed `ERR_CORPUS_INVALID` hard error at load time);
- `generateSpec` with a `FakeSpecModel` replaying each expected spec returns
  `ok` on attempt 1 and semantic-compares equal;
- the retry loop works: garbage → invalid spec → valid spec ⇒ `ok` with
  `attempts: 3`; all-bad ⇒ typed failure with `attempts: 3` and the final
  errors;
- corpus coverage of each schema feature is asserted, so shrinking the
  corpus below the contract fails CI.

## Live eval (not CI)

```sh
ANTHROPIC_API_KEY=... corepack pnpm --filter @openrupiv/generator eval
```

Runs every corpus prompt against the real model (`OPENRUPIV_EVAL_MODEL`
overrides the model id) and prints per-prompt pass/fail with semantic diffs
plus a summary. Exit codes: `0` all pass, `1` failures, `2` environment
error (e.g. missing `ANTHROPIC_API_KEY` — reported as machine-readable JSON
on stderr). Regenerating specs costs real tokens; this is deliberately not
part of CI in v0.

## Error codes

| Code | Meaning |
|---|---|
| `ERR_NO_API_KEY` | No Anthropic API key via constructor or `ANTHROPIC_API_KEY`. |
| `ERR_FAKE_EXHAUSTED` | A `FakeSpecModel` ran out of scripted responses. |
| `ERR_CORPUS_INVALID` | A corpus file is missing, malformed, or holds an invalid spec. |

Spec validation failures use the `SpecError` shape (`code`, JSON Pointer
`path`, `message`) from `@openrupiv/spec` — the same shape the retry loop
feeds back to the model and the CLI prints to humans.

## Development

```sh
corepack pnpm --filter @openrupiv/generator typecheck
corepack pnpm --filter @openrupiv/generator test
```
