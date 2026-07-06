# @openrupiv/compiler

Deterministic projection of a validated app spec into a runnable app
directory. This is the enforcement point of ADR-0001 — the LLM's surface
ends at the spec; everything executable is produced here, byte-identically,
from the spec alone.

## API

```ts
import { compileApp } from "@openrupiv/compiler";
import { validateSpec } from "@openrupiv/spec";

const validated = validateSpec(untrusted);
if (!validated.ok) throw new Error("validate first");

const result = compileApp(validated.spec);
if (result.ok) {
  for (const file of result.files) write(file.path, file.contents);
} else {
  for (const e of result.errors) console.error(`${e.code} ${e.path}: ${e.message}`);
}
```

- `compileApp(spec: AppSpec): CompileResult` — input must already have
  passed `validateSpec`.
- `CompileResult` — `{ ok: true, files: CompiledFile[] }` with `files`
  sorted by `path` ascending, or `{ ok: false, errors: CompilerError[] }`.
- `CompilerError` — `{ code, path, message }`; `code` is
  `SpecError["code"] | "ERR_UNSUPPORTED_SECTION"`, `path` is a JSON Pointer
  into the spec.

## What it emits (ADR-0004 app directory)

| File | Contents |
|---|---|
| `app/spec.json` | Canonical spec: `JSON.stringify(spec, null, 2) + "\n"` |
| `app/migrations/0001_init.sql` | Full DDL per the SQL conventions below |
| `app/README.md` | Generated docs: entities, workflows (guards + n-eyes approvals), pages, HTTP route list |
| `app/package.json` | `{ name, private, type: "module", scripts.test }` — **zero dependencies** |
| `app/test/spec.test.mjs` | `node:test` invariants; runs with plain `node --test test/` on Node ≥ 20 |
| `app/server.mjs` | Optional entry: serves the directory with `@openrupiv/runtime`; guarded, machine-readable error if the runtime is not installed |

The generated test file derives its expectations from `spec.json` at test
runtime, so it detects drift between a hand-edited spec and the compiled
migration — it is not a snapshot of what the compiler happened to emit.

## Determinism (tested, not aspirational)

- Same spec → byte-identical files. `test/compile.test.ts` double-compiles
  every `@openrupiv/spec` fixture and asserts per-file byte equality.
- No timestamps, no randomness, no environment reads, no locale-dependent
  collation anywhere in `src/` — enforced by a source-scan test.
- `files` sorted by `path` ascending in plain code-unit order.
- Full-output snapshots per fixture live in `test/__snapshots__/`;
  regenerate deliberately with `vitest run -u` and review the diff like any
  other code change.

## SQL conventions (contract with @openrupiv/runtime)

Per `specs/phase-1-contracts.md` §1:

- Table per entity: snake_case (`VendorApplication` → `vendor_application`);
  every entity table gets `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
  `created_at` / `updated_at` `timestamptz NOT NULL DEFAULT now()`.
- Types: string/text → `text`, number → `double precision`,
  boolean → `boolean`, date → `date`, datetime → `timestamptz`,
  enum → `text` + `CHECK (col IN (…))`,
  reference → `<name>_id uuid REFERENCES <target>(id)`.
- `required` → `NOT NULL`, `unique` → `UNIQUE`, `default` → `DEFAULT`
  literal (quotes escaped).
- manyToMany relation → join table `<e_table>_<relation_snake>` with both
  FKs and a composite primary key, emitted after all entity tables.
- The migration's first line is `CREATE EXTENSION IF NOT EXISTS pgcrypto;`.
- Tables are emitted in a stable topological order of reference
  dependencies (ties broken by spec order) so inline FKs always resolve;
  reference cycles fall back to deferred
  `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements. Self-references
  stay inline.

## Failure modes (typed, never silent)

| Case | Error |
|---|---|
| Non-empty `policies` / `evidence` | `ERR_UNSUPPORTED_SECTION` at `/policies` etc. — v0 cannot enforce these; dropping them silently would be a stubbed control (non-negotiable #2). `agents` is compiled as of spec v0.2 (passed through verbatim into `app/spec.json`); `policies` and `evidence` remain rejected. |
| Self-referential manyToMany relation | `ERR_UNSUPPORTED_SECTION` at the relation (join-table columns would collide) |
| Field mapping to a reserved column (`id`, `created_at`, `updated_at`) or two fields colliding after snake_casing | `ERR_DUPLICATE_NAME` |
| Defensive re-checks of enum values / reference targets | `ERR_BAD_ENUM`, `ERR_BAD_REFERENCE`, `ERR_UNKNOWN_ENTITY` |

All errors from one compile are collected and returned together.

## Tests

```bash
corepack pnpm --filter @openrupiv/compiler test
```

Suite highlights: byte-identical double-compile per fixture; full-output
snapshots (vendor onboarding, minimal, project tracker); precise DDL line
assertions against `vendorOnboardingSpec`; and a standalone-execution test
that writes a compiled app to a temp directory and runs `node --test test/`
with zero installs — including tamper cases proving the generated tests
fail loudly on a corrupted migration or a downgraded 4-eyes rule.
