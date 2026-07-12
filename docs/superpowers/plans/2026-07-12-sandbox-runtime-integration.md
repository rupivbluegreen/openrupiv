# v0.3 integration mile: wire the sandbox into the runtime end-to-end

**Goal:** an agent task runs a real Python tool inside the ADR-0007 bwrap jail,
end-to-end, in a generated app — turning Phase 2's "packages built + merged"
into a genuine v0.3 (a governed, sandboxed tool call → HITL proposal).

**Design decision (settled):** the jail has no network (`--unshare-net`), so a
tool cannot fetch from Postgres. The **trusted runtime** fetches the record and
passes its DATA as `input` to a **pure** sandboxed tool that computes a
deterministic risk verdict; the runtime proposes based on the verdict.

## Tasks (dependency order)

### Task 1 — Prerequisite: thread tool input into the jail (`packages/sandbox`)
Today `/v1/execute` parses `body.input` but never delivers it to the tool.
`server.ts`: after `createWorkspace(runId)` and before `runJail`, write
`JSON.stringify(body.input)` to `<workspaceHostPath>/input.json`. The jail
RW-binds the workspace at `/workspace` (cwd), so the tool reads `input.json`
from cwd (the `echo` fixture already does exactly this). No `jail-executor.ts`
change (avoids overlap with PR #12). Test: server test asserts `input.json` is
written with the request's input before the jail runs.

### Task 2 — New sandboxed tool `assess-vendor-risk` (`packages/sandbox/tools/`)
`tools/assess-vendor-risk/main.py`: read `input.json` (a vendor-application
record's fields), compute a **deterministic** risk verdict (e.g. based on
`amount`, `country`, missing fields), print JSON `{"risk":"low|high","score":N,
"reasons":[...]}`, exit 0. No network, no writes outside `/workspace`. Auto-copied
into the sidecar image under `/opt/sandbox-tools/assess-vendor-risk/main.py`.
The tool dir name IS the entrypoint (bare `[a-zA-Z0-9_-]+`).

### Task 3 — Runtime config: SANDBOX_URL / SANDBOX_TOKEN (`packages/runtime/src/config.ts`)
Add `sandboxUrl?`/`sandboxToken?` to `RuntimeConfig` and read `SANDBOX_URL` /
`SANDBOX_TOKEN` in `configFromEnv` (both optional — absent = agents stay off).

### Task 4 — Reshape the demo as a db-closured procedure factory (`packages/runtime/src/agent-tasks.ts`)
- Replace `READ_VENDOR_APPLICATION_TOOL` with `ASSESS_VENDOR_RISK_TOOL`
  (`name/entrypoint: "assess-vendor-risk"`, bare name; inputSchema = the record
  fields the tool reads). Drops the invalid `builtin:` entrypoint.
- `createDemoProcedures(db)` factory: `vendorRiskReview(ctx, input)` validates
  `recordId` (UUID), fetches `SELECT * FROM vendor_application WHERE id=$1` via
  the closed-over `db` (mirroring `entities.ts`'s read + `rowToRecord`), calls
  `ctx.callTool({tool:"assess-vendor-risk", input:<record fields>})`, then
  `ctx.propose(...)` iff the verdict is low-risk (else finishes `rejected`-style).
- Update the merged tests that import `DEMO_TASK_PROCEDURES` to the factory.

### Task 5 — Wire `serveAppDir` to construct `deps.agents` (`packages/runtime/src/server.ts`)
Only when `cfg.sandboxUrl` && `cfg.sandboxToken` are set (else unchanged —
graceful degradation). Build `policyEngine`+`auditStore` in `serveAppDir` (so
they can be shared), `createSidecarSandbox({baseUrl,token})`,
`createAgentRuntime(spec,{db,policy,audit,sandbox,tools:[ASSESS_VENDOR_RISK_TOOL]})`,
and pass `{db,logger,auditStore,policyEngine,agents:{runtime,procedures:createDemoProcedures(db)}}`
to `createServer`. Add `@openrupiv/sandbox` to `runtime/package.json`.

### Task 6 — CLI compose: reach the sidecar (`packages/cli/src/workspace-files.ts`)
Add to the `runtime` service `environment:` (it already joins `sandbox-internal`
and `depends_on: sandbox`): `SANDBOX_URL: http://sandbox:8443` and
`SANDBOX_TOKEN: ${SANDBOX_TOKEN:?...}`. Test asserts both present.

### Task 7 — End-to-end proof
Extend `packages/sandbox/scripts/e2e-docker.sh` (or a new script) OR a runtime
integration test to prove: input.json delivery + the `assess-vendor-risk` tool
runs in a real jail and returns a verdict. The sandbox e2e already runs real
jails on CI; add an `assess-vendor-risk` call there with a sample input asserting
the verdict shape. (The full runtime→sidecar HTTP path is unit-tested with a
fake sandbox; the real jail execution of the tool is proven by the e2e.)

## Non-goals / boundaries
- No LLM planner — `vendor-risk-review` stays a fixed deterministic procedure.
- Agents remain OFF unless `SANDBOX_URL`/`SANDBOX_TOKEN` are configured.
- Human-review path (runtime agent wiring + sandbox boundary) — draft PR, do
  not auto-merge.
