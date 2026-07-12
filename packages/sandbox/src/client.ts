/**
 * `createSidecarSandbox` — the `ToolSandbox` implementation `@openrupiv/agents`
 * calls at step 5 of `callTool` (ADR-0007, "Decision"). `workspaceDir` is
 * treated as opaque beyond its final path segment: this client extracts and
 * RE-VALIDATES that segment as a `runId` (never trusts the caller's
 * `SandboxExecuteInput.workspaceDir` as a real path) and transmits only
 * `{ runId, tool, input, limits }` over the wire — never a path string.
 */

import type {
  SandboxExecuteInput,
  SandboxExecuteResult,
  ToolSandbox,
} from "@openrupiv/agents";
import { extractRunId } from "./run-id";

export interface CreateSidecarSandboxOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function createSidecarSandbox(opts: CreateSidecarSandboxOptions): ToolSandbox {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
      const runId = extractRunId(input.workspaceDir);
      if (!runId) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: workspaceDir "${input.workspaceDir}" does not carry a valid runId`,
          durationMs: 0,
        };
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(`${opts.baseUrl}/v1/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({ runId, tool: input.tool.entrypoint, input: input.input, limits: input.limits }),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: request failed: ${errorMessage(err)}`,
          durationMs: Date.now() - startedAt,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: sidecar returned HTTP ${response.status}`,
          durationMs: Date.now() - startedAt,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return {
          ok: false,
          reason: "tool_error",
          message: `createSidecarSandbox: failed to parse sidecar response: ${errorMessage(err)}`,
          durationMs: Date.now() - startedAt,
        };
      }

      if (typeof (body as Record<string, unknown>).ok !== "boolean") {
        return {
          ok: false,
          reason: "tool_error",
          message: "createSidecarSandbox: sidecar returned a malformed result",
          durationMs: Date.now() - startedAt,
        };
      }

      return body as SandboxExecuteResult;
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
