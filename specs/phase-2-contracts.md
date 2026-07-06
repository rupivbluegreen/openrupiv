# Phase 2 — cross-package contracts

> Binding interface contracts for Phase 2 packages, built in dependency
> order. Same rules as `specs/phase-1-contracts.md`: implement your side
> exactly; consume others as written; changing this file means stopping and
> flagging. Audit-log integrity and the agent sandbox are human-only review
> paths (CLAUDE.md).

## 1. `@openrupiv/audit` — hash-chained tamper-evident audit log

The substrate every other Phase 2 component records into. Append-only. No
update or delete exists anywhere in the API, schema, or SQL.

```ts
export interface AuditRecordInput {
  /** Dotted event name, e.g. "auth.login", "workflow.transition". */
  event: string;
  /** Actor identity: OIDC sub, agent id, or "system". */
  actor: string;
  actorType: "human" | "agent" | "system";
  /** Optional subject the event acts on, e.g. "vendor_application:<uuid>". */
  subject?: string;
  /** Decision context when this records a policy-gated action. */
  decision?: "allow" | "deny";
  /** Arbitrary structured detail; MUST NOT contain secrets/tokens. */
  attributes?: Record<string, unknown>;
}

export interface AuditRecord extends AuditRecordInput {
  /** Monotonic 1-based sequence within the chain. */
  seq: number;
  /** RFC3339 UTC timestamp (injected, never read from wall clock in pure code). */
  timestamp: string;
  /** sha256 of the previous record's hash + this record's canonical body. */
  hash: string;
  /** Previous record's hash; genesis uses GENESIS_HASH. */
  prevHash: string;
}

export const GENESIS_HASH: string; // 64 zeros

/** Canonical serialization used for hashing — stable key order, no whitespace. */
export function canonicalize(record: Omit<AuditRecord, "hash">): string;
export function hashRecord(prevHash: string, body: Omit<AuditRecord, "hash" | "prevHash">): string;

/** Pure chain builder: fold inputs into a verifiable chain given a clock. */
export function appendRecord(
  prev: AuditRecord | null,
  input: AuditRecordInput,
  timestamp: string,
): AuditRecord;

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; failedSeq: number; reason: "hash_mismatch" | "chain_break" | "seq_gap" | "bad_genesis" };

/** Verify a full chain: recompute every hash, check linkage, seq monotonicity. */
export function verifyChain(records: AuditRecord[]): VerifyResult;

/** Postgres-backed append-only store (used by the runtime). */
export interface AuditStore {
  append(input: AuditRecordInput): Promise<AuditRecord>;
  /** Read a page in seq order (for verification/export). No mutation methods exist. */
  read(opts?: { fromSeq?: number; limit?: number }): Promise<AuditRecord[]>;
  verify(): Promise<VerifyResult>;
}
export function createAuditStore(db: Queryable, opts?: { clock?: () => string }): AuditStore;

/** SIEM export. */
export function toOtlpLogRecords(records: AuditRecord[]): unknown; // OTLP logs JSON structure
export function toSyslog(records: AuditRecord[]): string[];        // RFC 5424 lines
export function toJsonl(records: AuditRecord[]): string;           // one JSON object per line
```

- The pure functions (`appendRecord`, `verifyChain`, `hashRecord`,
  `canonicalize`, exporters) take no clock/IO and are exhaustively unit
  tested including every tamper mode (mutate a field, drop a record, reorder,
  insert, forge genesis).
- SQL: table `audit_log(seq bigserial primary key, timestamp timestamptz not
  null, event text not null, actor text not null, actor_type text not null,
  subject text, decision text, attributes jsonb not null default '{}',
  prev_hash char(64) not null, hash char(64) not null unique)`. Append uses a
  transaction that locks the last row (`SELECT ... ORDER BY seq DESC LIMIT 1
  FOR UPDATE`) so concurrent appends can't fork the chain. Migration ships in
  the package and is applied by the runtime's infra-table step.
- `attributes` redaction is the caller's responsibility, but `append` runs a
  defense-in-depth scrubber that drops keys named like secrets
  (`/pass|secret|token|authorization|cookie|key/i`) and logs a warning; unit
  tested.

## 2. Runtime wiring (`@openrupiv/runtime`)

> **Status:** the audit table is provisioned (`AUDIT_LOG_DDL` added to
> `INFRA_STATEMENTS`, applied at startup) and `appendInTransaction(tx, input)`
> exists for same-transaction appends. The event-append wiring below is the
> next step — deliberately NOT done in the same session as the Phase 1
> security review, since it edits the human-only-review files
> (`workflows.ts`, `server.ts`, `auth.ts`) and should get a fresh, careful
> pass. Committing events use `appendInTransaction(tx, …)` inside the existing
> workflow transaction (atomic with the side effect); rejection events that
> roll back (`workflow.duplicate_approver`, `workflow.state_write_rejected`)
> and non-transactional auth events use a separate `createAuditStore(pool)`
> connection so they persist independently. The `/admin/audit` read/verify
> route can query the table directly and fold with `verifyChain`.


- `createServer`/`serveAppDir` gain an optional `auditStore` dep (default:
  `createAuditStore(db)`); when present, these events append to it in the
  SAME transaction as their side effect where one exists (workflow
  transitions, approvals), or best-effort with an error log where none does
  (auth login/logout/session-reject):
  `auth.login`, `auth.logout`, `auth.session_rejected`,
  `auth.dev_role_grant`, `workflow.transition`, `workflow.approval_recorded`,
  `workflow.duplicate_approver`, `workflow.state_write_rejected`.
- New route `GET /admin/audit` (authenticated; requires the `audit.read`
  permission once RBAC lands): returns a verified page of the chain +
  overall `verify()` status. New `GET /admin/audit/export?format=jsonl|otlp|syslog`.
- Appending to the audit log must never silently fail: if the append errors,
  the request fails closed (5xx) for transactional events; for
  best-effort auth events it logs at error level with the event preserved.

## 3. `@openrupiv/policy` — PDP (BUILT)

Deny-by-default decision API the runtime calls before privileged actions.
OPA/Rego evaluated as embedded WASM (ADR-0006). The Rego source
(`policy/authz.rego`) is compiled to a committed `policy/authz.wasm`
(byte-reproducible with the pinned `opa` version; CI rebuilds-and-diffs).

```ts
export interface PolicySubject { id: string; roles: string[]; }
export interface PolicyResource { type: string; id?: string; allowedRoles: string[]; }
export interface PolicyInput { subject: PolicySubject; action: string; resource: PolicyResource; context?: Record<string, unknown>; }
export interface PolicyDecision { allow: boolean; reason: string; policyId: string; }
export interface PolicyEngine { decide(input: PolicyInput): Promise<PolicyDecision>; }
export function createPolicyEngine(opts?: { wasmPath?: string }): Promise<PolicyEngine>;
```

- v0.2 policy is RBAC: allow when the subject holds a role in
  `resource.allowedRoles`; an empty `allowedRoles` permits any authenticated
  subject (non-empty `subject.id`); everything else denies.
- Deny-by-default is enforced in the TS wrapper: any evaluation error,
  missing result, or non-`true` allow → deny (fail-closed).

### RBAC wiring into the runtime (NEXT)

Replace the ad-hoc role checks in `workflows.ts` guard/approval steps with a
`PolicyEngine.decide` call: build the `PolicyInput` from the session subject
and the transition's guard/approval roles (`allowedRoles`), deny → 403, and
audit every decision. The Phase 1 e2e flow must pass unchanged. This edits a
human-review-path file; the maintainer signed off on `workflows.ts`
(2026-07-06), so the wiring may proceed with the usual test + e2e rigor.

## 4. `@openrupiv/agents` — governed agent workers

Agents are first-class governed workers, never privileged ones: every
capability an agent holds flows through the same PDP and audit substrate as
a human actor, plus a tool allowlist and an isolation boundary humans don't
need. The concrete sandbox isolation technology is decided in **ADR-0007
(in progress this session)** — this contract binds the *semantics* the
implementation must satisfy; the interfaces below do not change when
ADR-0007 lands. The sandbox is a human-only review path (CLAUDE.md).

```ts
/** Agent identity — a distinct namespace from human OIDC subs by construction. */
export interface AgentIdentity {
  /**
   * Always `agent:<task-name>@<app-slug>`. The `agent:` prefix (and `a2a:`,
   * §6) is reserved: the runtime rejects any OIDC sub carrying a reserved
   * prefix at session creation, so the namespaces cannot collide.
   */
  id: string;
  /** v0.2: always [] — the tool allowlist is the sole capability grant. */
  roles: string[];
}

/**
 * Spec v0.2 `agents` entry — extends the reserved v0.1 shape in
 * `@openrupiv/spec` behind the schema version bump (specs/phase-2.md).
 */
export interface AgentTaskDef {
  /** kebab-case, unique across `agents`. */
  name: string;
  description?: string;
  /** Tool allowlist. Deny-by-default: absent/empty = the task may call NO tools. */
  tools?: string[];
  /** Human-gated transitions this agent may PROPOSE. Agents never fire transitions. */
  proposes?: { workflow: string; transition: string }[];
}

export interface ToolCallRequest {
  tool: string;
  input: Record<string, unknown>;
}

export type AgentErrorCode =
  | "ERR_TOOL_NOT_ALLOWED"    // not on the task's `tools` allowlist
  | "ERR_TOOL_UNKNOWN"        // allowlisted but no registered implementation
  | "ERR_TOOL_INPUT"          // input fails the tool's inputSchema
  | "ERR_POLICY_DENIED"       // PDP denied (audited, like every decision)
  | "ERR_SANDBOX_VIOLATION"   // attempted egress / FS escape — blocked + audited
  | "ERR_SANDBOX_LIMIT"       // wall-clock / memory / output-size limit hit
  | "ERR_TOOL_FAILED"         // tool executed and failed
  | "ERR_AUDIT_UNAVAILABLE";  // audit append failed → the call is NOT executed

export type ToolCallResult =
  | { ok: true; output: unknown }
  | { ok: false; code: AgentErrorCode; message: string };

export interface AgentProposal {
  id: string;          // uuid
  agentId: string;     // AgentIdentity["id"]
  entityTable: string; // snake_case table, same convention as workflow_approvals
  recordId: string;
  workflow: string;
  transition: string;
  rationale: string;
  createdAt: string;   // RFC3339 UTC (injected clock, as in @openrupiv/audit)
}

/**
 * The ONLY capability surface handed to whatever drives an agent task run.
 * There is deliberately no other path from agent-side code to platform state.
 */
export interface AgentContext {
  identity: AgentIdentity;
  task: AgentTaskDef;
  callTool(req: ToolCallRequest): Promise<ToolCallResult>;
  propose(
    p: Omit<AgentProposal, "id" | "agentId" | "createdAt">,
  ): Promise<AgentProposal>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) for `input`; validated before the sandbox runs. */
  inputSchema: Record<string, unknown>;
  /** Opaque handle the sandbox uses to locate the tool implementation. */
  entrypoint: string;
}

export interface AgentRuntime {
  /** Governed context for one run of a spec-declared task; throws on unknown task. */
  contextFor(taskName: string): AgentContext;
  listProposals(opts?: {
    workflow?: string;
    recordId?: string;
  }): Promise<AgentProposal[]>;
}

export function createAgentRuntime(
  spec: AppSpec,
  deps: {
    db: Db;                  // structural seam, same shape as the runtime's Db
    policy: PolicyEngine;    // @openrupiv/policy
    audit: AuditStore;       // @openrupiv/audit
    sandbox: ToolSandbox;
    tools: RegisteredTool[];
    clock?: () => string;
  },
): AgentRuntime;

/** Limits are REQUIRED — no defaults in this contract (values fixed in ADR-0007). */
export interface SandboxLimits {
  wallClockMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
}

export interface SandboxExecuteInput {
  tool: RegisteredTool;
  input: Record<string, unknown>;
  /** Absolute host path of the per-run workspace — the ONLY host state visible inside. */
  workspaceDir: string;
  limits: SandboxLimits;
}

export type SandboxExecuteResult =
  | { ok: true; output: unknown; durationMs: number }
  | {
      ok: false;
      reason: "violation";
      violation: "network_egress" | "fs_escape";
      message: string;
      durationMs: number;
    }
  | {
      ok: false;
      reason: "limit";
      limit: "wall_clock" | "memory" | "output_size";
      message: string;
      durationMs: number;
    }
  | { ok: false; reason: "tool_error"; message: string; durationMs: number };

/**
 * Technology-agnostic isolation boundary (human-only review path). The
 * concrete mechanism — container, microVM, restricted subprocess, … — is
 * decided in ADR-0007; implementations MUST satisfy the workspace, egress,
 * and limit semantics below without this interface changing.
 */
export interface ToolSandbox {
  execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}
```

- **Enforcement order in `callTool`** — each step fails closed, mirroring
  `workflows.ts`: (1) `task.tools` allowlist → `ERR_TOOL_NOT_ALLOWED`;
  (2) a `RegisteredTool` exists → `ERR_TOOL_UNKNOWN`; input validates
  against its `inputSchema` → `ERR_TOOL_INPUT`; (3) `PolicyEngine.decide`
  with subject = the agent identity, action `agent.tool:<tool>`, resource
  `{ type: "agent.tool", id: "<tool>", allowedRoles: [] }`, context
  `{ task: task.name }` — deny → `ERR_POLICY_DENIED`; (4) audit
  `agent.tool_call` BEFORE execution (actor = agent id, actorType `"agent"`,
  `decision` allow|deny, attributes carry task, tool, and a sha256 digest +
  byte size of the canonicalized input — never the raw input); if this
  append fails the tool is NOT executed → `ERR_AUDIT_UNAVAILABLE`;
  (5) `sandbox.execute`; (6) audit `agent.tool_result` AFTER (outcome,
  `durationMs`, output digest + size). A policy deny is still audited as
  `agent.tool_call` with `decision: "deny"`; nothing executes.
- **Audit events owned here:** `agent.task_started`, `agent.task_finished`,
  `agent.tool_call`, `agent.tool_result`, `agent.transition_proposed` — all
  with actorType `"agent"` and the agent id as actor.
- **HITL / 4-eyes:** `propose()` inserts into `agent_proposals` and audits
  `agent.transition_proposed` in the same transaction (via
  `appendInTransaction`). It never writes `workflow_approvals` and never
  changes entity state. Only a human identity satisfies a HITL gate; an
  agent proposal counts as ZERO approvals toward the n-eyes
  distinct-approver count — a test proves that a proposal plus n−1 human
  approvals does NOT transition. Defense-in-depth: the workflow approval
  path rejects any approver whose identity carries a reserved prefix
  (`agent:`, `a2a:`), and session creation rejects OIDC subs with reserved
  prefixes.
- **Spec evolution (v0.1 → v0.2):** `specVersion` becomes `"0.1" | "0.2"`;
  a non-empty `agents` array requires `"0.2"`. `validateSpec` enforces:
  names unique + kebab-case; every `proposes` entry references an existing
  workflow + transition; the referenced transition MUST carry an approval
  rule (proposing an ungated transition is a validation error — whether
  agents may ever *fire* ungated transitions is an open product question;
  the v0.2 answer is no). Every `tools` name must resolve to a
  `RegisteredTool` at runtime startup — fail fast, typed error. `policies`
  and `evidence` remain rejected with `ERR_UNSUPPORTED_SECTION` at BOTH
  versions until their own stages — the no-silent-no-op rule holds. The
  generator golden corpus gains ≥ 2 entries whose specs declare `agents`.
- **Workspace contract:** one fresh, empty, per-run directory; the sandbox
  reads/writes only inside it; deleted (best-effort, logged) after the run.
  No network egress at all in v0.2 — not configurable. An attempted egress
  or FS escape is blocked, returned as `reason: "violation"`, and audited
  (acceptance criterion 7).
- **SQL:** `agent_proposals(id uuid primary key default gen_random_uuid(),
  agent_id text not null, entity_table text not null, record_id uuid not
  null, workflow text not null, transition text not null, rationale text
  not null, created_at timestamptz not null default now())` — provisioned
  by the runtime's infra-table step like `workflow_approvals`.
- **Dependencies:** `@openrupiv/agents` depends on `@openrupiv/spec`,
  `@openrupiv/policy`, `@openrupiv/audit` only; the `Db` seam is structural
  (same shape as the runtime's) so the runtime can depend on this package
  without a cycle. Unit tests inject a fake `ToolSandbox`, fake policy, and
  in-memory audit — no live isolation technology in unit tests (that is the
  Compose e2e stage, post-ADR-0007).

## 5. `@openrupiv/mcp` — MCP client + MCP server

Both directions speak **MCP revision `2025-11-25`** (current stable; the
2026-07-28 release candidate is NOT targeted — adopting it is a contract
change). Tools are the only MCP primitive in v0.2: the client consumes
external servers' tools as connectors; the server exposes platform
capabilities as tools. Resources, prompts, sampling, elicitation, and MCP
tasks are OUT. Deny-by-default in both directions: no config → no egress;
no token → no service.

```ts
export const MCP_PROTOCOL_REVISION = "2025-11-25";
/** Revisions accepted in negotiation. Extending this list is a contract change. */
export const SUPPORTED_MCP_REVISIONS: readonly ["2025-11-25", "2025-06-18"];

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | {
      kind: "http"; // Streamable HTTP per the pinned revision
      url: string;
      /** Token by env-var NAME only — secret values never appear in config. */
      auth?: { kind: "bearer"; tokenEnv: string };
    };

export interface McpServerEntry {
  /** Connector name, kebab-case, unique. */
  name: string;
  transport: McpTransport;
  /**
   * Tools callable on this server. Deny-by-default: empty = NOTHING callable
   * (deliberately the OPPOSITE of PolicyResource.allowedRoles semantics).
   */
  allowedTools: string[];
}

export interface McpClientConfig {
  servers: McpServerEntry[];
}

export type McpErrorCode =
  | "ERR_MCP_SERVER_UNKNOWN"     // server not in the allowlist
  | "ERR_MCP_TOOL_NOT_ALLOWED"   // tool not in the server's allowedTools
  | "ERR_MCP_POLICY_DENIED"
  | "ERR_MCP_PROTOCOL"           // negotiation failed / unsupported revision
  | "ERR_MCP_UPSTREAM"           // upstream error or transport failure
  | "ERR_MCP_AUDIT_UNAVAILABLE"; // audit append failed → call NOT made

export type McpCallResult =
  | { ok: true; content: unknown } // MCP tool-result content, pinned revision
  | { ok: false; code: McpErrorCode; message: string };

export interface McpClient {
  callTool(opts: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    /** On-behalf-of identity for policy + audit: human sub or agent id. */
    subject: PolicySubject;
    actorType: ActorType;
  }): Promise<McpCallResult>;
  listTools(server: string): Promise<{ name: string; description?: string }[]>;
  close(): Promise<void>;
}

export function createMcpClient(
  config: McpClientConfig,
  deps: { policy: PolicyEngine; audit: AuditStore },
): Promise<McpClient>;

/** A platform capability exposed as an MCP tool. */
export interface ExposedCapability {
  /** MCP tool name, kebab-case, unique. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema draft 2020-12
  /** Policy v0.2 semantics: empty = any authenticated subject. */
  allowedRoles: string[];
  handler(
    args: Record<string, unknown>,
    subject: PolicySubject,
  ): Promise<unknown>;
}

export function registerMcpServer(
  app: FastifyInstance, // mounted by the runtime at POST /mcp
  opts: {
    capabilities: ExposedCapability[];
    policy: PolicyEngine;
    audit: AuditStore;
    /** Resolve a bearer token against the platform OIDC issuer; null = 401. */
    verifyToken(bearer: string): Promise<PolicySubject | null>;
  },
): void;
```

- **Client egress is static.** The client connects only to servers present
  in `McpClientConfig`, loaded once at startup (runtime env
  `MCP_SERVERS_CONFIG` → JSON file; absent → the client is inert). No
  dynamic server registration, no discovery, and the HTTP transport never
  follows a redirect to a different origin. An unknown server name →
  `ERR_MCP_SERVER_UNKNOWN`, audited.
- **Outbound enforcement order** (fails closed): server allowlist → tool
  allowlist → `PolicyEngine.decide` (action `mcp.tool:<server>/<tool>`,
  resource `{ type: "mcp.tool", id: "<server>/<tool>", allowedRoles: [] }`)
  → audit `mcp.tool_call` (with `decision`) BEFORE the wire call — append
  failure means the call is NOT made — → invoke → audit `mcp.tool_result`
  AFTER (outcome, durationMs, args/content digests, never raw values).
- **Version pinning:** `initialize` offers `MCP_PROTOCOL_REVISION`; a
  negotiated revision outside `SUPPORTED_MCP_REVISIONS` → disconnect,
  `ERR_MCP_PROTOCOL`, audited. Same rule inbound: the server only accepts
  the supported revisions.
- **Secrets:** outbound bearer tokens are resolved from the environment at
  call time via `tokenEnv`; token values never appear in config files,
  logs, or audit attributes (the audit scrubber is defense-in-depth, not
  the primary control).
- **Inbound (MCP server):** mounted on the runtime at `POST /mcp`
  (Streamable HTTP only; no stdio exposure of the platform). Every request
  MUST present a bearer token; `verifyToken` validates it against the
  platform's OIDC issuer per the pinned revision's authorization spec
  (OAuth 2.1 resource server) and maps it to a `PolicySubject`; null → 401,
  audited as `mcp.serve_rejected`. Nothing is served anonymously —
  including `tools/list`, which returns only the capabilities the
  authenticated subject would be allowed to call.
- **Inbound enforcement order:** authenticate → `PolicyEngine.decide`
  (action `mcp.serve:<capability>`, resource `{ type: "mcp.capability",
  id: "<capability>", allowedRoles }` from the capability) → audit
  `mcp.serve_call` (with `decision`) BEFORE the handler → handler → audit
  `mcp.serve_result` AFTER. v0.2 accepts user-delegated tokens only: actor
  = token sub, actorType `"human"`, attributes `{ channel: "mcp" }`.
- **Audit events owned here:** `mcp.tool_call`, `mcp.tool_result`,
  `mcp.serve_call`, `mcp.serve_result`, `mcp.serve_rejected`.
- Unit tests run against an in-process fake MCP server (no network); the
  live-interop path (consume ≥ 1 real external server — acceptance
  criterion 6) is exercised in the Compose e2e stage.

## 6. A2A endpoint (`@openrupiv/runtime`) — agent-to-agent surface

The runtime exposes an **A2A v1.0** (Linux Foundation Agent2Agent) surface
in front of the §4 agent runtime: remote agents invoke this platform's
spec-declared agent tasks as A2A skills. Identity, policy, and audit sit in
front of every call; remote callers are agents, never humans, so every §4
invariant (proposal-only, zero approvals, reserved prefixes) applies to
them transitively.

```ts
export const A2A_PROTOCOL_VERSION = "1.0"; // A2A-Version header value, spec v1.0

export interface A2aClientEntry {
  /** OAuth client_id registered at the platform's OIDC issuer. */
  clientId: string;
  displayName?: string;
  /** Spec agent tasks (skills) this remote agent may invoke. Empty = none. */
  allowedSkills: string[];
}

export interface A2aConfig {
  /** Registered remote agents. Deny-by-default: absent/empty = endpoint disabled. */
  clients: A2aClientEntry[];
}

export function registerA2aEndpoint(
  app: FastifyInstance,
  opts: {
    spec: AppSpec;
    config: A2aConfig;
    agents: AgentRuntime; // §4
    policy: PolicyEngine;
    audit: AuditStore;
    /** Resolve a bearer token to its OAuth client_id; null = 401. */
    verifyToken(bearer: string): Promise<{ clientId: string } | null>;
  },
): void;
```

- **Pinned revision + binding:** A2A spec v1.0, JSON-RPC 2.0 binding over
  HTTP(S) only, at `POST /a2a/v1`. Every request MUST carry
  `A2A-Version: 1.0`; a missing or different value is rejected with a typed
  JSON-RPC error — never a silent v0.3 fallback (the spec's no-header
  default). Methods implemented: `SendMessage`, `GetTask` (v1.0 PascalCase
  names). Agent card served at `GET /.well-known/agent-card.json`.
- **Minimal v1 surface — explicitly OUT:** streaming
  (`SendStreamingMessage`, `SubscribeToTask`), `ListTasks`, `CancelTask`,
  all four push-notification-config methods, `GetExtendedAgentCard`, the
  gRPC and HTTP+JSON/REST bindings, multi-turn `input-required` tasks, and
  an *outbound* A2A client (the platform does not call remote agents in
  v0.2). Unsupported methods return JSON-RPC `-32601`.
- **Identity in front of every call:** bearer token verified against the
  platform's OIDC issuer AND the resolved `clientId` must be present in
  `A2aConfig.clients` — a valid token from an unregistered client is
  rejected and audited (`a2a.auth_rejected`). The mapped identity is
  `a2a:<clientId>`, actorType `"agent"`, roles `[]`. The `a2a:` prefix is
  reserved exactly like `agent:` (§4).
- **Policy + audit in front of every call** (fails closed): skill must be
  on the client's `allowedSkills` AND `PolicyEngine.decide` must allow
  (action `a2a.skill:<skill>`, resource `{ type: "a2a.skill", id:
  "<skill>", allowedRoles: [] }`); audit `a2a.call` (with `decision`)
  BEFORE dispatch — append failure means no dispatch — and `a2a.result`
  AFTER. Audit events owned here: `a2a.call`, `a2a.result`,
  `a2a.auth_rejected`.
- **Skill dispatch:** skills are exactly the spec's `agents` entries.
  `SendMessage` starts one governed task run through
  `agents.contextFor(skill)` — so every tool call inside it is §4
  policy-checked, sandboxed, and audited, and any human-gated transition
  becomes a *proposal*. An A2A caller can never satisfy a HITL gate and
  counts as zero approvals. `SendMessage` returns an A2A Task; whether
  execution is inline or queued is an implementation choice — the returned
  task id MUST be retrievable via `GetTask` by the same client.
- **Caller isolation:** `GetTask` returns a task only to the `clientId`
  that created it; anything else is indistinguishable from a nonexistent
  task id.
- **SQL:** `a2a_tasks(id uuid primary key default gen_random_uuid(),
  client_id text not null, skill text not null, status text not null check
  (status in ('submitted','working','completed','failed')), result jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not
  null default now())` — runtime infra-table step; statuses map onto A2A
  `TaskState` values in responses.
- **Agent card is minimal:** name, description, version, skills (name +
  description from the spec `agents` entries), `securitySchemes`
  (OAuth 2.0 against the platform issuer), and the JSON-RPC interface URL —
  no entity schemas, role names, or internal topology. The card route is
  public per the A2A discovery model and contains no secrets.

## Package skeletons

`@openrupiv/audit` ships dependency-complete (no new runtime deps beyond
`pg`, already in the workspace; hashing via node:crypto). Policy/agents/mcp
skeletons are added when their build stages start, each with an ADR for the
load-bearing design choice (OPA embedding; sandbox technology).

## Open questions — resolved (PROPOSED, pending maintainer confirmation)

The design work in §4–§6 surfaced twelve open product/scope questions
(triggering, tool provenance, sandbox limits, RBAC-for-agents, ungated
transitions, proposal lifecycle, cross-cutting tool references, exposed MCP
capabilities, inbound MCP identity, MCP revision pinning, A2A client
provisioning, agent-card exposure). Per CLAUDE.md these are security-adjacent
product-scope decisions, not something an agent session finalizes
unilaterally. Below, each gets a recommended default so implementation can
proceed without blocking on a synchronous decision meeting, but every item
marked **PROPOSED** is a draft pending a maintainer's explicit sign-off —
same spirit as an ADR filed with `Status: proposed` (see `docs/adr/README.md`)
even though these are recorded here, not as standalone ADRs, since most are
scoping/deferral calls rather than a single load-bearing architecture choice.
Items marked **CONFIRMED** are not being reopened — they restate a v0.2 pin
already written elsewhere in this document; they're listed here only so a
reviewer can scan all twelve in one place instead of re-deriving which were
already settled.

1. **What triggers an agent task run in v0.2, and what drives its decision
   loop?** — **PROPOSED.** Triggers are limited to admin-API-initiated and
   workflow-event-initiated runs only; no schedule/cron trigger in v0.2. The
   decision loop is deterministic-script-only (the code behind
   `AgentContext` for a given task runs a fixed procedure, not an LLM
   planner choosing its own next step).
   *Rationale:* a cron/timer surface and an LLM-driven planning loop are
   each a materially bigger review burden than the sandbox already lands in
   this stage — deferring both keeps the v0.2 blast radius to "a human or a
   workflow event decided this run should happen, and it does one fixed
   thing," not "an autonomous loop decided."

2. **Tool registry provenance — where do `RegisteredTool` implementations
   live, and how are they registered?** — **PROPOSED.** Platform built-in
   tools only in v0.2, registered via a static in-code registry (the
   `tools: RegisteredTool[]` passed into `createAgentRuntime`'s `deps` is
   populated at process startup from a hardcoded list shipped in-tree — no
   dynamic registration, no app-spec-authored tools). Every registered
   tool's `entrypoint` still runs exclusively inside the ADR-0007 isolation
   boundary (`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`); nothing
   bypasses the sandbox regardless of how a tool got registered.
   *Rationale:* a code-reviewed, ship-time-fixed tool list is auditable by
   construction; app-authored or dynamically-loaded tools would let spec
   content decide what code runs on the host, which is a second, larger
   design question than this stage should absorb.

3. **Concrete sandbox limit values (wall-clock, memory, output size).** —
   Not re-decided here. Source of truth is **ADR-0007**
   (`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`, in progress
   concurrently): 30s / 256MiB / 1MiB defaults. This contract only requires
   that `SandboxLimits` be populated with *some* value (line ~263) — the
   values themselves are ADR-0007's call, not this document's.

4. **May agent identities ever hold RBAC roles?** — **CONFIRMED, not
   reopened.** `AgentIdentity.roles` stays `[]` in v0.2 (see §4): the tool
   allowlist remains the sole capability grant.
   *Rationale (as already recorded in §4):* least privilege, and avoiding a
   second grant surface (roles *and* tool allowlist) that could be
   independently misconfigured or drift out of sync.

5. **May agents ever directly fire non-gated workflow transitions?** —
   **CONFIRMED, not reopened.** No — agents only ever `propose()`; an app
   spec whose `agents[].proposes` entry references a transition without an
   approval rule is a validation error (see §4, "Spec evolution").
   *Rationale (as already recorded in §4):* every agent-touched transition
   must still pass through a human HITL gate; there is no v0.2 path for an
   agent's output to become committed state without a human approver.

6. **Proposal lifecycle — expiry, explicit human rejection, and an admin
   listing of pending `agent_proposals`.** — **PROPOSED.** Proposals do not
   auto-expire in v0.2 (there is no timer/cron surface to drive expiry — see
   Q1). A human can explicitly reject a proposal, recorded as a new
   terminal status and audited (in addition to the existing "approved via
   normal workflow approval" path). Pending proposals are listed via a
   simple `GET /admin/agent-proposals` endpoint reusing the existing
   `/admin/*` authz pattern (same shape as `GET /admin/audit`, §2) — no
   bespoke UI in v0.2.
   *Rationale:* matches the smallest-surface bias already used for
   `/admin/audit`; a dedicated review UI is a real feature but not required
   to satisfy the HITL invariant, so it's deferred rather than built now.

7. **May an agent task's `tools` allowlist reference MCP connector tools,
   or only sandboxed platform tools?** — **PROPOSED.** v0.2 sandbox tools
   only — every name in `AgentTaskDef.tools` must resolve to a
   `RegisteredTool` (Q2); `mcp:<server>/<tool>`-style references are
   explicitly out of scope and deferred to v0.3.
   *Rationale:* letting an agent's tool allowlist transitively reach an
   external system through the MCP client would stack a second policy/audit
   surface (§5's outbound enforcement) underneath the agent's own (§4's),
   compounding the review burden beyond what this stage should take on.

8. **Which platform capabilities ship as MCP-server `ExposedCapability`
   entries in v0.2** (at least one is needed for acceptance criterion 6)?
   — **PROPOSED.** Exactly one: workflow-instance status/read (read-only,
   low blast radius). Explicitly NOT audit-log read (keeps the audit-read
   boundary established in the Phase 1 security review's finding C intact)
   and NOT any write or transition-firing capability.
   *Rationale:* smallest possible exposed surface that still satisfies the
   acceptance criterion; audit-log read and any write capability are
   meaningfully higher-stakes exposures that deserve their own review, not
   a default picked to unblock a demo.
   **Needs maintainer product sign-off** on whether this specific capability
   is actually the right fit for the intended vendor-onboarding demo, since
   that's a product-scope call, not just a security-minimization one.

9. **What machine identities may call the inbound MCP server?** —
   **CONFIRMED, not reopened.** v0.2 accepts user-delegated OAuth tokens
   only (see §5, "Inbound (MCP server)"); `actorType` is always `"human"`.
   Client-credentials service tokens are deferred.
   *Rationale (as already recorded in §5):* keeps every inbound MCP call
   attributable to a real human subject under the platform's existing OIDC
   identity model, rather than introducing a new machine-identity class
   before agent/A2A machine identities (§4, §6) have proven out the pattern.

10. **MCP revision adoption — negotiate the 2026-07-28 revision, or stay
    pinned at 2025-11-25?** — **PROPOSED** (already the direction recorded
    in §5, formalized here). Stay pinned at `2025-11-25` for all of v0.2;
    the 2026-07-28 revision is not finalized/stable yet. Revisit via a
    follow-up ADR once it ships as a stable release — do not adopt a
    release candidate preemptively.
    *Rationale:* adopting a moving-target RC as a contract dependency risks
    a breaking renegotiation mid-phase; pinning to the last stable revision
    is the conservative default until the newer one is actually final.

11. **A2A client provisioning — how does a remote agent obtain an OAuth
    client at the platform IdP?** — **PROPOSED.** v0.2 ships with Dex
    static clients configured out-of-band by the operator, the same
    pattern the bundled dev IdP already uses (ADR-0002). Self-service
    client registration is explicitly out of scope for v0.2.
    *Rationale:* matches an already-accepted pattern instead of introducing
    a new self-service registration flow (its own auth-surface review) in
    the same stage the A2A endpoint itself is landing.

12. **Should the public `agent-card.json` be gateable behind auth for
    air-gapped/regulated deployments?** — **PROPOSED.** Keep it public by
    default, matching the A2A discovery spec and the current
    implementation (§6, "Agent card is minimal"). Add an explicit opt-in
    config flag (e.g. `A2A_AGENT_CARD_REQUIRE_AUTH`) that, when set,
    requires authentication on that route for operators in regulated or
    air-gapped environments.
    *Rationale:* the smallest change that satisfies both the A2A spec's
    default expectation (public discovery) and a real compliance need this
    platform commits to supporting (CLAUDE.md's secure-by-default,
    enterprise-features-in-core stance) — an opt-in flag rather than
    changing the default for everyone.

**Human-only review paths implicated:** Q2 and Q3 touch the agent sandbox;
Q8 touches the audit-log read boundary; Q9, Q11, and Q12 touch
authentication/authorization. Per CLAUDE.md, any implementation PR touching
these must still go through human-maintainer review regardless of this
section's proposed defaults.
