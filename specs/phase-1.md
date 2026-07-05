# Phase 1 spec — Core (M1–M2)

> Contract for Phase 1 builder sessions. Read `CLAUDE.md` and `PLAN.md`
> first. Stop at the acceptance criteria below for human review; do not start
> Phase 2 work.

## Goal

**Zero → described app running locally in under 10 minutes.**

```
openrupiv new my-workspace
cd my-workspace
openrupiv generate "an approval workflow for vendor onboarding with 4-eyes review"
docker compose up
# → open browser, log in via OIDC, use the generated app
```

Everything in this phase serves that one demo path.

## Scope

### In

1. **App spec schema v0** (`packages/spec`)
2. **CLI** with `new` and `generate` (`packages/cli`)
3. **Generator** — LLM → spec only (`packages/generator`)
4. **Compiler** — spec → code, deterministic (`packages/compiler`)
5. **Runtime** — serves a compiled app, Postgres-backed, OIDC-authenticated
   (`packages/runtime`)
6. **Docker Compose quickstart** — runtime + Postgres + Dex (ADR-0002)

### Out (explicitly deferred)

Agent runtime, MCP/A2A, OPA policy engine, audit log, RBAC beyond
authenticated/unauthenticated, web builder, SAML/SCIM, connectors beyond
Postgres, compliance packs, Helm/HA, telemetry. Where the spec schema has
fields for these (policies, agent tasks, evidence hooks), v0 defines the
shape but the compiler rejects specs that use them, with a machine-readable
"not yet supported" error — never a silent no-op (non-negotiable #2).

## Architecture decisions in force

- **ADR-0001** — LLM generates the spec only; code is a deterministic
  projection. Same spec → byte-identical output.
- **ADR-0002** — Dex bundled in Compose as dev IdP; runtime refuses the
  bundled dev client secret unless `OPENRUPIV_DEV_MODE=true`.
- **ADR-0003** — OIDC only. No password table, no bootstrap admin password,
  no basic-auth fallback.

## Deliverables

### 1. App spec schema v0 — `packages/spec`

Versioned JSON Schema (authored specs may be YAML; canonical form is JSON)
with `specVersion: "0.1"`. Top-level sections:

| Section | v0 scope |
|---|---|
| `app` | name, slug, description, version |
| `entities` | typed fields (string, number, boolean, date, enum, reference), required/unique, relations (1:n, n:m) |
| `pages` | list, detail, form pages bound to entities; field selection and ordering |
| `workflows` | state machines on entities: states, transitions, guards limited to role checks and field predicates; approval steps incl. n-eyes (distinct-approvers) rule |
| `policies` | shape defined, **compiler-rejected in v0** ("not yet supported") |
| `agents` | shape defined, **compiler-rejected in v0** |
| `evidence` | shape defined, **compiler-rejected in v0** |

Package exports: the schema itself, a validator (`validateSpec`) returning
machine-readable errors (JSON Pointer paths + error codes), and TypeScript
types generated from the schema. Errors are designed for two consumers with
the same shape: the generator's retry loop and the human's terminal.

### 2. CLI — `packages/cli`

- `openrupiv new <name>` — deterministic scaffold: workspace directory with
  git init, `openrupiv.yaml` project config, Compose file, README. No network
  calls, no LLM.
- `openrupiv generate "<description>"` — runs generator → validator → compiler
  → writes spec + code + tests, then commits to the workspace repo
  (DCO-signed with the user's git identity) so change management is
  PR-shaped from the very first artifact.
- Exit codes and errors are machine-readable (JSON on `--json`), because the
  platform must be agent-buildable (PLAN.md pillar 4).
- API key via `ANTHROPIC_API_KEY` env var only in v0. Never written to disk,
  never echoed to logs.

### 3. Generator — `packages/generator`

- Input: natural-language description. Output: a spec that passes
  `validateSpec`, or a typed failure. Nothing else.
- Loop: prompt → candidate spec → validate → on schema violation, retry with
  the validator's machine-readable errors injected (max 3 attempts) → fail
  loudly with the last errors.
- Model calls behind a narrow `SpecModel` interface so tests run on a
  recorded/fake model and evals can swap models.
- **Golden tests**: a corpus of prompt → expected-spec snapshot pairs
  (semantic comparison, not byte comparison). Corpus starts at ≥10 prompts
  covering every v0 schema section that the compiler supports. Regressions
  fail CI.

### 4. Compiler — `packages/compiler`

- Input: valid spec. Output: a complete, readable TypeScript app: entity
  modules, versioned SQL migrations, REST API routes, server-rendered UI
  pages, workflow state machines, and generated tests for the app itself.
- **Determinism is a tested property**: compile the same spec twice →
  byte-identical trees (stable ordering, no timestamps, no randomness).
  Snapshot tests per corpus spec.
- Generated code must stand alone: `pnpm install && pnpm test` passes inside
  a generated app without the platform (the "delete the platform" promise).
- Unsupported spec sections (policies/agents/evidence) → typed
  `ERR_UNSUPPORTED_SECTION` failure listing the offending JSON Pointers.

### 5. Runtime — `packages/runtime`

- TypeScript (Node ≥ 20). Serves a compiled app: applies migrations
  (versioned, forward-only in v0), hosts API + pages, Postgres persistence.
- **Auth (human review required before merge):** OIDC relying party via
  discovery — Authorization Code + PKCE, ID-token validation (issuer,
  audience, expiry, signature via JWKS), secure session cookie (HttpOnly,
  SameSite=Lax, Secure outside dev mode), logout. Config: issuer URL, client
  ID/secret from env. Every route authenticated by default; there is no
  anonymous mode.
- Single org, single app instance in v0. Multi-tenancy is a schema-and-design
  concern deferred to the roadmap, not smuggled in.
- Structured JSON logs from day one (they become the audit substrate in
  Phase 2 — do not log secrets or tokens; add a redaction helper and test it).

### 6. Compose quickstart

`docker compose up` brings up: `runtime`, `postgres` (pinned major version,
volume-backed), `dex` (seeded dev user `dev@example.com`, conspicuous
dev-only credentials). Runtime waits for Postgres + Dex health before
serving. Quickstart doc in the workspace README; target: a first-time user
reaches a logged-in generated app in <10 minutes including image pulls.

## Package layout

```
packages/
  spec/        schema, validator, generated types
  generator/   LLM → spec (SpecModel interface, retry loop, golden corpus)
  compiler/    spec → code (templates, determinism tests)
  cli/         new/generate commands, workspace scaffolding
  runtime/     server, OIDC, migrations, Postgres
```

Each package: `README.md`, tests, `typecheck`/`lint`/`test` scripts. Shared
strict TS config from `tsconfig.base.json`.

## Build order (suggested)

spec → compiler → runtime → cli (`new`) → generator → cli (`generate`) →
compose. The compiler and runtime can be developed against hand-written
corpus specs before the generator exists — the LLM is the last mile, not the
foundation.

## Acceptance criteria (human review gate)

1. `openrupiv new` + `generate` + `docker compose up` + OIDC login + using
   the generated approval-workflow app works end-to-end on a clean machine,
   in under 10 minutes, following only the written quickstart.
2. The generated app's 4-eyes rule actually enforces two distinct approvers
   (test proves a same-user second approval is rejected — and the rejection
   is logged).
3. Golden corpus ≥ 10 prompts; prompt→spec and spec→code snapshots green;
   compiler determinism test (double-compile byte equality) green.
4. A generated app passes its own tests standalone, outside the platform.
5. No password/local-auth code path exists anywhere (grep-level assertion in
   CI is acceptable); runtime refuses bundled dev credentials without
   `OPENRUPIV_DEV_MODE=true`.
6. Spec sections `policies`/`agents`/`evidence` produce typed rejection, not
   silent omission.
7. Every package has README + tests; `pnpm typecheck && pnpm lint && pnpm
   test` green at root; CI green.
8. ENTERPRISE_READINESS.md updated to reflect what actually shipped.
9. Auth implementation reviewed by a human maintainer (flagged PR).

## Risks specific to this phase

- **Schema v0 too expressive** → generator can't hit it reliably. Mitigation:
  grow the corpus first; cut schema surface before shipping flaky generation.
- **Schema v0 too narrow** → demo apps feel toy. Mitigation: the approval
  workflow with 4-eyes is the bar; if the schema can express that well, v0
  is enough.
- **OIDC subtleties** (clock skew, JWKS rotation, cookie flags behind
  proxies) — budget real time; this is a human-review path and the first
  thing an enterprise evaluator pokes at.
