/**
 * Thrown by `contextFor` for an unknown task name. The §4 contract says
 * `contextFor` "throws on unknown task" and separately describes the
 * no-agents case as throwing "`ERR_TOOL_UNKNOWN`-style" -- i.e. a typed,
 * `AgentErrorCode`-shaped error, but `contextFor` itself has no
 * `ToolCallResult`-like return type to carry a code in, so this is a real
 * `throw`, not a result object. `code` mirrors the `AgentErrorCode` naming
 * convention without literally being one (this isn't a tool-call failure).
 */
export class AgentTaskNotFoundError extends Error {
  readonly code = "ERR_TASK_UNKNOWN" as const;
  readonly taskName: string;

  constructor(taskName: string) {
    super(`no agent task named ${JSON.stringify(taskName)}`);
    this.name = "AgentTaskNotFoundError";
    this.taskName = taskName;
  }
}

/**
 * Thrown by `createAgentRuntime` at construction if any spec-declared task's
 * `tools` allowlist names a tool with no matching `RegisteredTool` in
 * `deps.tools` — per specs/phase-2-contracts.md §4 "Spec evolution": "Every
 * `tools` name must resolve to a `RegisteredTool` at runtime startup — fail
 * fast, typed error." Previously this only surfaced per-call as
 * `ERR_TOOL_UNKNOWN`, too late for a misconfigured deployment to catch at
 * boot.
 */
export class AgentToolUnregisteredError extends Error {
  readonly code = "ERR_TOOL_UNREGISTERED_AT_STARTUP" as const;
  readonly taskName: string;
  readonly toolName: string;

  constructor(taskName: string, toolName: string) {
    super(
      `agent task ${JSON.stringify(taskName)} declares tool ${JSON.stringify(toolName)} in its allowlist, but no RegisteredTool with that name was passed to createAgentRuntime`,
    );
    this.name = "AgentToolUnregisteredError";
    this.taskName = taskName;
    this.toolName = toolName;
  }
}
