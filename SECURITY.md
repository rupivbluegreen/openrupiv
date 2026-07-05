# Security Policy

> **Status: pre-release.** There are no supported versions yet — nothing has
> shipped. This policy exists from day zero and will be expanded into a full
> vulnerability disclosure program (VDP) before the first public release, per
> the [enterprise readiness matrix](ENTERPRISE_READINESS.md).

## Supported versions

| Version | Supported |
|---|---|
| — | No releases yet |

## Reporting a vulnerability

Email **arunbharadwaj13@gmail.com** with the subject prefix `[SECURITY]`.
Once the repository is public, GitHub private vulnerability reporting will be
enabled and preferred.

Please include: affected component, reproduction steps, impact assessment,
and any suggested remediation. You can expect an acknowledgment within 72
hours.

Please do not open public issues for suspected vulnerabilities.

## Design commitments (what you can hold us to)

- The compliant path is the default path; secure-by-default everywhere.
- Security and compliance controls are never stubbed — features are gated
  until their controls enforce, log, and produce evidence.
- OIDC-based authentication from the first commit; no local-only auth mode.
- Human maintainer review is mandatory on authn/authz, sandbox boundaries,
  audit-log integrity, and release signing — regardless of author.
- Releases will be signed (cosign), with SBOM (CycloneDX) and SLSA provenance,
  before v1.0. An external security audit is planned pre-v1.0 and its report
  will be published.
