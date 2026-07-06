/**
 * Fully-controlled fake `ToolSandbox` for unit tests. Records every call
 * (so tests can assert `workspaceDir`/`limits` were passed through
 * correctly) and returns queued or default results -- ok, violation, limit,
 * or tool_error, exactly the `SandboxExecuteResult` shapes real ADR-0007
 * sandbox implementations must produce. No live isolation technology here,
 * per specs/phase-2-contracts.md §4 ("Unit tests inject a fake ToolSandbox
 * ... no live isolation technology in unit tests").
 */
import type { SandboxExecuteInput, SandboxExecuteResult, ToolSandbox } from "../../src/types";

const DEFAULT_RESULT: SandboxExecuteResult = { ok: true, output: null, durationMs: 1 };

export class FakeSandbox implements ToolSandbox {
  readonly calls: SandboxExecuteInput[] = [];
  private queue: SandboxExecuteResult[] = [];
  private defaultResult: SandboxExecuteResult = DEFAULT_RESULT;

  /** Queue a result for the next execute() call (FIFO); falls back to the default after the queue drains. */
  queueResult(result: SandboxExecuteResult): void {
    this.queue.push(result);
  }

  setDefaultResult(result: SandboxExecuteResult): void {
    this.defaultResult = result;
  }

  async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    this.calls.push(input);
    return this.queue.shift() ?? this.defaultResult;
  }
}
