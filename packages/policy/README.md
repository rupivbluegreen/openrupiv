# @openrupiv/policy

Deny-by-default policy decision point (PDP). OPA/Rego evaluated as **embedded
WASM** — in-process, no sidecar, no network hop, air-gap friendly (ADR-0006).
The runtime calls this before privileged actions (workflow transitions, and
later agent tool calls, MCP, A2A); every decision — allow and deny — carries a
reason for the audit log.

## How it works

- `policy/authz.rego` is the source policy: RBAC — allow when the subject
  holds a role the resource requires; deny otherwise; an action requiring no
  roles is open to any authenticated subject.
- `scripts/build-policy.sh` compiles it to `policy/authz.wasm` with the `opa`
  toolchain. **The `.wasm` is committed** so CI and production load it without
  needing `opa` installed (the build is byte-reproducible).
- `createPolicyEngine()` loads the committed bundle and evaluates it.
  Deny-by-default is enforced in the TypeScript wrapper, not the policy: any
  evaluation error, missing result, or non-`true` allow becomes a **deny**
  (fail-closed).

## Usage

```ts
import { createPolicyEngine } from "@openrupiv/policy";

const pdp = await createPolicyEngine();
const decision = await pdp.decide({
  subject: { id: sub, roles: ["reviewer"] },
  action: "workflow.transition:approve",
  resource: { type: "workflow.transition", allowedRoles: ["reviewer", "compliance"] },
});
// { allow: true, reason: "...", policyId: "openrupiv.authz" }
```

## Changing the policy

1. Edit `policy/authz.rego`.
2. `pnpm --filter @openrupiv/policy build:policy` (needs `opa` on PATH).
3. Commit both `authz.rego` and the regenerated `authz.wasm`.

CI runs `scripts/check-policy-wasm.sh`, which rebuilds and diffs when `opa` is
available (and skips loudly otherwise), so a stale `.wasm` is caught.

## Tests

```bash
pnpm --filter @openrupiv/policy test
```

Tests load the committed WASM and assert allow/deny across RBAC cases,
deny-by-default, the anonymous-subject block, and fail-closed on a missing
bundle.
