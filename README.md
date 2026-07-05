# openRupiv

> ⚠️ **Early development — no releases yet.** Phase 1 is being built in the
> open; APIs and the app spec are unstable until v0.1. Honest capability
> status lives in [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md) — we
> never claim ahead of that page. A personally sponsored project, built by
> one human and Claude Code. See [PLAN.md](PLAN.md) for the full build plan.

**An Apache-2.0, enterprise-ready, agent-native app development platform where
the enterprise features are the free features.**

Every commercial app platform gates the same things behind enterprise tiers:
SSO, SCIM, RBAC, audit logs, HA, air-gapped deploy, compliance reporting.
Every open-source alternative replicates that gating in an "enterprise
edition." This project doesn't. Four pillars, all free, all in core:

1. **Zero SSO tax** — SAML, OIDC, SCIM, RBAC/ABAC, audit logs, HA, air-gap
   installer in the Apache-2.0 core.
2. **Apps are Git artifacts, not database rows** — describe an app in natural
   language, get a reviewable declarative spec plus generated code in a Git
   repo. Change management is a pull request. Delete the platform and your
   apps are still readable code.
3. **Compliance evidence as a byproduct** — hash-chained audit log, SIEM
   export, and generated EU AI Act / GDPR artifacts emitted from runtime
   metadata, not assembled by hand.
4. **Agent-native and interop-native** — agents are governed workers with
   identity, policy, and human-in-the-loop gates. MCP client + server and A2A
   from v1.

## Status

Phase 0 — pre-flight. No releases. The honest, unembellished state of every
enterprise capability is tracked in
[ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md); we never claim ahead of
that page.

- **Plan / source of truth:** [PLAN.md](PLAN.md)
- **Current phase spec:** [specs/phase-1.md](specs/phase-1.md)
- **Decisions:** [docs/adr/](docs/adr/)
- **Governance:** [GOVERNANCE.md](GOVERNANCE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Quickstart

Coming with Phase 1: `docker compose up` → described app running locally in
under 10 minutes, OIDC login included (a preconfigured dev IdP ships in the
Compose stack).

## License

[Apache-2.0](LICENSE). Contributions require [DCO](DCO) sign-off. No CLA.
