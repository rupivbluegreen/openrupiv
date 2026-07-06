# @openrupiv/agents

Governed agent workers -- first-class, never privileged. Every capability an
agent holds flows through the same PDP (`@openrupiv/policy`) and audit
substrate (`@openrupiv/audit`) as a human actor, plus a tool allowlist and an
isolation boundary (ADR-0007) humans don't need. Contract:
`specs/phase-2-contracts.md` §4.

## How it works

`createAgentRuntime(spec, deps)` builds an `AgentRuntime` from a spec's
`agents` tasks, a deny-by-default tool allowlist per task, a set of
`RegisteredTool`s, and the platform's policy/audit/sandbox dependencies.
`runtime.contextFor(taskName)` mints a governed `AgentContext` -- the *only*
capability surface handed to whatever drives a task run:

- `callTool(req)` enforces, in order, every step failing closed:
  1. **allowlist** -- `req.tool` must be in `task.tools`, else
     `ERR_TOOL_NOT_ALLOWED` (checked even before the tool needs to exist at
     all).
  2. **registration + schema** -- a `RegisteredTool` with that name must
     exist (`ERR_TOOL_UNKNOWN`), and `req.input` must validate against its
     `inputSchema` (JSON Schema draft 2020-12, via `ajv`) (`ERR_TOOL_INPUT`).
  3. **policy** -- `PolicyEngine.decide` with subject = the agent identity,
     action `agent.tool:<tool>`, resource
     `{ type: "agent.tool", id: "<tool>", allowedRoles: [] }`.
  4. **audit BEFORE** -- `agent.tool_call` is appended with the decision
     (`allow`/`deny`) and a sha256 digest + byte size of the *canonicalized*
     input (never the raw value). If this append itself fails, the tool is
     **not** executed -- `ERR_AUDIT_UNAVAILABLE`. A policy deny is still
     audited here, then returned as `ERR_POLICY_DENIED` (audit-then-return,
     never audit-only-on-allow).
  5. **`sandbox.execute`** -- only reached if steps 1-4 allowed.
  6. **audit AFTER** -- `agent.tool_result` records the outcome, duration,
     and an output digest + size (never the raw output). See "Best-effort
     after-audit" below for why this step's own append failure does not
     change the returned result.
- `propose(p)` is the *only* way an agent output can influence platform
  state: it inserts one row into `agent_proposals` and appends
  `agent.transition_proposed`, **in the same transaction**
  (`appendInTransaction`), fail-closed and atomic. It never writes
  `workflow_approvals` and never changes entity state -- there is no code
  path to either (see "propose() cannot reach workflow state" below).
- `finish(outcome)` marks the end of the task run: appends
  `agent.task_finished` with `outcome.reason` (and optional `outcome.detail`)
  -- **fail-closed**, and the orchestrator's responsibility to call exactly
  once regardless of how the run concluded (see "Lifecycle" below).

`runtime.listProposals({ workflow?, recordId? })` reads `agent_proposals`,
optionally filtered.

## Design notes -- places this package had to interpret the §4 contract

The contract (`specs/phase-2-contracts.md` §4) pins the TS surface and the
`callTool`/`propose` enforcement semantics precisely, but leaves a handful of
things open by construction (new dependencies since ADR-0007 hadn't landed
yet, or genuinely underspecified lifecycle boundaries). Each is a deliberate,
documented choice -- flagged here for the runtime-wiring stage to confirm,
not a silent guess.

### Why our own `Db`/`Queryable`

The contract calls `deps.db` "a structural seam" and explicitly offers two
options: define our own minimal interface matching
`packages/runtime/src/db.ts`'s `Db`/`Queryable` shape, or reuse
`Queryable`/`Txn`/`Pool`/`PoolClient` exported from `@openrupiv/audit`.

This package defines its **own** `Db`/`Queryable` (`src/types.ts`):
`query(text, params?): Promise<{rows, rowCount}>` and
`transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>`. Reasons:

- `propose()` needs to run **two** statements (the `agent_proposals` insert
  and `appendInTransaction`'s own three statements) inside one transaction
  it opens itself. `@openrupiv/audit`'s `Pool`/`PoolClient` exposes
  `connect()`/`release()`, not a `transaction(fn)` helper -- that
  convenience lives on the runtime's own `Db`, not audit's seam.
- `@openrupiv/audit`'s `Queryable` only requires `query(): Promise<{rows}>`
  (no `rowCount`). Our `Db` is a structural **superset** of that, so
  `appendInTransaction(tx, ...)` (which wants an audit `Queryable`) accepts
  our `tx` with zero cast -- verified by the type-checker, not just asserted.
- The real `packages/runtime/src/db.ts`'s `Db` (which has an extra `end()`
  we don't need) satisfies our narrower interface structurally, with zero
  import -- exactly the "structural seam" the contract asks for.

### Sandbox limits are fixed; `workspaceRoot` is configurable

`createAgentRuntime`'s `deps`, as literally specified in the §4 contract,
has no field to inject `SandboxLimits` -- only `sandbox: ToolSandbox`. Per
ADR-0007 (`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`, the sandbox's
own design document), **`DEFAULT_SANDBOX_LIMITS`** reproduces ADR-0007's
fixed defaults exactly (`wallClockMs: 30_000`, `memoryBytes: 268_435_456`
[256 MiB], `maxOutputBytes: 1_048_576` [1 MiB]) and is used for every call.
The §4 contract only requires *some* value be populated; the concrete
numbers are ADR-0007's call, not this package's, and are reproduced here
(not reinvented) because there is currently no channel to override them.

**`workspaceDir`** is `<workspaceRoot>/<uuid>` -- a fresh UUID per call, with
no real filesystem I/O in this package (ADR-0007's "`runId` handling" is
explicit that the real sandbox extracts and re-validates the final path
segment as a `runId` and owns creating/deleting the actual host directory
itself). Unlike the sandbox limits, `workspaceRoot` IS an additive,
non-breaking extension to `CreateAgentRuntimeDeps` -- `deps.workspaceRoot?:
string`, defaulting to `/workspaces` -- since a deployment may need a
different host mount point without this package needing to know why.

### Best-effort after-audit

Step 6 (`agent.tool_result`, after `sandbox.execute`) is **best-effort**: if
that append throws, the error is swallowed and the caller still gets the
real `ToolCallResult` from the sandbox. This is deliberate, not an oversight
-- the §4 contract's fail-closed language ("if this append fails the tool is
NOT executed") names only the BEFORE append in step 4. By step 6 the tool
has already run; there is no side effect left to roll back, and no
`AgentErrorCode` exists for "the tool succeeded but we couldn't log that it
did."

### Lifecycle: `agent.task_started` / `agent.task_finished`

The §4 contract lists both as audit events "owned by this package." Original
draft of this package inferred `task_finished` from a successful
`propose()` call, which left a real gap: any task run that never proposed
(a pure read/tool-invocation task, or one that errored first) got
`task_started` with no matching `task_finished` -- no one-event-per-run
guarantee. Resolved by adding an explicit `finish()` method to
`AgentContext` (a contract amendment, reflected in
`specs/phase-2-contracts.md` §4):

- **`agent.task_started`** fires from `contextFor(taskName)` itself, one per
  call. Because `contextFor` can't `await` (`contextFor(taskName):
  AgentContext`, not `Promise<AgentContext>`), this is **fire-and-forget**
  (`.catch()`-swallowed) -- there is no way to fail closed here given the
  literal signature.
- **`agent.task_finished`** fires from the explicit `AgentContext.finish(outcome)`
  method -- **fail-closed** (throws if the append fails, unlike every other
  best-effort AFTER-event in this package) and decoupled from `propose()`
  entirely. The orchestrator driving `contextFor` + a sequence of
  `callTool`/`propose` calls (open question #1 in
  `specs/phase-2-contracts.md`: "a fixed procedure," code outside this
  package) calls `finish()` exactly once when its own procedure concludes,
  passing whatever `reason` fits (success, error, no-op, etc.) -- giving
  callers a real one-task_finished-per-run guarantee instead of an
  inference tied to one particular method's success.

### Spec v0.1/v0.2 type gap

`@openrupiv/spec`'s current `AppSpec` type (and JSON Schema, `strict:
additionalProperties: false`) still carries the **reserved v0.1**
`AgentTaskDef` shape -- `{ name, description? }` only, no `tools` or
`proposes`. The §4 contract's own "Spec evolution (v0.1 → v0.2)" section
describes extending it, but that is `@openrupiv/spec`'s change to make, in
its own stage -- out of scope here (and out of scope per this package's
build instructions, which are scoped to `packages/agents/` only).

`createAgentRuntime`'s contract explicitly says it "can assume it receives
an already-validated `AppSpec`" -- i.e. once `@openrupiv/spec` lands its
v0.2 schema bump, a real `tools`/`proposes`-bearing value will structurally
satisfy this package's own (richer) `AgentTaskDef` even though today's
imported TS type doesn't expose those fields yet. `createAgentRuntime`
reads `spec.agents ?? []` and casts each entry
(`raw as unknown as AgentTaskDef`) to bridge this gap -- documented in
`src/runtime.ts` at the cast site. This is not silently unsafe: nothing
downstream trusts an absent `tools`/`proposes` as anything other than
"may call no tools" / "proposes nothing" (deny-by-default either way).

**Flagged for the wiring stage:** once `@openrupiv/spec` ships its v0.2
`agents` shape, this cast becomes unnecessary and should be removed in favor
of importing the real, richer type from `@openrupiv/spec` directly.

### Startup-time tool validation

`createAgentRuntime` now throws `AgentToolUnregisteredError` synchronously
at construction if any spec-declared task's `tools` allowlist names a tool
absent from the `tools` passed in `CreateAgentRuntimeDeps` — per
specs/phase-2-contracts.md §4's "every `tools` name must resolve to a
`RegisteredTool` at runtime startup — fail fast, typed error." Previously
this only surfaced per-call as `ERR_TOOL_UNKNOWN`.

## Dependencies

`@openrupiv/agents` depends on `@openrupiv/spec`, `@openrupiv/policy`,
`@openrupiv/audit`, and `ajv` (JSON Schema draft 2020-12 validation for
`RegisteredTool.inputSchema`, the same library and import path
`@openrupiv/spec` already uses) -- nothing else. In particular, **no
dependency on `@openrupiv/runtime`**, which is what makes "`propose()` can
never reach workflow/entity state" a fact about the dependency graph, not
just an assertion: there is no import edge by which this package's code
could construct or issue a `workflow_approvals` (or any entity-table) query
even if it wanted to. `test/dependency-graph.test.ts` checks this directly
against `package.json` and the source tree (a real `import ... from
"@openrupiv/runtime"` statement, or actual SQL naming `workflow_approvals`),
not only inferred from behavior.

## Tests

```bash
corepack pnpm --filter @openrupiv/agents typecheck
corepack pnpm --filter @openrupiv/agents test
```

No live isolation technology and no live Postgres in these unit tests, per
the contract. `test/helpers/`:

- `fakeDb.ts` -- an in-memory `Db`/`Queryable` matching the exact SQL shapes
  `runtime.ts` issues against `agent_proposals`, plus the exact
  `audit_log` SQL shapes `appendInTransaction` (`@openrupiv/audit`) issues
  -- reproduced byte-for-byte from `packages/audit/src/store.ts`, the same
  pattern `packages/runtime/test/helpers/fakeDb.ts` uses. Anything else
  throws loudly rather than silently no-op-ing.
- `fakeAuditStore.ts` -- an in-memory `AuditStore` built on `@openrupiv/audit`'s
  real, pure `appendRecord`/`verifyChain` functions, so the hash-chain
  semantics are genuine even though there's no Postgres underneath. This is
  `deps.audit` in tests; `fakeDb.ts`'s `audit_log` table is a *separate*
  store used only via `appendInTransaction` inside `propose()`'s own
  transaction -- intentionally independent, mirroring the real split
  between same-transaction and separate-connection audit appends described
  in `packages/runtime/src/audit.ts`.
- `fakeSandbox.ts` -- a fully-controlled `ToolSandbox` returning queued or
  default `ok`/`violation`/`limit`/`tool_error` results and recording every
  call, so tests can assert `workspaceDir`/`limits` were passed through
  correctly.
- `fakePolicy.ts` -- a deny-by-default `PolicyEngine` fake.

Coverage: each of the 6 `callTool` enforcement steps, in order (proving a
tool absent from the allowlist fails at step 1 even when it isn't
registered at all, etc.); a full success round-trip with both audit records
present and in order; an audit-append failure at step 4 preventing execution
(`sandbox.execute` never called); a policy deny still audited before
`ERR_POLICY_DENIED`; `propose()`'s atomicity (including rollback of BOTH the
proposal row and the audit append on failure) and that it never touches
`workflow_approvals`; `contextFor` throwing `AgentTaskNotFoundError` for an
unknown task (and working with no `agents` at all); `listProposals`
filtering by `workflow`/`recordId`, independently and together.

## Not implemented here (by contract)

- `validateSpec`'s enforcement of agent-spec shape (kebab-case names,
  `proposes` referencing an approval-gated transition, every `tools` name
  resolving to a `RegisteredTool` at startup) -- `@openrupiv/spec`'s job.
- The tool registry's provenance (where `RegisteredTool`s actually come
  from) and the concrete `ToolSandbox` implementation (ADR-0007,
  `packages/sandbox`) -- both out of scope for this package by design; it
  only consumes `RegisteredTool[]` and a `ToolSandbox` as injected deps.
- Runtime-side rejection of OIDC subs carrying the `agent:`/`a2a:` reserved
  prefix at session creation, and workflow-approval rejection of
  reserved-prefix approvers -- a runtime-wiring-stage concern. This package
  only guarantees it constructs `AgentIdentity.id` in exactly the
  `agent:<task-name>@<app-slug>` shape those checks will pattern-match on.
