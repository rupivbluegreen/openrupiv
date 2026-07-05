# 0004 — Generated apps are declarative artifacts served by the runtime engine

- Status: accepted
- Date: 2026-07-06

## Context

ADR-0001 fixed that the LLM produces only the spec and code is a
deterministic projection. That still leaves a seam question: does the
compiler emit a *complete server* per app (duplicating OIDC, workflow
enforcement, and CRUD into every generated app), or a *declarative app
artifact* that a shared runtime engine serves?

Duplicating the server per app means a security fix in auth or in n-eyes
enforcement requires regenerating every deployed app — an update nightmare
and an unreviewable surface. It also bloats every app diff with framework
noise, undermining the "change management is a pull request" pillar.

## Decision

The compiler emits an **app directory** of declarative, readable artifacts;
the `@openrupiv/runtime` engine loads and serves it:

```
<workspace>/app/
  spec.json          canonical spec (the contract)
  migrations/*.sql   versioned, forward-only, plain SQL
  README.md          generated docs for the app
  package.json       standalone test runner (no registry dependencies)
  test/*.test.mjs    node:test invariant checks — run with zero installs
  server.mjs         optional entry for running with @openrupiv/runtime as a library
```

Security-relevant behavior — OIDC, sessions, role guards, workflow
transitions, distinct-approver (n-eyes) enforcement — lives in the runtime
package exactly once, on the human-review path.

## Consequences

- **Reviewability:** app diffs are spec + SQL — reviewable by domain owners,
  not framework archaeology. Enforcement code is reviewed once, centrally.
- **Fixability:** an auth or enforcement fix ships as a runtime upgrade; no
  app regeneration.
- **The "delete the platform" promise, made precise:** the app directory
  remains fully readable (JSON + SQL + docs) and its tests run with plain
  Node. Serving it requires the Apache-2.0 runtime *library* (or anything
  else that speaks the documented directory contract) — never the platform
  services (CLI, generator, builder).
- **Decoupling for parallel build:** the compiler depends only on
  `@openrupiv/spec`; the runtime consumes the documented directory contract
  (`specs/phase-1-contracts.md`), not compiler internals.
