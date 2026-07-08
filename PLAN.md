# openRupiv — Open-Source Enterprise App Development Platform — Build Plan

> **Name:** `openRupiv` *(decided 2026-07-06; domain rupiv.ai registered 2026-07-06; trademark search still pending)*
> **License:** Apache-2.0 with DCO sign-off
> **Goal:** Maximize adoption, not revenue. Every enterprise feature ships free. No open-core, no paywall, no "contact sales."
> **Build engine:** One human + Claude Code as the engineering team.
> **Status:** Phase 1 in progress. This document is the public source of truth for scope and roadmap; adoption, launch, and budget planning live in a private companion repo.

---

## 1. Thesis

The enterprise app platform market restructured around agents in 2025–26 (Gemini Enterprise, Copilot Studio, ServiceNow AI tiers, Bedrock AgentCore). Every commercial vendor gates the same things behind enterprise tiers: SSO, SCIM, RBAC, audit logs, HA, air-gapped deploy, compliance reporting. Every OSS alternative (Dify, Flowise, n8n, Appsmith, Budibase) replicates that gating in their "enterprise edition."

**The wedge: there is no fully open, enterprise-ready, agent-native app platform where the enterprise features are the free features.** That is the product.

Four pillars, all free:

1. **Zero SSO tax.** SAML, OIDC, SCIM, RBAC/ABAC, audit logs, HA, air-gap installer — in the Apache-2.0 core. This alone is the adoption headline.
2. **Apps are Git artifacts, not database rows.** Describe an app in natural language → the platform emits a reviewable declarative spec + generated code into a Git repo. Change management is a pull request. GitOps deploy. No black-box lock-in; delete the platform and your apps are still readable code.
3. **Compliance evidence as a byproduct.** Hash-chained audit log, SIEM export, and generated artifacts: EU AI Act Annex IV technical documentation, RoPA entries, DPIA/FRIA prefills, DORA-style registers — emitted from runtime metadata, not assembled manually.
4. **Agent-native and interop-native.** Agents are first-class governed workers (identity, policy, HITL gates), not a chat widget. MCP client + MCP server + A2A from v1. The platform is also *agent-buildable*: deterministic scaffolds, machine-readable errors, exhaustive types, and a first-party Claude Code plugin so users extend it with coding agents the same way it is built.

**Design principle:** the compliant path is the default and easiest path. Platform primitives over novel components. Evidence as byproduct.

---

## 2. Architecture layers

One umbrella product, three layers — community attention is not split across three repos with three brands.

| Layer | Role |
|---|---|
| App platform (this repo) | Builder, app runtime, connectors, admin, compliance packs |
| Agent runtime | Agent execution substrate *inside* this platform — a core package, not a separate product (absorbs the prior `agentforge` plan) |
| LLM firewall | Optional sibling: deploy in front of the platform's model calls; cross-referenced in docs; shared policy/evidence schemas |

Shared across all three: OPA/Rego policy engine, audit record schema, evidence bundle format, SPIFFE identity model — a coherent "compliance-first AI stack."

---

## 3. Product surfaces (v1)

1. **CLI + generator** — `openrupiv new` scaffolds; `openrupiv generate "an approval workflow for vendor onboarding with 4-eyes review"` produces spec + code + tests into Git. This is the primary interface and the demo moment.
2. **Declarative app spec** — versioned YAML/JSON schema covering data model, UI pages, workflows, agent tasks, policies, and evidence hooks. The spec is the contract; UI and runtime are projections of it.
3. **Web builder** — v1 is a *spec editor + previewer*, not a full drag-and-drop canvas. Generate-first, edit-second. (Full visual canvas is a v2 money pit; see Open Decision #5.)
4. **App runtime** — TypeScript; serves generated apps; multi-tenant-capable but v1 ships single-org self-hosted.
5. **Agent runtime** — tool sandbox (Python), HITL approval gates, per-agent identity, policy-checked tool calls.
6. **Admin console** — identity, RBAC, audit, environments, connector credentials, compliance pack management.
7. **Connector SDK + starter connectors** — Postgres, REST/OpenAPI, webhook/event bus, S3-compatible storage, SMTP; MCP client makes every MCP server a connector for free.
8. **Compliance packs** — versioned OSS bundles: Rego policies + evidence schemas + document generators per regulation (GDPR, AI Act first; DORA, NIS2 next).

---

## 4. Enterprise readiness matrix ("what all do I need")

This is the checklist that defines "full enterprise readiness, no paywall." The live, honest status page is [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md) — claims are never made ahead of it.

| Domain | Requirements | Target |
|---|---|---|
| **Identity & access** | OIDC + SAML SSO; SCIM provisioning; RBAC + ABAC via OPA; scoped API tokens; service identity (SPIFFE); session policies | OIDC M2 · SAML/SCIM M5 |
| **Security** | TLS everywhere; encryption at rest; external secrets (Vault/KMS); sandboxed code execution; rate limits; SECURITY.md + private VDP; signed releases (cosign); SBOM (CycloneDX); SLSA provenance; dependency policy; OpenSSF Scorecard ≥ 8 | Core M3 · supply chain M6 · external audit M9–10 |
| **Compliance & governance** | Hash-chained tamper-evident audit log; SIEM export (syslog/OTLP); retention policies; data-residency config; model/agent registry with AI Act risk classification; HITL gates; Annex IV / RoPA / DPIA generators; eval harness | Audit log M3 · packs M7–8 |
| **Operations** | HA control plane (stateless + Postgres + object storage); backup/restore; zero-downtime upgrades with documented rollback; versioned migrations; OTel traces/metrics/logs; SLO doc; capacity guidance; air-gap installer | HA/Helm M5 · air-gap M11 |
| **Deployment** | Docker Compose 10-minute quickstart; Helm chart; Terraform modules; reference architectures (AWS/Azure/GCP/on-prem/OpenShift) | Compose M1 · Helm M5 · ref archs M8 |
| **Docs & enablement** | Quickstart <10 min; tutorials; full reference; architecture + threat model docs; compliance mapping docs; migration guides (Retool, n8n, Power Apps, Dify); versioned docs site | Continuous; migration guides M9 |
| **Legal & project hygiene** | Trademark + domain; DCO; GOVERNANCE.md + maintainer ladder; RFC process; code of conduct; telemetry privacy notice; export-control note | M0–M1 |

Standing rule: **do not stub compliance.** A control that doesn't enforce, log, and produce evidence doesn't ship — gate the feature instead.

---

## 5. Claude Code operating model

One person; Claude Code is the team. The work is structured so agents can verify themselves.

**Repo conventions**
- Monorepo (pnpm workspaces). Root `CLAUDE.md` (architecture, invariants, phase discipline) + per-package `CLAUDE.md`.
- `/specs` directory: one spec per phase, written before code. Spec → issues → sessions.
- ADR log for every settled decision. CI is the arbiter: typecheck, lint, unit, integration, e2e smoke, OPA policy tests, SBOM diff, secret scan, license scan.
- Golden tests for the generator: prompt → expected spec snapshots, so generation quality regressions are caught mechanically.

**Session roles (run in parallel)**
| Role | Cadence | Job |
|---|---|---|
| Architect | Weekly | Maintains specs, ADRs, phase acceptance criteria |
| Builders ×2–3 | Daily | One workstream each (runtime, builder, connectors…), branch-per-phase |
| Red team | Per PR batch | Security review of diffs, authz test attempts, injection cases against the sandbox |
| Docs | Per merge | README/docs/changelog kept in lockstep |
| Maintenance | Nightly | Dependency bumps, CVE triage, flaky-test quarantine |

**Throughput assumption:** one human can honestly steer 3–4 parallel Claude Code workstreams. The roadmap below is sized to that — not to a fantasy team.

**Human-only review paths:** authn/authz, sandbox boundaries, audit-log integrity, release signing. Everything else, agent-first with CI gates.

---

## 6. 12-month roadmap

### Phase 0 — Pre-flight (Weeks 1–2)
Name + trademark search + domain; Apache-2.0 + DCO; repo scaffold; root CLAUDE.md; CI skeleton; ADR log; public roadmap; GOVERNANCE.md v0; Discussions.

### Phase 1 — Core (M1–M2)
App spec schema v0; CLI + generator (Claude API-backed, spec-only — code is deterministically projected from the spec, ADR-0001) emitting spec + code + tests into Git; TypeScript runtime serving a generated app; Postgres; **OIDC from day 1** (no local-auth debt; Compose bundles Dex as preconfigured dev IdP so the quickstart survives OIDC-only, ADR-0002); Docker Compose quickstart.
**Milestone:** *zero → described app running locally in 10 minutes.*

### Phase 2 — Agents + policy + audit (M3–M4)
Agent runtime integrated; MCP client + server; A2A endpoint; OPA wired as PDP with policy-checked tool calls; hash-chained audit log v1 + SIEM export; RBAC; HITL gates.
**Milestone:** v0.3.

### Phase 3 — Enterprise identity & ops (M5–M6)
SAML + SCIM; Helm chart + HA reference; OTel; backup/restore; Vault/KMS secrets; sandbox hardening round 2; OpenSSF Best Practices badge; signed releases + SBOM + provenance.
**Milestone:** v0.5 "enterprise-ready core." Design partner program begins (regulated EU orgs). Recruit 2 external co-maintainers.
**Pre-agreed cut line if behind:** SCIM and Terraform modules slip first; SAML and Helm never do. A slip is a controlled decision made at the M5 checkpoint, not a scramble.

### Phase 4 — Compliance packs (M7–M8)
GDPR + EU AI Act packs: Rego bundles, evidence schemas, Annex IV tech-doc generator, RoPA/DPIA prefills, agent/model registry with risk classes; eval harness as CI gate; reference architectures published; **per-app identification and compliance verification** — one exportable record per generated app bundling provenance (spec hash, generation lineage, approver history), risk classification, and compliance-pack status, so an app's compliance posture is checkable at a glance rather than reconstructed by hand.
**Milestone:** v0.7. First public case study. **Showcase templates ship: the demo apps are themselves compliance tools** (DORA-style ICT register, RoPA manager, AI system inventory) — evaluators in regulated orgs get standalone value on day one, built on the platform they're evaluating.

### Phase 5 — Ecosystem (M9–M10)
Connector SDK stable + ~20 connectors; community template gallery; migration guides (Retool/n8n/Power Apps/Dify); Claude Code plugin for platform extension; **external security audit**; DORA + NIS2 packs; **showcase: a self-healing operations agent** — built entirely on the existing `propose()`/HITL primitive and audit trail (no new capability class), it triages platform issues, proposes a fix, re-verifies, then requests human approval, demonstrating governed autonomy as a real, reference-implementable capability.
**Milestone:** v0.9. Case studies #2–3. Conference talks.

### Phase 6 — v1.0 GA (M11–M12)
Air-gap installer; LTS + upgrade guarantees; SLSA L3; published benchmarks; audit findings remediated + report public; foundation/governance decision executed; v2 roadmap RFC.
**Milestone:** **v1.0 launch** — the audit report as the proof artifact.

---

## 7. Sustainability without revenue

No paywall ≠ no money needed. Three non-paywall funding paths, all consistent with the adoption goal:

1. **EU public OSS funding.** Sovereign Tech Agency funds critical open infrastructure; NLnet / NGI Zero grants fund exactly this profile: EU, open-source, privacy/compliance infrastructure.
2. **Sponsored security audit.** OSTIF or grant-funded; alternatively a design partner co-funds the audit as their contribution.
3. **GitHub Sponsors / OpenCollective** — passive, transparent, funds infra only.

**Governance:** DCO (settled), open GOVERNANCE.md from M0, maintainer ladder, 2 co-maintainers by M6 (bus factor is the #1 structural risk), foundation decision at M9–M10 — CNCF Sandbox vs Eclipse Foundation vs staying independent; decide with data at M9.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Solo-maintainer bus factor | Open governance M0; co-maintainers by M6; everything in specs/ADRs so the project is legible without the founder |
| Crowded/fatigued agent-platform space | Don't lead with "agents." Lead with zero SSO tax + Git-native apps + free compliance evidence |
| "Enterprise-ready" claim vs reality | Public honest readiness matrix; never claim ahead of status; audit report as proof |
| Big vendor ships the same free | They structurally can't un-gate SSO/compliance without destroying their tiering. The no-paywall position is defensible *because* it's unprofitable |
| Claude Code quality drift on security paths | Human-only review list (Section 5); red-team session; golden tests; eval gates in CI |
| Scope explosion (visual builder trap) | Generate-first, spec-editor UI; full canvas explicitly deferred to v2 |

---

## 9. Open decisions

1. **Name** — ✅ **RESOLVED 2026-07-06: `openRupiv`.** Domain `rupiv.ai` ✅ registered 2026-07-06. Still to do: trademark search.
2. **Scope seam** — umbrella product absorbing the agent-platform plan (recommended) vs separate repos.
3. **Ownership** — ✅ **RESOLVED 2026-07-06: personally sponsored project.** External sponsors possible later via the non-paywall funding paths in §7; sponsorship never buys decision power.
4. **Telemetry** — ✅ **RESOLVED 2026-07-06: opt-out.** Anonymous instance ping, fully documented payload, self-hostable endpoint.
5. **Visual builder depth** — v1 spec-editor (recommended) vs drag-and-drop canvas.
6. **First showcase vertical** — recommended: the compliance-tools template pack (Section 6, Phase 4); alternative: a generic CRUD/approval showcase.

---

## 10. Claude Code kickoff prompt (paste-ready)

```
You are building `openrupiv`, an Apache-2.0 open-source, enterprise-ready,
AI-native app development platform. Read /specs/phase-1.md and CLAUDE.md
fully before writing code.

Non-negotiables:
- The compliant path is the default path. Secure-by-default everywhere.
- Do not stub security or compliance controls; gate features instead.
- OIDC auth from the first commit. No local-only auth.
- The LLM generates the app *spec* only; application code is a deterministic
  projection of the spec (ADR-0001). No free-form LLM code emission.
- Apps compile to a declarative spec + generated code committed to Git.
- Every package: README + tests. CI must stay green on main.
- Stop at the end of Phase 1 acceptance criteria for human review.
  Do not proceed to Phase 2.

Deliverable for this session: repo scaffold + app spec schema v0 +
CLI skeleton with `new` and `generate` commands (LLM → spec only;
deterministic compiler → code, per ADR-0001), + Docker Compose that
brings up runtime + Postgres + Dex (dev IdP, per ADR-0002).
```

---

## 11. Settled decisions

Apache-2.0 + DCO · TypeScript-primary, Python tool sandbox · OPA/Rego as PDP · self-hosted v1, hosted multi-tenant on roadmap · evidence as byproduct · platform primitives over novel components · EU AI Act as first-class alongside GDPR/DORA/NIS2 · LLM generates spec only, code is deterministic projection (ADR-0001) · OIDC-only auth with bundled dev IdP (ADR-0002/0003) · generated apps are declarative artifacts served by the runtime engine (ADR-0004).
