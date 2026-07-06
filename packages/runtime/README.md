# @openrupiv/runtime

Serves a compiled openRupiv app directory (ADR-0004): OIDC-authenticated
(ADR-0002/0003), Postgres-backed, with entity CRUD, server-rendered pages,
and workflow enforcement including **n-eyes (distinct-approver) approvals**.
Phase 2 wires two governance substrates through every privileged action:
the **hash-chained audit log** (`@openrupiv/audit`) and the deny-by-default
**OPA/Rego policy engine** (`@openrupiv/policy`, embedded WASM, ADR-0006).

The app directory is data — `spec.json`, `migrations/*.sql`, docs, tests.
All security-relevant behavior (auth, sessions, role guards, approvals)
lives here, exactly once, on the human-review path. A security fix ships as
a runtime upgrade; apps never need regeneration.

## Public API (specs/phase-1-contracts.md §2)

```ts
import {
  configFromEnv,   // env → RuntimeConfig (throws typed errors)
  loadAppDir,      // dir → validated AppSpec (reads spec.json)
  createServer,    // (spec, config[, deps]) → FastifyInstance (for tests)
  serveAppDir,     // migrations + infra tables, then listen
} from "@openrupiv/runtime";
```

`createServer`'s `deps` seam also accepts `auditStore` (default: a
hash-chained store over the server's `db`) and `policyEngine` (default: the
committed OPA WASM bundle via `createPolicyEngine()`).

`bin/serve.mjs <appDir>` (or `APP_DIR=…`) runs `serveAppDir(configFromEnv())`.
The runtime ships as TypeScript source in v0, so run it under `tsx`:

```sh
corepack pnpm --filter @openrupiv/runtime exec tsx bin/serve.mjs /path/to/app
```

## Configuration (environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `OIDC_ISSUER` | yes | — | Issuer URL; discovery is performed against it |
| `OIDC_CLIENT_ID` | yes | — | |
| `OIDC_CLIENT_SECRET` | yes | — | see dev-credential refusal below |
| `OIDC_ROLES_CLAIM` | no | `roles` | ID-token claim carrying the user's roles (string or string[]; use `groups` for Dex groups) |
| `SESSION_SECRET` | yes | — | **≥ 32 chars, enforced**; HMAC key for session cookies |
| `BASE_URL` | no | `http://localhost:<port>` | External URL; used for the OIDC redirect URI |
| `PORT` | no | `3000` | |
| `OPENRUPIV_DEV_MODE` | no | unset | must be exactly `true` to enable dev mode |

All configuration failures throw `RuntimeError` with code `ERR_CONFIG` and a
`details` array listing every problem.

### Dev-credential refusal (ADR-0002)

If `OIDC_CLIENT_SECRET` equals the bundled Compose/Dex dev secret
(`openrupiv-dev-secret`) and `OPENRUPIV_DEV_MODE` is not `true`, the process
**refuses to start** with `ERR_DEV_CREDENTIALS`. This is re-checked inside
`createServer`, so hand-built configs cannot bypass it.

## Authentication

- OIDC only — no password table, no local auth, no anonymous mode (ADR-0003).
- Authorization Code + PKCE via `openid-client` v6 discovery. ID-token
  validation (issuer, audience, expiry, signature via JWKS, nonce) is done by
  the library during the code exchange.
- Identity = `sub`, `email`, and roles from the configurable roles claim.
- Sessions are stateless, HMAC-SHA256-signed cookies (`openrupiv_session`):
  HttpOnly, SameSite=Lax, Path=/, `Secure` unless dev mode, 8 h expiry.
  In-flight login state (state/nonce/PKCE verifier) lives in a second signed
  cookie with a 10 minute expiry.
- Plain-`http` issuers are accepted **only** in dev mode (Dex-in-Compose).
- Every route requires a session except `/healthz` and `/auth/*`.
  Browsers get a 302 to `/auth/login?returnTo=…` (local paths only);
  API clients get `401 { "error": "ERR_UNAUTHENTICATED" }`.

## HTTP surface

| Route | Behavior |
|---|---|
| `GET /healthz` | `{ ok: true }`, unauthenticated (Compose healthcheck) |
| `GET /auth/login` | redirect to IdP (PKCE) |
| `GET /auth/callback` | code exchange → session cookie → 303 to `returnTo` |
| `POST /auth/logout` | clears the session (JSON `{ ok: true }`, or 303 for form posts) |
| `GET /api/<entity>` | list (newest first) |
| `POST /api/<entity>` | create → 201 + record (form posts 303 to the detail page) |
| `GET /api/<entity>/:id` | fetch |
| `PUT /api/<entity>/:id` | partial update of provided fields |
| `POST /api/<entity>/:id/transitions/<name>` | workflow transition (below) |
| `GET /` | index of pages |
| `GET /p/<page>` | server-rendered list / detail (`?id=`) / form page |
| `GET /admin/audit?fromSeq=&limit=&verify=` | page of the audit chain in seq order; pass `verify=full` for the overall `verify()` status (below) |
| `GET /admin/audit/export?format=jsonl\|otlp\|syslog` | SIEM export of the full chain, streamed record-by-record |
| `POST /admin/agents/:task/run`, `GET /admin/agent-proposals`, `POST /mcp`, `GET /.well-known/agent-card.json`, `POST /a2a/v1` | Phase 2 agents/MCP/A2A surfaces — not all mounted by default; see the "Agents, MCP, and A2A" section below |

Entity names map `VendorApplication` → table `vendor_application`, API path
`/api/vendor-application`; fields map `contactEmail` → `contact_email`, and
reference fields get an `_id` column suffix. No DELETE in v0.

**Workflow state fields are read-only** through create/update
(`400 ERR_STATE_FIELD_READONLY`); the server sets the initial state on
create and transitions are the only writer.

All errors are machine-readable: `{ "error": "<CODE>", "message": …,
"details"?: … }`.

## Workflow transitions and n-eyes enforcement

`POST /api/<entity>/:id/transitions/<transition>` enforces, in this order as
observed by the caller:

1. **State** — record must be in the transition's `from` state, else
   `409 { "error": "ERR_BAD_STATE" }`. A cheap pre-check runs before any PDP
   call so a bad state always outranks a forbidden role in the response; the
   row is then re-read and locked (`SELECT … FOR UPDATE`) inside the actual
   state-write transaction below, which is the race-safe, authoritative
   check.
2. **Guard roles — via the policy engine.** The runtime builds a
   `PolicyInput` from the session subject and `guard.roles` and calls
   `PolicyEngine.decide` (deny-by-default RBAC, OPA WASM). Deny →
   `403 { "error": "ERR_FORBIDDEN_ROLE" }`. Every decision — allow AND
   deny — is appended to the audit log (`policy.decision`) immediately,
   fail-closed, **before** the state-write transaction opens (see the audit
   log section below for why).
3. **Guard predicates** — evaluated inside the state-write transaction
   (they need the locked row); all `guard.require` predicates must hold,
   else `409 { "error": "ERR_GUARD_FAILED" }`.
4. **Approval rule** (if `approval { count: n }` is present, approver-role
   resolution also happens up front, same as guard roles above):
   - approver must hold one of `approval.roles` (defaults to guard roles) —
     also resolved through `PolicyEngine.decide`, decision audited;
   - one approval per `(entity_table, record_id, transition, approver_sub)`
     is recorded in `workflow_approvals`; the same user approving twice gets
     `409 { "error": "ERR_DUPLICATE_APPROVER" }` and a structured warn log
     (`workflow.duplicate_approver`). A database UNIQUE constraint backs
     this under concurrency.
   - when `COUNT(DISTINCT approver_sub)` reaches `n`, the state flips **in
     the same transaction** as the final approval.

Responses: `{ "status": "pending", "approvals": k, "required": n }` or
`{ "status": "transitioned", "state": "<to>" }`.

## Audit log (Phase 2, specs/phase-2-contracts.md §2)

`createServer`/`serveAppDir` take an optional `auditStore` dep (`ServerDeps`)
defaulting to a store backed by the server's own `db`
(`createDbAuditStore(db)` — the `@openrupiv/audit` append/read/verify
contract over the runtime's `Db` seam). Every security-relevant event is
appended to the hash-chained `audit_log` table:

| Event | When | Durability |
|---|---|---|
| `auth.login` | session issued after OIDC callback | best-effort¹ |
| `auth.logout` | session destroyed | best-effort¹ |
| `auth.session_rejected` | session cookie failed verification (protected routes only; bounded — see below) | best-effort¹ |
| `auth.dev_role_grant` | ADR-0005 dev-mode role grant fired | best-effort¹ |
| `policy.decision` | every PDP decision — allow AND deny — for a workflow guard/approval role check, or an `/admin/audit*` `audit.read` check | fail-closed, separate connection³; workflow decisions specifically are appended **before** the state-write transaction opens⁴ |
| `workflow.transition` | state flipped (guarded or final approval) | **same transaction** as the state change² |
| `workflow.approval_recorded` | non-final n-eyes approval stored | **same transaction** as the approval row² |
| `workflow.duplicate_approver` | same-sub second approval rejected (409) | separate connection, after the transaction resolves³ |
| `workflow.state_write_rejected` | create/update tried to write a state field (400) | separate connection³ |

¹ Auth events have no DB side effect to bind to: an append failure is logged
at **error** level with the full event preserved and never breaks the
request. `auth.session_rejected` additionally: never appends for public
paths (`/healthz`, `/auth/*`), and is deduped/rate-limited per rejected
cookie so one stale cookie (or a burst of them) cannot grow the log
unboundedly or monopolize the chain's append lock; the structured warn log
still fires every time regardless. The rejected cookie is also cleared in
the response so the browser stops resending it.
² Appended with `appendInTransaction(tx, …)` inside the workflow
transaction: the side effect and its audit record commit or roll back
**atomically** — if the append fails, the request 5xxs and the state change
rolls back (fail closed).
³ Events that can only be discovered inside the row-locked transaction (and
so must survive ITS OWN rollback) are appended after the transaction
resolves, on their own connection; if that append fails the request fails
closed with `ERR_AUDIT_APPEND_FAILED` (5xx). Every queued event in a batch is
still attempted even if an earlier one in the same batch failed.
⁴ Guard/approval-role PDP decisions do not depend on the row locked inside
the state-write transaction, so they are decided and durably appended
**before** that transaction opens — cause (`policy.decision`) always
precedes effect (`workflow.transition` / `workflow.approval_recorded`) in
the chain, and a decision-append failure aborts before any DB write happens
(no window where a transition commits but its authorizing decision fails to
persist afterward).

`attributes` never carry secrets or tokens (the audit package's scrubber is
defense-in-depth, not the primary control).

### Reading and exporting the chain

`GET /admin/audit` returns `{ page, records }` — a page of the chain in seq
order. Full-chain verification (`verify()` — reads and re-hashes the ENTIRE
chain) is **opt-in**, not run on every request: pass `?verify=full` to get
`{ verify: { ok, count } | { ok: false, failedSeq, reason }, page, records }`.
This keeps a routine page load cheap regardless of how large the chain has
grown; run the full verify deliberately (e.g. from a periodic job or when
investigating suspected tampering), not as the default cost of every poll.

`GET /admin/audit/export?format=jsonl|otlp|syslog` streams the full chain —
one bounded-size page read from the store at a time, one record/line written
to the response at a time — as JSON-lines, OTLP logs JSON, or RFC 5424
syslog. Memory use stays bounded regardless of chain size; it never buffers
the whole export as one string or array.

Both routes require a session AND an `audit.read` policy decision. Allowed
roles are the **platform-level** `admin` / `auditor` roles
(`AUDIT_READ_ROLES`), granted through the IdP roles claim — deliberately not
app-spec roles, so a generated app cannot grant itself audit access by
declaring its own `admin`/`auditor`-named role: any role also present in the
app spec's `roles` (including ones the ADR-0005 dev-mode grant handed out)
is excluded from the subject's effective role set before this check runs,
even though both are literal strings on the same OIDC roles claim. The
decision itself (allow and deny) is audited, fail-closed.

## Agents, MCP, and A2A (Phase 2, specs/phase-2-contracts.md §4–§6)

Phase 2 also wires three optional surfaces on top of the audit/policy
substrates above, each independently gated — see defaults below: a governed
agent-task trigger, an MCP client + server, and an A2A (agent-to-agent)
endpoint. All three build on `@openrupiv/agents` and `@openrupiv/mcp`.

### `ServerDeps` seams — what's on by default in production

`createServer`'s `deps` parameter (`ServerDeps`) gains three more optional
fields:

| Field | Purpose | Default in `serveAppDir` (production) |
|---|---|---|
| `agents` | `{ runtime: AgentRuntime; procedures: AgentTaskProcedureRegistry }` — a governed `@openrupiv/agents` runtime plus the task-procedure registry below | **absent.** `serveAppDir` only ever passes `{ db, logger }` to `createServer` — there is no production default |
| `mcpClient` | An `@openrupiv/mcp` client for consuming *external* MCP servers as connectors | built automatically from `config.mcpServersConfigPath` (`MCP_SERVERS_CONFIG` env var); **inert** (`{ servers: [] }`) if that env var is unset — no config, no outbound egress |
| `a2a` | `A2aConfig` — the registered A2A client allowlist + `agentCardRequireAuth` flag | **absent** — same as `agents` |

`agents` has no production default because no real Python tool sandbox
exists yet (`packages/sandbox`,
[ADR-0007](../../docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md), status:
proposed, human-only review path) — there is nothing honest to default
`AgentRuntime`'s `sandbox` dependency to, so the seam is left unpopulated
rather than backed by a stub. Note also that `RuntimeConfig` declares an
`a2a` shape (`clients`, `agentCardRequireAuth`) but **nothing in the runtime
reads it yet** — turning on agents or A2A today means embedding the runtime
programmatically (calling `createServer` directly with `deps.agents`/`deps.a2a`
supplied by a caller that owns a real `ToolSandbox` and a real client registry),
not setting an env var. Tests do exactly this with a fake sandbox
(`FakeToolSandbox`); production has no such fake to fall back to. Because A2A
dispatch needs a real agent runtime to run against, `deps.a2a` is only honored
when `deps.agents` is also supplied — turning on A2A alone is not possible.

### Routes

| Route | Mounted when | Behavior |
|---|---|---|
| `POST /admin/agents/:task/run` | `deps.agents` supplied | Runs a spec-declared agent task's fixed procedure (below); `202` with the procedure's outcome. Same authorization posture as `/admin/audit`: session + PDP decision (`agent.trigger`, audited allow/deny), platform-level `admin` role, app-spec roles stripped from the subject first. |
| `GET /admin/agent-proposals` | `deps.agents` supplied | Lists `agent_proposals` (optionally filtered by `?workflow=`/`?recordId=`), same authorization. |
| `POST /mcp` | **always** | MCP server surface (`@openrupiv/mcp`), JSON-RPC over Streamable HTTP (`initialize`, `tools/list`, `tools/call`; no SSE/streaming). Exposes exactly one capability today: `workflow-instance-status` (below). |
| `GET /.well-known/agent-card.json` | `deps.agents` **and** `deps.a2a` supplied (with a non-empty client registry) | A2A discovery document (name/description/version/skills/`securitySchemes`). Public by default per the A2A discovery spec; set `agentCardRequireAuth: true` in `A2aConfig` to require the same bearer as `/a2a/v1` for regulated deployments. |
| `POST /a2a/v1` | same gate as above | JSON-RPC 2.0: `SendMessage` (dispatches to a task procedure, same registry as the admin trigger route) and `GetTask` (looks up a prior result by id, scoped to the calling client). Requires an `A2A-Version: 1.0` header. |

`POST /mcp` is the one surface mounted unconditionally — its one capability
doesn't touch the agent sandbox at all, so there is no missing dependency to
gate it on.

### Interim, PROPOSED bearer-verification choices (flagged for maintainer sign-off)

Both new inbound surfaces need *some* bearer-token verification today, and
neither gets a full third-party OAuth implementation in this wiring stage.
Both choices are isolated behind a single `verifyToken`-shaped function
each, so swapping in real OIDC/OAuth verification later is a localized
change — but until a maintainer signs off, treat both as interim, same
spirit as `specs/phase-2-contracts.md`'s "Open questions" section: defaults
chosen so implementation isn't blocked, not silently final.

1. **MCP inbound (`POST /mcp`)** reuses the platform's own signed
   session-cookie format as the bearer credential, verified via the
   existing `verifyPayload`/session-secret path (`session.ts`) — **not**
   third-party OIDC access-token introspection/JWKS verification against an
   arbitrary token. Building real OAuth 2.1 resource-server semantics for
   arbitrary external tokens is materially larger scope than this wiring
   stage and would duplicate already-hardened code; this keeps every MCP
   caller's identity flowing through the one reviewed
   identity-verification path.
2. **A2A inbound (`POST /a2a/v1`)** is a shared-secret lookup: each
   configured `A2aClientEntry` names an env var holding its bearer secret
   (mirroring `@openrupiv/mcp`'s transport `tokenEnv` pattern — the secret
   value never appears in config), compared in constant time
   (`timingSafeEqual`). This is **not** the OAuth client-credentials grant
   `specs/phase-2-contracts.md` §6's open question 11 describes;
   implementing a real token endpoint is out of scope here.

### `src/auth.ts` — three touches on this wiring, all human-review-required

`src/auth.ts` is on the human-review-required path (CLAUDE.md:
authentication/authorization). This wiring touched it three times:

1. **Reserved-identity-prefix rejection** (planned): `GET /auth/callback`
   now rejects any OIDC `sub` carrying a reserved `agent:`/`a2a:` prefix
   (`401 ERR_RESERVED_IDENTITY_PREFIX`), so a human OIDC login can never
   collide with a machine identity minted by the agent/A2A surfaces.
2. **`/mcp` cookie-gate exemption** (an unplanned discovery, made while
   building the MCP route): the global session-cookie gate (the `onRequest`
   hook) was blocking `POST /mcp` outright, because MCP callers
   authenticate via bearer token, not a browser session cookie. Fixed with
   a narrow, exact-match addition to `isPublicPath`: `pathname === "/mcp"`.
   This does **not** create an anonymous route — `/mcp` still
   independently and unconditionally requires its own valid bearer token
   (`registerMcpServer`'s `verifyToken`), 401ing exactly as before; it only
   stops *also* demanding a cookie that an MCP caller, never being a
   browser, could never present.
3. **`/a2a/v1` and `/.well-known/agent-card.json` cookie-gate exemption**
   (same pattern, extended for A2A): identical reasoning and the identical
   "still independently gated" property — `/a2a/v1` requires its own
   per-client shared-secret bearer; the agent-card route is deliberately
   public discovery metadata unless `agentCardRequireAuth` is set, in which
   case `a2a.ts` itself — never this cookie check — enforces it.

All three changes were independently code-traced by task reviewers and
confirmed to introduce no anonymous-access path. They are called out here
explicitly because `auth.ts` is a human-only review path — flag all three
for maintainer sign-off alongside the two bearer-verification choices above,
not as already-settled.

### The task-procedure registry (`src/agent-tasks.ts`)

Agent tasks run a fixed, deterministic *procedure* — not an LLM planning
loop (`specs/phase-2-contracts.md` §4, open question 1: "the decision loop
is deterministic-script-only"). `AgentTaskProcedureRegistry` is a hardcoded,
ship-time-fixed `Record<taskName, AgentTaskProcedure>`, mirroring the
existing `RegisteredTool[]` static registry pattern. A procedure receives
`(ctx: AgentContext, input)` and returns an `AgentTaskOutcome`; it drives
zero or more `ctx.callTool`/`ctx.propose` calls but never calls
`ctx.finish` itself — the caller (the admin trigger route or the A2A
dispatcher) does that once the procedure returns, so both callers observe
identical lifecycle semantics.

The one shipped demo task, `vendor-risk-review`: reads a `VendorApplication`
record through the sandboxed, read-only `read-vendor-application` tool,
then unconditionally proposes the `approve` transition on the
`vendor-approval` workflow via `ctx.propose(...)` — a fixed procedure, not a
risk model. It exists to exercise the full path end-to-end (see
`test/agent-approval-e2e.test.ts`), not as a real risk-review
implementation.

### A known, existing authorization characteristic: no row-level scoping on `workflow-instance-status`

The one MCP-exposed capability, `workflow-instance-status`
(`src/mcp-capabilities.ts`), has no row-level/ownership scoping: any
authenticated subject who passes the capability's policy check (currently
`allowedRoles: []`, which the OPA policy resolves to "no roles required;
authenticated subject permitted") can read any workflow-tracked entity's
status by table + id. This was checked against the platform's **existing**
`GET /api/<entity>/:id` route (`entities.ts`) and found to be exactly
consistent with it — `registerEntityRoutes` has no policy-engine dependency
at all, and the whole v0.2 platform's authorization model gates workflow
*transitions* via RBAC, not entity *reads*. This is an intentional,
pre-existing platform characteristic, not a new gap introduced by MCP —
documented here so a reader auditing MCP exposure doesn't have to trace the
code themselves to learn it.

## Migrations

At startup `serveAppDir`:

1. creates infra tables idempotently (`_migrations`, `workflow_approvals`,
   `audit_log`, `pgcrypto` extension);
2. applies `migrations/*.sql` sorted ascending by filename, each in its own
   transaction, recording each in `_migrations` and skipping already-applied
   files. Forward-only; a failing migration rolls back and aborts startup
   with `ERR_MIGRATION_FAILED`.

## Logging

Structured JSON to stdout, one object per line (`level`, `time`, `msg`,
event fields). Every field passes a redaction helper that replaces values
under keys matching tokens/secrets/passwords/cookies/authorization/… with
`[REDACTED]` — tested. Request logs never include query strings (OAuth codes
travel there) or headers.

## Docker

`packages/runtime/Dockerfile` — build context is the **monorepo root** (the
image needs `packages/spec` too):

```sh
docker build -f packages/runtime/Dockerfile -t openrupiv-runtime .
```

Compose usage (the workspace `docker-compose.yaml` emitted by
`openrupiv new` wires this up):

```yaml
services:
  runtime:
    build:
      context: <monorepo root>
      dockerfile: packages/runtime/Dockerfile
    environment:
      APP_DIR: /app-dir
      DATABASE_URL: postgres://openrupiv:openrupiv@postgres:5432/openrupiv
      OIDC_ISSUER: http://dex:5556
      OIDC_CLIENT_ID: openrupiv-local
      OIDC_CLIENT_SECRET: openrupiv-dev-secret   # DEV ONLY (ADR-0002)
      OPENRUPIV_DEV_MODE: "true"                 # required for the dev secret
      SESSION_SECRET: ${SESSION_SECRET}           # generated into .env
    volumes:
      - ./app:/app-dir:ro
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
      dex: { condition: service_started }
```

To point at a real IdP: drop the `dex` service, set `OIDC_ISSUER` /
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` to your provider's values, remove
`OPENRUPIV_DEV_MODE`, and serve over HTTPS (cookies are `Secure` outside dev
mode). That is the entire production migration.

## Testing

```sh
corepack pnpm --filter @openrupiv/runtime test
```

Unit tests need **no live Postgres and no live IdP**: the db layer is a
narrow `Queryable`/`Db` interface with an in-memory fake injected in tests
(rollback semantics included, so the n-eyes atomicity guarantee is honestly
exercised), and the OIDC callback flow is tested against an offline fake IdP
that signs real RS256 ID tokens which `openid-client` fully validates.
Live-stack behavior is covered by the Compose e2e stage.

## Security notes for reviewers

Human review required (CLAUDE.md) for: `src/auth.ts` (OIDC + session gate,
auth audit events, the two `isPublicPath` exemptions above), `src/session.ts`
(cookie signing/verification), `src/config.ts` (dev-credential refusal,
secret length), `src/workflows.ts` (n-eyes enforcement, PDP wiring,
transactional audit appends), `src/admin.ts` (audit-read authorization),
`src/audit.ts` (append fail-closed/best-effort posture). Phase 2's
agents/MCP/A2A wiring adds three more files to this list: `src/admin-agents.ts`
(agent-trigger/proposal-listing authorization), `src/a2a.ts` (A2A inbound
shared-secret bearer verification — interim, PROPOSED, see above), and the
`verifyToken` callback in `src/server.ts` (MCP inbound session-token bearer
verification — interim, PROPOSED, see above). CSRF posture in v0:
`SameSite=Lax` cookies block cross-site form POSTs; state-changing endpoints
are cookie-authenticated only.
