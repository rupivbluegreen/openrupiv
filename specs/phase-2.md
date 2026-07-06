# Phase 2 spec — Agents + policy + audit (M3–M4)

> Contract for Phase 2 builder sessions. Read `CLAUDE.md`, `PLAN.md`, and the
> Phase 1 packages first. Phase 1 (spec/compiler/runtime/generator/cli) is
> the substrate; Phase 2 adds governance and agents on top of it. Stop at the
> acceptance criteria for human review; the audit-log integrity and
> agent-sandbox paths are human-only review paths (CLAUDE.md).

## Goal

**Every security-relevant thing that happens is tamper-evidently recorded,
policy-checked, and — where a human must decide — gated.** Then: agents
become first-class governed workers that operate through those same controls.

The Phase 2 demo extends the vendor-onboarding app: an approval that an agent
*proposes* but a human *approves*, with the whole chain — proposal, policy
decision, human gate, final approval — emitted as a verifiable audit trail
and exportable to a SIEM.

## Scope

### In

1. **Audit log** (`packages/audit`) — hash-chained, tamper-evident, append
   only; SIEM export (OTLP/JSON lines + syslog). **Foundational — build
   first.**
2. **Policy engine** (`packages/policy`) — OPA/Rego as the PDP; a typed
   decision API the runtime calls before privileged actions; policy bundles
   versioned and testable.
3. **RBAC** (formalized in `packages/runtime` + `packages/spec`) — roles →
   permissions, evaluated through the policy engine, replacing the ad-hoc
   role checks in workflow guards.
4. **Agent runtime** (`packages/agents`) — governed agent workers: per-agent
   identity, a Python tool sandbox, policy-checked tool calls, and
   human-in-the-loop (HITL) approval gates. Absorbs the prior `agentforge`
   design.
5. **MCP** (`packages/mcp`) — MCP client (consume external MCP servers as
   connectors) and MCP server (expose the platform's own capabilities), both
   policy-gated and audited.
6. **A2A endpoint** — agent-to-agent protocol surface on the runtime, behind
   identity + policy + audit.

### Out (deferred to Phase 3+)

SAML/SCIM, Helm/HA, external secrets, OTel traces, connectors beyond MCP,
compliance document generators (Annex IV/RoPA — Phase 4), air-gap.

### Spec schema evolution (v0.1 → v0.2)

Phase 1 reserved `policies`, `agents`, `evidence` and the compiler rejected
them. Phase 2 turns them on, one at a time, each behind a schema version
bump and golden-corpus coverage:

- `policies` — named Rego bundles + the resources/actions they govern.
- `agents` — agent task definitions: identity, allowed tools, HITL gates,
  the workflow transitions they may propose (never directly fire a
  human-gated transition).
- `evidence` — evidence hooks: which runtime events feed which compliance
  artifact (the generators themselves are Phase 4; Phase 2 defines the hook
  shape and starts emitting the events).

Compiler + runtime must still reject any spec section not yet implemented
with a typed `ERR_UNSUPPORTED_SECTION` — the "no silent no-op" rule holds
through the transition.

## Build order

audit → policy → RBAC (runtime wiring) → agents → mcp → a2a. Audit is the
substrate everything else records into; policy is the substrate everything
else checks against. Neither depends on agents, so both can land and be
merged before the agent runtime starts.

## Non-negotiables specific to Phase 2

- **The audit log is append-only and tamper-evident.** Each record chains to
  the prior via a hash; the chain is verifiable; there is no update or delete
  path in the API or the schema. Verification detects insertion, deletion,
  reordering, and mutation.
- **No privileged action without a policy decision.** Workflow transitions,
  agent tool calls, MCP calls, and A2A calls all pass through the PDP; a
  "deny by default" posture; every decision (allow AND deny) is audited.
- **Agents never bypass human gates.** An agent may *propose* a
  human-gated transition (recorded as a proposal); only a human identity can
  satisfy the HITL gate. The 4-eyes distinct-approver rule counts agent
  proposals as zero human approvals.
- **The Python tool sandbox is a real isolation boundary** (human-only review
  path). No network by default; resource limits; no host filesystem access
  beyond an explicit workspace; every tool call policy-checked and audited.

## Acceptance criteria (human review gate)

1. Audit log: appending N records then verifying the chain passes; any
   tamper (edit/delete/reorder/insert) is detected by verification with a
   precise failure location. SIEM export produces valid OTLP/JSON.
2. Every Phase 1 security event (auth login/logout, session rejection,
   workflow transition, approval, duplicate-approver rejection, state-write
   rejection) is now also written to the audit log, chained.
3. Policy engine: a Rego bundle governing the `approve` transition is
   evaluated as the PDP; a policy denial blocks the transition and is
   audited; policy bundles have their own tests.
4. RBAC: workflow guard role checks now resolve through roles→permissions in
   the policy engine; the Phase 1 e2e flow still passes unchanged.
5. Agent runtime: an agent proposes a vendor approval; the proposal is
   policy-checked, audited, and requires a human to satisfy the HITL gate;
   an agent proposal never counts toward the 4-eyes distinct-approver
   requirement (test proves it).
6. MCP: the platform consumes at least one external MCP server as a
   connector (policy-checked, audited) and exposes at least one capability
   as an MCP server.
7. Sandbox: a tool attempting network egress or host FS access outside its
   workspace is blocked and audited.
8. Every package: README + tests; `pnpm typecheck && lint && test` green;
   CI green; ENTERPRISE_READINESS.md updated to real status.
9. Audit-log integrity and sandbox boundary reviewed by a human maintainer.

## Risks specific to this phase

- **OPA integration weight** — running OPA as a sidecar vs embedding via
  WASM. Decide in an ADR; the runtime must not hard-require a network hop for
  every decision (latency + air-gap). Prefer embedded/WASM policy evaluation
  with the bundle shipped in-process.
- **Sandbox is the highest-risk surface in the whole project.** Budget real
  time; treat every escape as a release blocker; this is where the external
  audit (Phase 5) will look hardest.
- **Audit-log performance** — hash-chaining serializes writes. Design for
  batched/segmented chains if throughput demands, but correctness of the
  chain is never traded for speed.
