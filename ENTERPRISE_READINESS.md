# Enterprise Readiness — honest status

This page is the project's claim ledger. **We never market ahead of this
table.** Statuses: ✅ shipped (enforced, logged, evidenced) · 🚧 in progress ·
📋 planned (target milestone) · ❌ not planned for v1.

Rule: a control that doesn't enforce, log, and produce evidence doesn't ship —
the dependent feature is gated instead. "Shipped" here means all three.

_Last updated: 2026-07-06 (Phase 1 core landed; e2e-verified via `scripts/e2e-quickstart.sh`)._

## Identity & access

| Requirement | Status |
|---|---|
| OIDC SSO | ✅ runtime v0 — Authorization Code + PKCE via discovery, sessions, e2e-verified. Human maintainer review of the auth surface still pending |
| SAML SSO | 📋 M5 |
| SCIM provisioning | 📋 M5 |
| RBAC | 📋 M4 |
| ABAC via OPA | 📋 M4 |
| Scoped API tokens | 📋 M4 |
| Service identity (SPIFFE) | 📋 M5 |
| Session policies | 📋 M5 |

## Security

| Requirement | Status |
|---|---|
| TLS everywhere | 📋 M3 |
| Encryption at rest | 📋 M3 |
| External secrets (Vault/KMS) | 📋 M6 |
| Sandboxed code execution | 📋 M3 |
| Rate limits | 📋 M3 |
| SECURITY.md + private VDP | 🚧 policy file exists; VDP formalizes at M3 |
| Signed releases (cosign) | 📋 M6 |
| SBOM (CycloneDX) | 📋 M6 |
| SLSA provenance | 📋 M6 (L3 by M12) |
| Dependency policy | 🚧 license allowlist in CI |
| OpenSSF Scorecard ≥ 8 | 📋 M6 |
| External security audit | 📋 M9–M10, report published |

## Compliance & governance

| Requirement | Status |
|---|---|
| Hash-chained tamper-evident audit log | 📋 M3 |
| SIEM export (syslog/OTLP) | 📋 M4 |
| Retention policies | 📋 M7 |
| Data-residency config | 📋 M7 |
| Model/agent registry with AI Act risk classification | 📋 M7 |
| HITL gates | 📋 M4 |
| Annex IV / RoPA / DPIA generators | 📋 M7–M8 |
| Eval harness | 📋 M8 |

## Operations

| Requirement | Status |
|---|---|
| HA control plane | 📋 M5 |
| Backup/restore | 📋 M6 |
| Zero-downtime upgrades + documented rollback | 📋 M6 |
| Versioned migrations | ✅ forward-only, per-file transactional, recorded in `_migrations` |
| OTel traces/metrics/logs | 📋 M6 |
| SLO doc + capacity guidance | 📋 M8 |
| Air-gap installer | 📋 M11 |

## Deployment

| Requirement | Status |
|---|---|
| Docker Compose 10-minute quickstart | ✅ `openrupiv new` → compose up (postgres + Dex + runtime), e2e-verified incl. 4-eyes flow; p50 timing on clean machines not yet measured |
| Helm chart | 📋 M5 |
| Terraform modules | 📋 M8 |
| Reference architectures (AWS/Azure/GCP/on-prem/OpenShift) | 📋 M8 |

## Docs & enablement

| Requirement | Status |
|---|---|
| Quickstart < 10 min | 📋 M2 |
| Tutorials + full reference | 📋 continuous from M2 |
| Architecture + threat model docs | 📋 M3 |
| Compliance mapping docs | 📋 M7 |
| Migration guides (Retool, n8n, Power Apps, Dify) | 📋 M9 |
| Versioned docs site | 📋 M4 |

## Legal & project hygiene

| Requirement | Status |
|---|---|
| License (Apache-2.0) + DCO | ✅ |
| GOVERNANCE.md + maintainer ladder | ✅ v0 |
| Code of conduct | ✅ |
| RFC process | ✅ defined in GOVERNANCE.md |
| Trademark + domain | 🚧 name decided (openRupiv, 2026-07-06); trademark search + domain registration pending |
| GitHub org | ✅ personal account — github.com/rupivbluegreen/openrupiv (public since 2026-07-06) |
| Telemetry privacy notice | 📋 blocked on Open Decision #4 |
| Export-control note | 📋 M1 |
