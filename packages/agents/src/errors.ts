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
