import { describe, expect, it, vi } from "vitest";
import { createSidecarSandbox } from "../src/client";
import type { SandboxExecuteInput } from "@openrupiv/agents";

const BASE_INPUT: SandboxExecuteInput = {
  tool: { name: "echo", description: "echoes input", inputSchema: {}, entrypoint: "echo" },
  input: { hello: "world" },
  workspaceDir: "/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  limits: { wallClockMs: 30_000, memoryBytes: 268_435_456, maxOutputBytes: 1_048_576 },
};

describe("createSidecarSandbox", () => {
  it("POSTs to <baseUrl>/v1/execute with the bearer token and { runId, tool, input, limits }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, output: { echoed: true }, durationMs: 5 }), { status: 200 }),
    );
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "test-token-value", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);

    expect(result).toEqual({ ok: true, output: { echoed: true }, durationMs: 5 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sandbox.internal:8443/v1/execute");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-token-value" });
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      tool: "echo",
      input: { hello: "world" },
      limits: BASE_INPUT.limits,
    });
    // Never a raw workspaceDir path on the wire.
    expect(JSON.stringify(sentBody)).not.toContain("/workspaces/");
  });

  it("re-validates workspaceDir client-side and refuses to send a malformed runId", async () => {
    const fetchImpl = vi.fn();
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute({ ...BASE_INPUT, workspaceDir: "/workspaces/../../etc" });
    expect(result).toMatchObject({ ok: false, reason: "tool_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx HTTP response to a tool_error result rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: "tool_error" });
  });

  it("maps a network-level fetch rejection to a tool_error result rather than throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const sandbox = createSidecarSandbox({ baseUrl: "http://sandbox.internal:8443", token: "t", fetchImpl });
    const result = await sandbox.execute(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: "tool_error", message: expect.stringContaining("ECONNREFUSED") });
  });
});
