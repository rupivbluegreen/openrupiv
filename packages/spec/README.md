# @openrupiv/spec

The versioned app spec: schema, validator, types, and canonical fixtures.
The spec is the contract of the whole platform — the LLM generates *only*
values of this shape (ADR-0001), and everything downstream (compiler,
runtime, pages) is a deterministic projection of it.

## What's here

- **`appSpecSchema`** — JSON Schema (draft 2020-12) for spec v0.1.
- **`validateSpec(input: unknown)`** — two passes: structural (JSON Schema)
  then semantic (cross-references the schema can't express: entity targets,
  workflow states, role vocabulary, predicate/field type compatibility).
  Returns `{ ok: true, spec }` or `{ ok: false, errors }` where every error
  is `{ code, path, message }` with a stable code and a JSON Pointer path —
  the same shape is consumed by the generator's retry loop and printed to
  humans.
- **Types** — `AppSpec` and friends, mirroring the schema.
- **`fixtures`** — canonical valid specs (`vendorOnboardingSpec` is the
  flagship 4-eyes approval demo); reused by the compiler corpus and the
  generator's golden tests.

## Spec v0.1 surface

| Section | Status |
|---|---|
| `app` | supported |
| `entities` (typed fields, enum, reference, manyToMany relations) | supported |
| `pages` (list / detail / form) | supported |
| `workflows` (state machines, role/predicate guards, n-eyes approvals with `count >= 2`) | supported |
| `policies`, `agents`, `evidence` | shape reserved — validated here, **rejected by the v0 compiler** with a typed error |

## Usage

```ts
import { validateSpec } from "@openrupiv/spec";

const result = validateSpec(untrustedJson);
if (!result.ok) {
  for (const e of result.errors) console.error(`${e.code} ${e.path}: ${e.message}`);
} else {
  compile(result.spec);
}
```

## Tests

```bash
pnpm --filter @openrupiv/spec test
```
