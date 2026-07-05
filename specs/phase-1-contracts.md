# Phase 1 — cross-package contracts

> Binding interface contracts for the Phase 1 packages, so they can be built
> in parallel. If you are building one package: implement YOUR side of these
> signatures exactly; consume the OTHER sides as written here, not as you
> wish they were. Changes to this file require stopping and flagging — do
> not unilaterally drift. See ADR-0001 (spec-only LLM), ADR-0002 (Dex dev
> IdP), ADR-0003 (OIDC only), ADR-0004 (apps are data served by runtime).

## Shared foundation (exists, do not modify)

`@openrupiv/spec` — `validateSpec(input: unknown): ValidationResult`,
`AppSpec` types, `SpecError { code, path, message }`, `appSpecSchema`,
`fixtures.vendorOnboardingSpec | minimalSpec | projectTrackerSpec | allFixtures`.

## 1. `@openrupiv/compiler`

```ts
export interface CompiledFile {
  /** Workspace-relative POSIX path, e.g. "app/spec.json". */
  path: string;
  contents: string;
}
export type CompileResult =
  | { ok: true; files: CompiledFile[] }
  | { ok: false; errors: SpecError[] };

export function compileApp(spec: AppSpec): CompileResult;
```

- Input is an ALREADY-VALIDATED spec (callers run `validateSpec` first).
- Specs using `policies`, `agents`, or `evidence` (non-empty arrays) fail
  with `{ code: "ERR_UNSUPPORTED_SECTION", path: "/policies", message: … }`
  — extend the compiler's own error type as
  `SpecError["code"] | "ERR_UNSUPPORTED_SECTION"`. Never silently drop.
- **Determinism:** `files` sorted by `path` ascending; same spec →
  byte-identical output. No timestamps, no randomness, no environment reads.
- Emits the app directory per ADR-0004:
  - `app/spec.json` — canonical spec, `JSON.stringify(spec, null, 2) + "\n"`.
  - `app/migrations/0001_init.sql` — full DDL per the SQL conventions below.
  - `app/README.md` — human docs: entities, pages, workflow diagrams (text),
    route list per the HTTP conventions below.
  - `app/package.json` — `{ name: "<slug>", private: true, type: "module", scripts: { test: "node --test test/" } }`
    — **zero dependencies**; tests must run with plain Node ≥ 20.
  - `app/test/spec.test.mjs` — `node:test` invariants: spec.json parses,
    specVersion is "0.1", every workflow's states exist on its entity, every
    approval transition has `count >= 2`, migration file mentions every
    table the SQL conventions require for this spec.
  - `app/server.mjs` — optional library entry:
    `import { serveAppDir } from "@openrupiv/runtime"; serveAppDir(new URL(".", import.meta.url).pathname);`
    (guarded with a clear error message if the import fails).

### SQL conventions (compiler emits, runtime assumes)

- Table per entity: snake_case of entity name (`VendorApplication` →
  `vendor_application`).
- Columns: snake_case of field name. Every table gets
  `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
  `created_at timestamptz NOT NULL DEFAULT now()`,
  `updated_at timestamptz NOT NULL DEFAULT now()`.
- Types: string → `text`, text → `text`, number → `double precision`,
  boolean → `boolean`, date → `date`, datetime → `timestamptz`,
  enum → `text` + `CHECK (col IN (…values…))`, reference → `<name>_id uuid
  REFERENCES <target_table>(id)`.
- `required: true` → `NOT NULL`; `unique: true` → `UNIQUE`.
- Field `default` → SQL `DEFAULT` literal.
- manyToMany relation on entity E named `r` to target T → join table
  `<e_table>_<r_snake>` with `<e_table>_id` and `<t_table>_id`, both FK,
  composite PK.
- The migration starts with `CREATE EXTENSION IF NOT EXISTS pgcrypto;`.

## 2. `@openrupiv/runtime`

```ts
export interface RuntimeConfig {
  databaseUrl: string;      // DATABASE_URL
  oidc: {
    issuer: string;         // OIDC_ISSUER
    clientId: string;       // OIDC_CLIENT_ID
    clientSecret: string;   // OIDC_CLIENT_SECRET
    rolesClaim: string;     // OIDC_ROLES_CLAIM, default "roles"
  };
  sessionSecret: string;    // SESSION_SECRET (>= 32 chars enforced)
  baseUrl: string;          // BASE_URL, e.g. http://localhost:3000
  port: number;             // PORT, default 3000
  devMode: boolean;         // OPENRUPIV_DEV_MODE === "true"
}
export function configFromEnv(env?: NodeJS.ProcessEnv): RuntimeConfig;

/** Load an ADR-0004 app directory (reads spec.json, validates it). */
export function loadAppDir(dir: string): Promise<AppSpec>;

/** Build the Fastify server (exported for tests). */
export function createServer(spec: AppSpec, config: RuntimeConfig): Promise<FastifyInstance>;

/** Apply app migrations + runtime infra tables, then listen. */
export function serveAppDir(dir: string, config?: RuntimeConfig): Promise<void>;
```

- `bin/serve.mjs`: `node bin/serve.mjs <appDir>` → `serveAppDir` with
  `configFromEnv()`. The Compose runtime service runs exactly this with
  `APP_DIR` mounted.
- **Dev-cred refusal (ADR-0002):** if `clientSecret === "openrupiv-dev-secret"`
  and `devMode` is false → refuse to start with a clear error.
- Migrations: apply `migrations/*.sql` sorted, each in a transaction,
  recorded in `_migrations(name text primary key, applied_at timestamptz)`;
  skip already-applied; never rollback (forward-only).
- Runtime infra tables (created idempotently at startup):
  `_migrations`, and
  `workflow_approvals(id uuid pk default gen_random_uuid(), entity_table text not null, record_id uuid not null, transition text not null, approver_sub text not null, created_at timestamptz not null default now(), UNIQUE (entity_table, record_id, transition, approver_sub))`.

### HTTP conventions (runtime serves, compiler documents)

All routes require an authenticated session except `/healthz`,
`/auth/callback`, `/auth/login`.

- `GET /healthz` → `{ ok: true }` (also used by Compose healthcheck).
- `GET /auth/login` → OIDC redirect (Authorization Code + PKCE);
  `GET /auth/callback` → session; `POST /auth/logout` → destroy session.
- Entity API, kebab-case of entity name (`VendorApplication` →
  `/api/vendor-application`): `GET` (list), `POST` (create),
  `GET/:id`, `PUT/:id` (no DELETE in v0).
- Workflow: `POST /api/<entity>/:id/transitions/<transition-name>`.
  Enforcement order: state matches `from` → guard roles (user roles from
  `rolesClaim`) → guard predicates → approval rule. If the transition has
  `approval { count: n }`: each call records an approval for the calling
  user (`sub`); a second approval by the SAME `sub` → 409 with
  `{ error: "ERR_DUPLICATE_APPROVER" }`, logged; when distinct approvers
  reach `count`, the state changes in the same transaction. Responses:
  `{ status: "pending", approvals: k, required: n }` or
  `{ status: "transitioned", state: "<to>" }`.
  Failures: 403 `{ error: "ERR_FORBIDDEN_ROLE" }`, 409
  `{ error: "ERR_BAD_STATE" | "ERR_GUARD_FAILED" | "ERR_DUPLICATE_APPROVER" }`.
- Pages: `GET /p/<page-name>` → server-rendered HTML (list/detail/form per
  spec; forms POST to the entity API). `GET /` → index of pages.
- The `stateField` of any workflow is read-only through create/update APIs
  (server sets initial value on create; transitions are the only writer).
- Structured JSON logs to stdout; NEVER log tokens, cookies, secrets, or
  Authorization headers (redaction helper with a unit test).

### Testing without Docker

Unit tests must not require live Postgres or a live IdP: inject a fake `pg`
Pool interface for workflow-enforcement tests (the n-eyes distinct-approver
test lives here, against `fixtures.vendorOnboardingSpec`), and test OIDC
pieces (config, redaction, dev-cred refusal, cookie flags) in isolation.
Live-integration paths are exercised in the Compose e2e stage.

## 3. `@openrupiv/generator`

```ts
export interface SpecModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}
export interface SpecModel {
  complete(req: SpecModelRequest): Promise<string>;
}
export class AnthropicSpecModel implements SpecModel {
  constructor(opts?: { apiKey?: string; model?: string });  // key defaults to ANTHROPIC_API_KEY
}
export class FakeSpecModel implements SpecModel { /* canned/scripted responses for tests */ }

export type GenerateResult =
  | { ok: true; spec: AppSpec; attempts: number }
  | { ok: false; errors: SpecError[]; attempts: number };

export function generateSpec(description: string, model: SpecModel): Promise<GenerateResult>;
```

- Loop: build prompt (embed the JSON Schema + 1–2 fixture examples) → parse
  candidate (strip code fences if present) → `validateSpec` → on failure,
  retry with the `SpecError[]` serialized into the prompt; max 3 attempts;
  return the last errors on exhaustion.
- Golden corpus: `corpus/*.json` — ≥ 10 entries
  `{ prompt, expected: AppSpec }`. Golden test runs with `FakeSpecModel`
  replaying expected outputs (validates the harness + corpus specs
  themselves); a separate eval script (`pnpm eval`, needs
  `ANTHROPIC_API_KEY`) runs the corpus against the real model and reports
  semantic diffs — not part of CI in v0.
- Semantic comparison for golden tests: entity/page/workflow NAMES and
  field types must match; descriptions/titles are free.

## 4. `@openrupiv/cli`

- `openrupiv new <name>` — creates `<name>/` workspace: `git init -b main`,
  `openrupiv.yaml` (`{ specVersion: "0.1", app: null }` placeholder),
  `docker-compose.yaml` (see below), `README.md` quickstart,
  `.gitignore`; first commit. No network, no LLM.
- `openrupiv generate "<description>" [--dir <workspace>] [--json]` —
  `generateSpec` (AnthropicSpecModel) → `compileApp` → write files into the
  workspace → `git add -A && git commit` (respect user's git identity;
  `-s` sign-off). Prints file list + next steps; `--json` emits
  `{ ok, files, errors, attempts }` on stdout, nothing else.
- Exit codes: 0 ok; 2 validation/generation failed (after retries);
  3 compile failed; 4 environment error (missing API key, not a workspace).
- The workspace `docker-compose.yaml` services: `postgres` (postgres:16,
  volume), `dex` (dexidp/dex, config mounted from `dex/config.yaml` that
  `new` also emits — static client `openrupiv-local` / secret
  `openrupiv-dev-secret`, redirect `http://localhost:3000/auth/callback`,
  static password dev user `dev@example.com` / password `dev-password`,
  conspicuous DEV-ONLY comments), `runtime` (image built from the monorepo
  `packages/runtime/Dockerfile`; env: `DATABASE_URL`, `OIDC_ISSUER=http://dex:5556`,
  `OIDC_CLIENT_ID=openrupiv-local`, `OIDC_CLIENT_SECRET=openrupiv-dev-secret`,
  `SESSION_SECRET` (generated into `.env` by `new`), `OPENRUPIV_DEV_MODE=true`,
  `APP_DIR=/app-dir` with `./app` mounted; depends_on healthchecks).
- v0 runs the CLI from the monorepo via `pnpm --filter @openrupiv/cli
  exec tsx src/main.ts …` behind a `bin` entry; do not publish yet.

## Package skeletons

`package.json` + `tsconfig.json` + placeholder `src/index.ts` for all four
packages are committed with ALL dependencies pre-declared and the lockfile
resolved. **Do not add dependencies or touch `pnpm-lock.yaml` /
`package.json`** — if you believe you need another dependency, stop and
report it in your result instead.
