# Enterprise Readiness — honest status

This page is the project's claim ledger. **We never market ahead of this
table.** Statuses: ✅ shipped (enforced, logged, evidenced) · 🚧 in progress ·
📋 planned (target milestone) · ❌ not planned for v1.

Rule: a control that doesn't enforce, log, and produce evidence doesn't ship —
the dependent feature is gated instead. "Shipped" here means all three.

_Last updated: 2026-07-07 (Phase 2 runtime wiring: audit events + RBAC-via-PDP
implemented and unit/integration-tested; pending human maintainer review of the
auth/authz/audit-integrity paths before these count as shipped; @openrupiv/spec v0.2
agents schema landed; agent-trigger route, MCP client+server, and A2A endpoint
now wired into `@openrupiv/runtime` and proven end-to-end — all gated off in
production by default pending the real tool sandbox and human maintainer
review of three new `auth.ts` touches and two interim bearer-verification
choices)._

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
| Sandboxed code execution | 📋 M3 — mechanism decided: per-execution bubblewrap jails (unprivileged user namespaces) in a dedicated `sandbox` sidecar, zero `docker.sock` exposure ([ADR-0007](docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md), status: proposed, human-only review path). `packages/sandbox` not yet implemented — no isolation is running today |
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
| HITL gates | 🚧 Wired into the runtime: `POST /admin/agents/:task/run` triggers a governed agent task (deny-by-default tool allowlist, policy-checked + audited tool calls), which can `propose()` a human-gated transition; `GET /admin/agent-proposals` lists them. Proven end-to-end (`packages/runtime/test/agent-approval-e2e.test.ts`): an agent proposal plus one human approval leaves a 4-eyes transition pending, with real assertions on the audit trail (`agent.tool_call` decision:"allow", `agent.transition_proposed`) — a second, distinct human approver is still required. Gated OFF in production by default: no real Python tool sandbox exists yet (ADR-0007, `packages/sandbox` not built), so `ServerDeps.agents` has no production default (`serveAppDir` never populates it) and the trigger/proposal-listing routes are simply not registered until a deployment supplies a real `ToolSandbox` by calling `createServer` directly. `@openrupiv/spec` v0.2 supports real agent task declarations (`tools`, `proposes`), compiled and golden-corpus-covered. The one shipped task, `vendor-risk-review`, is a fixed deterministic procedure (not an LLM planner) |
| MCP (client + server) | 🚧 `POST /mcp` is mounted by default, exposing one read-only capability, `workflow-instance-status`. The client (`MCP_SERVERS_CONFIG` env var) is inert until a deployment configures at least one external server. Inbound bearer verification is an interim, PROPOSED choice (reuses the platform's own signed session token via the existing `verifyPayload` path, not third-party OIDC token introspection) pending maintainer review. Note: `workflow-instance-status` has no row-level/ownership scoping — any authenticated subject can read any workflow-tracked entity's status by table+id. This matches the platform's existing `GET /api/<entity>/:id` route exactly (entity *reads* are not RBAC-gated anywhere in v0.2, only workflow *transitions* are) — an intentional, pre-existing characteristic, not a new gap |
| A2A (agent-to-agent) | 🚧 `POST /a2a/v1` (`SendMessage`, `GetTask`) + `GET /.well-known/agent-card.json`, deny-by-default: disabled unless a deployment supplies both a real agent-runtime dependency (`deps.agents`) and a non-empty A2A client registry (`deps.a2a`) — neither has a production default, same gating as the HITL-gates row above. Inbound client verification is an interim, PROPOSED shared-secret choice (one env-var-named secret per registered client, constant-time compared), not the OAuth client-credentials grant the design doc describes, pending maintainer review. The agent-card route is public discovery metadata by default (per the A2A spec), with an opt-in `agentCardRequireAuth` flag for regulated deployments |
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
