# Enterprise Readiness — honest status

This page is the project's claim ledger. **We never market ahead of this
table.** Statuses: ✅ shipped (enforced, logged, evidenced) · 🚧 in progress ·
📋 planned (target milestone) · ❌ not planned for v1.

Rule: a control that doesn't enforce, log, and produce evidence doesn't ship —
the dependent feature is gated instead. "Shipped" here means all three.

_Last updated: 2026-07-06 (Phase 2 runtime wiring: audit events + RBAC-via-PDP
implemented and unit/integration-tested; pending human maintainer review of the
auth/authz/audit-integrity paths before these count as shipped; @openrupiv/spec v0.2
agents schema landed)._

## Identity & access

| Requirement | Status |
|---|---|
| OIDC SSO | ✅ runtime v0 — Authorization Code + PKCE via discovery, purpose-bound signed sessions, e2e-verified. Passed an adversarial security review (critical replay bypass found + fixed) and human maintainer sign-off (2026-07-06) |
| SAML SSO | 📋 M5 |
| SCIM provisioning | 📋 M5 |
| RBAC | 🚧 runtime enforcement implemented + tested: workflow guard/approval role checks and `/admin/audit` resolve through the deny-by-default OPA PDP; every decision (allow AND deny) audited; roles come from IdP claims. Pending human maintainer review (authz path); no role-management UI/SCIM yet |
| ABAC via OPA | 🚧 `@openrupiv/policy` — OPA/Rego embedded as WASM (ADR-0006), deny-by-default PDP with RBAC policy, tested. Runtime wiring done (workflow transitions, approvals, audit reads — decisions audited); pending human maintainer review |
| Scoped API tokens | 📋 M4 |
| Service identity (SPIFFE) | 📋 M5 |
| Session policies | 📋 M5 |

## Security

| Requirement | Status |
|---|---|
| TLS everywhere | 📋 M3 |
| Encryption at rest | 📋 M3 |
| External secrets (Vault/KMS) | 📋 M6 |
| Sandboxed code execution | 🚧 `packages/sandbox` built, unit-tested (86 tests), and adversarially reviewed: per-execution bubblewrap jails (unprivileged user namespaces), boot canary, resource limits, seccomp — [ADR-0007](docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md), status: proposed, human-only review path, **not yet human-reviewed/merged**. `createSidecarSandbox` implements `ToolSandbox` and `openrupiv new` generates the `sandbox` Compose service, which starts and passes its own boot canary. Real isolation (network egress block, fs escape block, rlimit enforcement) is CI-verified-on-push via the `sandbox-boot-canary` job, **pending its first green run** — this dev environment cannot create Linux user namespaces, so the proof has only reached its SKIP path locally; it has not yet executed on GitHub Actions. **Not yet wired into any generated app's runtime deployment** — `packages/runtime`'s `bin/serve.mjs` constructs no `AgentRuntime`/`ToolSandbox`, the generated runtime service's Compose env carries no `SANDBOX_TOKEN`, and v1 ships zero concrete Python `RegisteredTool` implementations — so there is nothing yet for a real agent task to sandbox end-to-end |
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
| Hash-chained tamper-evident audit log | 🚧 implemented + tested: append-only chained store (`@openrupiv/audit`) wired into the runtime — auth events (login/logout/session-reject/dev-role-grant), workflow transitions/approvals (same-transaction, fail-closed), rejections and every policy decision; `/admin/audit` returns the chain + verify status with exact tamper location. Pending human maintainer review (audit-integrity is a human-only review path) |
| SIEM export (syslog/OTLP) | 🚧 implemented + tested: `GET /admin/audit/export?format=jsonl\|otlp\|syslog` (policy-gated `audit.read`, decisions audited). Pull-based export route only — no push connectors yet; pending the same human review |
| Retention policies | 📋 M7 |
| Data-residency config | 📋 M7 |
| Model/agent registry with AI Act risk classification | 📋 M7 |
| HITL gates | 🚧 `@openrupiv/agents` — governed agent runtime built + tested (deny-by-default tool allowlist, 6-step policy-checked + audited tool calls, atomic propose()-only HITL primitive, fail-fast startup validation of tool allowlists; agent proposals never touch `workflow_approvals` or fire transitions). `@openrupiv/spec` v0.2 now supports real agent task declarations (`tools`, `proposes`), compiled and golden-corpus-covered. `@openrupiv/mcp` — MCP client + server built + tested (deny-by-default egress/exposure, policy-checked + audited both directions). Neither agents nor MCP is wired into the runtime yet — no agent can trigger a real proposal and no MCP endpoint is live today; the real Python tool sandbox (ADR-0007, `packages/sandbox`) is now built and CI-verified-on-push (see the "Sandboxed code execution" row above) but not yet wired into the runtime, so `ToolSandbox` remains fakes-only in these agent/MCP tests |
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
| Trademark + domain | 🚧 name decided (openRupiv, 2026-07-06); domain `rupiv.ai` registered 2026-07-06; trademark search pending |
| GitHub org | ✅ personal account — github.com/rupivbluegreen/openrupiv (public since 2026-07-06) |
| Telemetry privacy notice | 📋 M2 — design resolved 2026-07-06 (opt-out, anonymous instance ping, self-hostable endpoint, PLAN.md Open Decision #4); notice/implementation itself not yet written |
| Export-control note | 📋 M1 |
