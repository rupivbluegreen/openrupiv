# CLAUDE.md — openrupiv operating contract

`openRupiv` is an Apache-2.0, enterprise-ready, agent-native app
development platform where enterprise features (SSO, SCIM, RBAC, audit, HA,
air-gap) ship free in core. **PLAN.md is the source of truth** for scope,
roadmap, and rationale — read it before substantive work.

## Non-negotiables

These bind every session, every branch, every PR. Changing one requires a
superseding ADR approved by a human maintainer.

1. **The compliant path is the default path.** Secure-by-default everywhere.
2. **Never stub security or compliance controls.** A control that doesn't
   enforce, log, and produce evidence doesn't ship — gate the dependent
   feature instead.
3. **OIDC from the first commit. No local-only auth.** Dev experience is
   preserved by bundling a preconfigured Dex IdP in the Compose stack
   (ADR-0002), never by adding a password table.
4. **The LLM generates the app spec only.** Application code is a
   deterministic projection of the spec — same spec in, byte-identical code
   out (ADR-0001). No free-form LLM code emission into generated apps.
5. **Apps compile to a declarative spec + generated code committed to Git.**
   The spec is the contract; UI and runtime are projections of it.
6. **Every package ships a README and tests.** CI stays green on `main`.
7. **Never claim ahead of ENTERPRISE_READINESS.md.** Update it in the same PR
   that changes a capability's real status.

## Phase discipline

- Work only within the current phase spec in `/specs` (now:
  `specs/phase-1.md`). Stop at the phase's acceptance criteria for human
  review; do not start the next phase.
- Specs before code: non-trivial work is specified before implementation.
- Settled decisions get an ADR in `docs/adr/` (sequential numbering, format
  per `docs/adr/README.md`). Decisions not written down are not settled.

## Human-only review paths

Changes touching any of these require review by a human maintainer before
merge, regardless of author or CI status:

- Authentication / authorization
- Sandbox boundaries (tool execution isolation)
- Audit-log integrity (hash chain, storage, export)
- Release signing and supply-chain workflows

Agent sessions may draft changes on these paths but must flag them as
human-review-required and never merge them autonomously.

## Repo conventions

- pnpm workspaces monorepo. Runnable packages in `packages/`, apps in
  `apps/`, one `CLAUDE.md` per package as packages appear.
- Node ≥ 20, pnpm via corepack (`corepack pnpm ...` if pnpm is not on PATH).
- Commands: `pnpm typecheck` · `pnpm lint` · `pnpm test` (recursive,
  `--if-present`).
- Every commit is DCO-signed: `git commit -s`.
- TypeScript strict mode everywhere (`tsconfig.base.json`); Python only
  inside the agent tool sandbox (later phase).
- Golden tests for the generator: prompt → expected spec snapshots live with
  the generator package; regressions in generation quality must fail CI.

## Definition of done (any task)

1. Code + tests + package README updated together.
2. `pnpm typecheck && pnpm lint && pnpm test` pass locally.
3. Security-relevant behavior is enforced *and* logged *and* evidenced — or
   the feature is gated off.
4. ENTERPRISE_READINESS.md updated if a capability's status changed.
5. New settled decisions captured as ADRs.
