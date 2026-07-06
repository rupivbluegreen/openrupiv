# 0006 — Policy engine: OPA/Rego evaluated as embedded WASM, bundles pre-compiled and committed

- Status: accepted
- Date: 2026-07-06

## Context

PLAN.md commits to "OPA/Rego as the PDP" and to the platform working
air-gapped. Phase 2 needs a policy decision point the runtime calls before
privileged actions (workflow transitions, agent tool calls, MCP/A2A). Two
integration shapes exist:

1. **OPA as a sidecar** — the runtime makes a network call per decision.
   Simple to wire, but adds a network hop to every guarded action (latency,
   a new failure mode) and complicates air-gapped and single-binary
   deployment. A per-decision network dependency in the hot path is exactly
   the kind of thing regulated on-prem evaluators push back on.
2. **OPA embedded via WASM** — Rego policies are compiled to a `.wasm`
   module and evaluated in-process with `@open-policy-agent/opa-wasm`. No
   sidecar, no network hop, air-gap-friendly.

A wrinkle: compiling Rego to WASM needs the `opa` toolchain, which is **not**
present in every build/CI environment (confirmed absent here). Compiling at
runtime or in CI would make the toolchain a hard dependency of the build.

## Decision

- **Embed OPA via WASM; no sidecar in the hot path.** The runtime evaluates
  policy in-process against a compiled Rego module.
- **Rego source lives in the repo; compiled `.wasm` artifacts are committed
  alongside it.** A `scripts/build-policies.sh` (uses the `opa` CLI)
  recompiles them; a CI job verifies the committed `.wasm` matches the `.rego`
  source (rebuild-and-diff) *when* the toolchain is available, and is skipped
  with a loud notice otherwise — so the committed artifact is never silently
  stale, and CI stays hermetic (it loads the committed WASM, it does not
  compile).
- The `PolicyEngine` interface (`specs/phase-2-contracts.md`) is the stable
  seam. The WASM-backed implementation is the production one; tests exercise
  it against the committed bundle. Deny-by-default is enforced in the engine
  wrapper, not left to policy authors.

## Consequences

- No runtime network dependency for authorization; works air-gapped and in a
  single container.
- The build has an *optional* `opa` dependency (only to regenerate bundles),
  not a required one. Contributors touching `.rego` must run
  `scripts/build-policies.sh` and commit the `.wasm`; the diff-check catches
  omissions where the toolchain exists.
- Real Rego, real OPA evaluator — consistent with "platform primitives over
  novel components." We do not ship a bespoke policy language.
- This ADR blocks the policy build stage (task #11) from starting until the
  `opa` toolchain is available in the build environment to produce the first
  genuine committed bundle. Shipping a hand-written or empty `.wasm` to
  "unblock" would violate the no-stub rule and is explicitly disallowed.
