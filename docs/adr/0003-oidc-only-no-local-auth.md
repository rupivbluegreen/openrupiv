# 0003 — OIDC-only authentication; no local auth

- Status: accepted
- Date: 2026-07-06

## Context

Most platforms ship username/password auth first and bolt SSO on later —
usually behind an enterprise tier. That ordering creates permanent debt: a
password table, reset flows, lockout policies, credential-stuffing surface,
and a second code path through every authorization decision. This project's
entire wedge is that enterprise identity is the free, default path.

## Decision

Authentication is OIDC from the first commit. There is no local user/password
store, no "admin password" bootstrap, no basic-auth fallback. Development and
demo environments get identity from the bundled Dex IdP (ADR-0002). SAML
arrives at M5 as a second federation protocol, not as a second auth model.

## Consequences

- Zero password-handling surface: nothing to hash, rotate, reset, or breach.
- Every deployment exercises the same auth path enterprises will use —
  the SSO integration is tested by every user, every day.
- Hard dependency on an IdP being reachable; the Compose stack makes that
  free locally, and docs must cover IdP outage behavior for production.
- Some hobbyist friction is accepted deliberately; the target user is the
  regulated organization, and Dex keeps the hobbyist path to one command.
