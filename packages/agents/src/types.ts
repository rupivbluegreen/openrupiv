/**
 * @openrupiv/agents -- governed agent workers. Contract:
 * specs/phase-2-contracts.md §4.
 *
 * Agents are first-class governed workers, never privileged ones: every
 * capability an agent holds flows through the same PDP (@openrupiv/policy)
 * and audit substrate (@openrupiv/audit) as a human actor, plus a tool
 * allowlist and an isolation boundary (ADR-0007) humans don't need. This
 * file is the literal TS surface the contract specifies -- see README.md
 * for the design notes on the handful of places it had to be interpreted
 * (the `Db` seam, sandbox limits/workspace defaults, and the
 * `AppSpec.agents` v0.1/v0.2 type gap).
 */

/** Agent identity -- a distinct namespace from human OIDC subs by construction. */
export interface AgentIdentity {
  /**
   * Always `agent:<task-name>@<app-slug>`. The `agent:` prefix (and `a2a:`,
   * §6) is reserved: the runtime rejects any OIDC sub carrying a reserved
   * prefix at session creation, so the namespaces cannot collide. Callers
   * never supply this directly -- `createAgentRuntime` constructs it.
   */
  id: string;
  /** v0.2: always [] -- the tool allowlist is the sole capability grant. */
  roles: string[];
}

/**
 * Spec v0.2 `agents` entry -- extends the reserved v0.1 shape in
 * `@openrupiv/spec` behind the schema version bump (specs/phase-2.md). See
 * README.md "Spec v0.1/v0.2 type gap" for how `createAgentRuntime` bridges
 * today's @openrupiv/spec (which does not yet expose `tools`/`proposes` on
 * its own `AgentTaskDef`) to this richer shape.
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
  | "ERR_TOOL_NOT_ALLOWED" // not on the task's `tools` allowlist
  | "ERR_TOOL_UNKNOWN" // allowlisted but no registered implementation
  | "ERR_TOOL_INPUT" // input fails the tool's inputSchema
  | "ERR_POLICY_DENIED" // PDP denied (audited, like every decision)
  | "ERR_SANDBOX_VIOLATION" // attempted egress / FS escape -- blocked + audited
  | "ERR_SANDBOX_LIMIT" // wall-clock / memory / output-size limit hit
  | "ERR_TOOL_FAILED" // tool executed and failed
  | "ERR_AUDIT_UNAVAILABLE"; // audit append failed -> the call is NOT executed

export type ToolCallResult =
  | { ok: true; output: unknown }
  | { ok: false; code: AgentErrorCode; message: string };

export interface AgentProposal {
  id: string; // uuid
  agentId: string; // AgentIdentity["id"]
  entityTable: string; // snake_case table, same convention as workflow_approvals
  recordId: string;
  workflow: string;
  transition: string;
  rationale: string;
  createdAt: string; // RFC3339 UTC (injected clock, as in @openrupiv/audit)
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

/** Limits are REQUIRED -- no defaults in this contract (values fixed in ADR-0007). */
export interface SandboxLimits {
  wallClockMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
}

export interface SandboxExecuteInput {
  tool: RegisteredTool;
  input: Record<string, unknown>;
  /** Absolute host path of the per-run workspace -- the ONLY host state visible inside. */
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
 * concrete mechanism -- container, microVM, restricted subprocess, ... -- is
 * decided in ADR-0007; implementations MUST satisfy the workspace, egress,
 * and limit semantics without this interface changing.
 */
export interface ToolSandbox {
  execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}

/**
 * Structural database seam -- deliberately OUR OWN minimal interface, not an
 * import from @openrupiv/runtime (that would be a reverse dependency) or a
 * re-export of @openrupiv/audit's `Queryable`/`Pool` (see README.md "Why our
 * own Db/Queryable" for the reasoning). Shaped so that
 * `packages/runtime/src/db.ts`'s real `Db` -- which has `query` returning
 * `{rows, rowCount}` and a `transaction<T>(fn)` method, plus an extra
 * `end()` we don't need -- satisfies this structurally with zero import.
 */
export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface Db extends Queryable {
  /**
   * Run `fn` inside a transaction: commit on success, roll back on any
   * throw. `propose()` uses this so the `agent_proposals` insert and the
   * `agent.transition_proposed` audit append commit or roll back together.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
