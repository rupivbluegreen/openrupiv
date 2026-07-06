import type { SandboxExecuteInput, SandboxExecuteResult, ToolSandbox } from "@openrupiv/agents";

const DEFAULT_RESULT: SandboxExecuteResult = { ok: true, output: null, durationMs: 1 };

export class FakeToolSandbox implements ToolSandbox {
  readonly calls: SandboxExecuteInput[] = [];
  private queue: SandboxExecuteResult[] = [];

  queueResult(result: SandboxExecuteResult): void {
    this.queue.push(result);
  }

  async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    this.calls.push(input);
    return this.queue.shift() ?? DEFAULT_RESULT;
  }
}
