# 0005 — Dev-mode role grant and second dev user

- Status: accepted
- Date: 2026-07-06

## Context

Workflow guards and approval rules are role-based; the runtime takes roles
from a configurable OIDC claim (contract §2). But the bundled Dex dev IdP
(ADR-0002) cannot attach a roles claim to its static-password users, and it
seeded only one user — so in the quickstart every role-guarded transition
would 403, and a 4-eyes approval could never complete. The flagship demo
would be dead on arrival while production behavior was fine.

## Decision

1. **Dev-mode role grant (runtime).** When `OPENRUPIV_DEV_MODE=true` AND the
   authenticated user's roles claim is absent or empty AND the app spec
   declares roles, the runtime grants that user *all* declared app roles,
   emitting a structured `warn` log (`auth.dev_role_grant`) on every login.
   A present roles claim always wins; with `devMode=false` behavior is
   unchanged (no roles → guarded transitions 403).
2. **Second dev user (CLI).** `openrupiv new` seeds Dex with
   `dev@example.com` *and* `dev2@example.com` (distinct `sub` values), so
   the distinct-approver rule can be genuinely satisfied — and its
   same-user 409 demonstrated — locally.

## Consequences

- The quickstart exercises real transitions and real n-eyes enforcement.
- Role *denial* (403 for a missing role) is not observable in dev mode with
  claim-less users; it stays covered by runtime unit tests and by any dev
  IdP that does send a roles claim (the grant only fires on empty roles).
- The grant is triple-gated (dev mode + empty claim + declared roles),
  loudly logged, and unreachable in production configuration — consistent
  with "the compliant path is the default path."
