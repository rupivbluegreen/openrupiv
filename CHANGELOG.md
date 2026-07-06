# Changelog

All notable changes to openRupiv are recorded here. The project has not cut a
release yet; entries below track development milestones. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions will follow
SemVer once releases begin.

## [Unreleased]

### Phase 2 — Agents + policy + audit (in progress)
- (nothing merged yet)

## Phase 1 — Core — 2026-07-06

The zero → described-app-running-locally path, end-to-end.

### Added
- **`@openrupiv/spec`** — versioned app spec (schema v0.1), two-pass
  validator with machine-readable errors (JSON Pointer + stable codes), and
  canonical fixtures including the flagship 4-eyes vendor-onboarding app.
- **`@openrupiv/compiler`** — deterministic projection of a validated spec
  into a standalone app directory (canonical `spec.json`, versioned SQL
  migration, generated docs, zero-dependency `node:test` suite). Byte-for-byte
  determinism is a tested property; unsupported spec sections fail with a
  typed `ERR_UNSUPPORTED_SECTION`.
- **`@openrupiv/runtime`** — serves a compiled app: OIDC relying party
  (Authorization Code + PKCE, ID-token validation), HMAC-signed sessions,
  forward-only transactional migrations, entity CRUD, server-rendered pages
  (XSS-escaped), and transactional n-eyes workflow enforcement with a
  distinct-approver rule.
- **`@openrupiv/generator`** — natural language → app spec (spec only, per
  ADR-0001), with a validate-retry loop and a 13-prompt golden corpus.
- **`@openrupiv/cli`** — `openrupiv new` (deterministic offline workspace
  scaffold with a bundled Dex dev IdP) and `openrupiv generate`.
- **Docker Compose quickstart** — postgres + Dex + runtime; end-to-end
  verified by `scripts/e2e-quickstart.sh` (two OIDC logins, CRUD, 4-eyes
  approval including same-user rejection and distinct-approver completion).
- Project foundations: Apache-2.0 + DCO, governance, honest enterprise
  readiness matrix, CI (typecheck/lint/test, secret scan, license allowlist,
  DCO check), ADRs 0001–0005.

### Security notes
- OIDC-only authentication from the first commit; no local-auth/password path
  anywhere (ADR-0003).
- Auth and workflow-enforcement code underwent an adversarial multi-agent
  security review before Phase 1 was marked complete (see Phase 1 closeout).
  These remain human-only review paths per `CLAUDE.md`.
