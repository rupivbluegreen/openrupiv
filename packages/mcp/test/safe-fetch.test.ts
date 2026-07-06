import { describe, expect, it, vi } from "vitest";
import { makeSafeFetch } from "../src/client";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}

type FakeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

describe("makeSafeFetch", () => {
  it("passes through a normal (non-redirect) response untouched", async () => {
    const base = vi.fn<FakeFetch>(async () => jsonResponse({ ok: true }, { status: 200 }));
    const safe = makeSafeFetch({}, base);
    const res = await safe("https://mcp.example.com/mcp", { method: "POST" });
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("follows a same-origin redirect", async () => {
    const responses = [
      new Response(null, { status: 307, headers: { location: "https://mcp.example.com/mcp2" } }),
      jsonResponse({ ok: true }, { status: 200 }),
    ];
    let call = 0;
    const base = vi.fn<FakeFetch>(async () => responses[call++]!);
    const safe = makeSafeFetch({}, base);
    const res = await safe("https://mcp.example.com/mcp", { method: "POST" });
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    const secondCall = base.mock.calls[1];
    expect((secondCall?.[0] as URL).toString()).toBe("https://mcp.example.com/mcp2");
  });

  it("refuses to follow a cross-origin redirect", async () => {
    const base = vi.fn<FakeFetch>(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
    );
    const safe = makeSafeFetch({}, base);
    await expect(safe("https://mcp.example.com/mcp", { method: "POST" })).rejects.toThrow(/cross-origin/i);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("resolves the bearer token from process.env fresh on every call, never caching it", async () => {
    process.env["TEST_MCP_TOKEN"] = "first-token";
    const base = vi.fn<FakeFetch>(async () => jsonResponse({ ok: true }));
    const safe = makeSafeFetch({ tokenEnv: "TEST_MCP_TOKEN" }, base);

    await safe("https://mcp.example.com/mcp", { method: "POST" });
    const firstCall = base.mock.calls[0];
    const firstHeaders = firstCall?.[1]?.headers as Headers;
    expect(firstHeaders.get("authorization")).toBe("Bearer first-token");

    process.env["TEST_MCP_TOKEN"] = "second-token";
    await safe("https://mcp.example.com/mcp", { method: "POST" });
    const secondCall = base.mock.calls[1];
    const secondHeaders = secondCall?.[1]?.headers as Headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer second-token");

    delete process.env["TEST_MCP_TOKEN"];
  });

  it("never puts the token value anywhere in a URL", async () => {
    process.env["TEST_MCP_TOKEN_2"] = "should-not-leak";
    const base = vi.fn<FakeFetch>(async () => jsonResponse({ ok: true }));
    const safe = makeSafeFetch({ tokenEnv: "TEST_MCP_TOKEN_2" }, base);
    await safe("https://mcp.example.com/mcp", { method: "POST" });
    const firstCall = base.mock.calls[0];
    const calledUrl = firstCall?.[0] as URL;
    expect(calledUrl.toString()).not.toContain("should-not-leak");
    delete process.env["TEST_MCP_TOKEN_2"];
  });
});
