# Contributing

> **Status: pre-public.** This repository has not been published yet. This
> document is written ahead of time so contribution mechanics are settled
> before the first external contributor arrives.

## Ground rules

- **License & sign-off.** All contributions are accepted under Apache-2.0 and
  require [Developer Certificate of Origin](DCO) sign-off on every commit:

  ```
  git commit -s
  ```

  This adds a `Signed-off-by:` trailer with your name and email. CI rejects
  PRs containing unsigned commits. No CLA — DCO only.

- **CI is the arbiter.** `main` stays green. A PR that breaks typecheck, lint,
  tests, the secret scan, or the license scan does not merge, no exceptions.

- **Do not stub security or compliance controls.** A control that doesn't
  enforce, log, and produce evidence doesn't ship — gate the feature instead.
  PRs that add a "TODO: enforce later" on a security path will be declined.

- **Specs before code.** Non-trivial work is described in a spec under
  `/specs` (per phase) or an RFC under `docs/rfcs/` before implementation.
  Settled decisions get an ADR in `docs/adr/`.

## Development setup

Requirements: Node ≥ 20, pnpm (via `corepack enable`), Docker (for the
Compose stack once Phase 1 lands).

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

This is a pnpm-workspaces monorepo. Runnable packages live under `packages/`;
each package ships its own README and tests.

## Pull requests

- One logical change per PR; keep diffs reviewable.
- Every package touched must keep its README and tests in lockstep with the
  change.
- Security-sensitive paths (authn/authz, sandbox boundaries, audit-log
  integrity, release signing) always get human maintainer review — expect
  slower turnaround there by design.
- Write commit messages that explain *why*, not just what.

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

All project spaces are governed by the
[Contributor Covenant](CODE_OF_CONDUCT.md).
