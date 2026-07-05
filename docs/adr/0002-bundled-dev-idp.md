# 0002 — Bundle Dex as the dev IdP in the Compose stack

- Status: accepted
- Date: 2026-07-06

## Context

Two non-negotiables collide: OIDC-only authentication from the first commit
(ADR-0003), and a Docker Compose quickstart with time-to-first-running-app
under 10 minutes. If the quickstart's first instruction is "configure your
identity provider," the p50 target is unreachable and the demo moment dies.

## Decision

The Docker Compose stack bundles [Dex](https://dexidp.io/) as a preconfigured
development IdP: a seeded static connector with a dev user, client ID/secret
wired into the runtime via Compose environment, issuer reachable on the
Compose network. `docker compose up` → working OIDC login with zero identity
configuration.

Dex over Keycloak: an order of magnitude lighter (single Go binary,
config-file driven), sufficient for dev/demo, and unmistakably *not*
production identity — which keeps the pressure to connect a real IdP.

## Consequences

- The quickstart stays honest: real OIDC flows (discovery, code exchange,
  token validation) from minute one, not a mock.
- Docs must make the seam obvious: "replace the `dex` service with your IdP's
  issuer URL + client credentials" is the entire production migration.
- The dev Dex config ships with conspicuous non-production markers (dev-only
  credentials, `example.com` users) and the runtime refuses to start with the
  bundled dev client secret unless an explicit `OPENPLANE_DEV_MODE=true` flag
  is set — the compliant path stays the default path.
- No password table, no local-auth code path, ever (ADR-0003 holds).
