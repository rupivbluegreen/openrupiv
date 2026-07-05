# Governance — v0

> Status: pre-public, single-maintainer phase. This document exists from day
> zero so the project's decision-making is legible before it has a community,
> and so the path to shared maintainership is committed to in writing, not
> improvised later.

## Current structure

**openRupiv** is a personally sponsored project, currently maintained by a
single maintainer (@rupivbluegreen) — no employer or corporate sponsor holds
any rights or influence over it; future sponsorships, if any, come through
the non-paywall funding paths in PLAN.md §8 and never buy decision power.
During this phase the maintainer makes final decisions on
all matters, with two standing constraints:

1. Every settled technical decision is recorded as an ADR in `docs/adr/`.
   Decisions that are not written down are not settled.
2. The non-negotiables in `CLAUDE.md` and the "do not stub compliance" rule in
   `PLAN.md` bind the maintainer too. Changing them requires an ADR that
   explicitly supersedes the prior one.

## Decision-making

- **Day-to-day changes** — pull requests reviewed by a maintainer; CI must be
  green; DCO sign-off required on every commit.
- **Significant changes** (new product surface, spec schema changes, security
  model changes, governance changes) — RFC first: a design document proposed
  as a PR against `docs/rfcs/`, open for comment for at least 7 days once the
  project is public, then accepted or rejected with a written rationale and,
  if accepted, an ADR.
- **Security-sensitive paths** (authn/authz, sandbox boundaries, audit-log
  integrity, release signing) — always require review by a human maintainer,
  regardless of who or what authored the change.

## Maintainer ladder

| Role | How you get there | What you can do |
|---|---|---|
| Contributor | Any merged PR | Listed in release notes |
| Reviewer | Sustained quality contributions (~5+ non-trivial merged PRs) and a maintainer nomination | Approving review counts toward merge on non-security paths |
| Maintainer | ~3 months as an active reviewer, nominated by a maintainer, no objections from other maintainers within 14 days | Merge rights, release rights, vote on RFCs and governance changes |

Maintainers who are inactive for 6 months move to emeritus status (honored,
no merge rights) and can return by request.

## Commitments

- **Two external co-maintainers by month 6** of public life. Bus factor is
  this project's #1 structural risk; recruiting co-maintainers is a roadmap
  item with a deadline, not an aspiration.
- **Foundation decision by month 9–10**: CNCF Sandbox vs Eclipse Foundation vs
  independent, decided in the open with a written rationale (RFC).
- **No paid tier, ever, for features in this repository.** If sustainability
  requires money, it comes from grants, sponsorships, or donations — never
  from gating features. This commitment can only be changed by a governance
  RFC, and the intent is that it never is.

## Licensing and provenance

- License: Apache-2.0 (`LICENSE`).
- All contributions require [DCO](DCO) sign-off (`git commit -s`).
- No CLA. DCO only.

## Code of conduct

The [Contributor Covenant](CODE_OF_CONDUCT.md) applies to all project spaces.
Enforcement contact: arunbharadwaj13@gmail.com.

## Amending this document

Governance changes follow the RFC process above. While the project is
pre-public, amendments are recorded in git history with rationale in the
commit message.
