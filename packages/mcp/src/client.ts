/**
 * MCP client — static egress only. Connects ONLY to servers present in the
 * `McpClientConfig` handed to `createMcpClient`, resolved once at call time;
 * no dynamic registration, no discovery. Every `callTool` walks the fixed,
 * fail-closed enforcement order from specs/phase-2-contracts.md §5:
 *
 *   server allowlist -> tool allowlist -> policy.decide -> audit
 *   `mcp.tool_call` (BEFORE the wire call, append failure = call NOT made)
 *   -> invoke via the SDK client -> audit `mcp.tool_result` (AFTER).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActorType } from "@openrupiv/audit";
import type { PolicySubject } from "@openrupiv/policy";
import { digestValue } from "./digest";
import {
  SUPPORTED_MCP_REVISIONS,
  type McpCallResult,
  type McpClient,
  type McpClientConfig,
  type McpClientDeps,
  type McpErrorCode,
  type McpServerEntry,
  type McpTransport,
} from "./types";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps fetch so the HTTP transport (a) never follows a redirect to a
 * different origin and (b) resolves the bearer token from `process.env`
 * fresh on every call — never once at config-load time, never cached.
 *
 * LIMITATION (documented per the contract's request): the SDK's
 * `StreamableHTTPClientTransport` does not expose a "disallow cross-origin
 * redirect" option directly; this wrapper is how we get that control. Global
 * `fetch` (undici in Node) follows redirects transparently when
 * `redirect: "follow"` (the default), so we force `redirect: "manual"` and
 * walk same-origin redirects ourselves, refusing to continue as soon as a
 * `Location` header points at a different origin.
 */
export function makeSafeFetch(opts: { tokenEnv?: string }, baseFetch: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    const headers = new Headers(init?.headers);
    if (opts.tokenEnv) {
      const token = process.env[opts.tokenEnv];
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    let currentUrl = requestUrl;
    let currentInit: RequestInit = { ...init, headers, redirect: "manual" };
    let redirects = 0;
    for (;;) {
      const response = await baseFetch(currentUrl, currentInit);
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = isRedirect ? response.headers.get("location") : null;
      if (!isRedirect || !location) return response;
      if (redirects >= 5) {
        throw new Error("MCP HTTP transport: too many redirects");
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== requestUrl.origin) {
        throw new Error(
          `MCP HTTP transport: refusing to follow cross-origin redirect from ${requestUrl.origin} to ${nextUrl.origin}`,
        );
      }
      currentUrl = nextUrl;
      currentInit = { ...init, headers, redirect: "manual" };
      redirects += 1;
    }
  };
}

/**
 * Pins the negotiated MCP protocol revision to `SUPPORTED_MCP_REVISIONS`
 * ourselves. The SDK's own `Client.connect()` already validates the
 * negotiated `initialize` result against ITS OWN, broader
 * `SUPPORTED_PROTOCOL_VERSIONS` list (which includes several older
 * revisions this contract does not accept) and has no public getter for the
 * negotiated version afterwards — so we cannot inspect it through the SDK's
 * own API post hoc. Instead we install our own `setProtocolVersion` hook on
 * the transport instance BEFORE connecting: the SDK Client calls
 * `transport.setProtocolVersion(result.protocolVersion)` immediately after a
 * successful `initialize` exchange (and before `notifications/initialized`
 * is sent) whenever the transport defines that method — so we capture the
 * negotiated version there and re-validate against our narrower list. This
 * also transparently covers `stdio` transports, which don't define
 * `setProtocolVersion` themselves (irrelevant for HTTP-only concerns like
 * headers) but for which the Client will still invoke whatever function we
 * attach, since it only checks truthiness before calling it.
 *
 * NOTE on typing: we deliberately do NOT implement a `Transport`-shaped
 * wrapper CLASS around the inner transport, because `StreamableHTTPClientTransport`
 * itself does not structurally satisfy the SDK's own `Transport` interface
 * under this workspace's `exactOptionalPropertyTypes: true` (its `sessionId`
 * is a getter typed `string | undefined`, which is incompatible with the
 * interface's `sessionId?: string` under that flag — a real mismatch in the
 * SDK's declarations, reproducible with zero of our own code). Monkey-patching
 * the method on the already-valid instance sidesteps re-implementing the
 * interface; the single `as Transport` cast where we hand the instrumented
 * instance to `client.connect()` is the one place this friction surfaces.
 */
function pinProtocolVersion(transport: Transport): { getNegotiatedVersion: () => string | undefined } {
  let negotiatedVersion: string | undefined;
  const original = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    negotiatedVersion = version;
    original?.(version);
  };
  return { getNegotiatedVersion: () => negotiatedVersion };
}

function buildInnerTransport(transport: McpTransport): Transport {
  if (transport.kind === "stdio") {
    return new StdioClientTransport({ command: transport.command, args: transport.args });
  }
  const tokenEnv = transport.auth?.tokenEnv;
  const fetchImpl = makeSafeFetch(tokenEnv !== undefined ? { tokenEnv } : {});
  return new StreamableHTTPClientTransport(new URL(transport.url), { fetch: fetchImpl }) as Transport;
}

/** True when an error thrown by `Client.connect()` is a protocol/version negotiation failure. */
function isProtocolNegotiationError(err: unknown): boolean {
  // The SDK's own version check (against ITS broader SUPPORTED_PROTOCOL_VERSIONS,
  // which is a strict superset of ours — see SUPPORTED_MCP_REVISIONS above) is the
  // only validation `Client.connect()` performs before the transport-level errors
  // that would surface as genuine transport/upstream failures. Any negotiated
  // version the SDK itself rejects would necessarily also fail our narrower list,
  // so classifying by this message is safe even though it is a string match
  // against SDK wording rather than a typed error class (the SDK does not export
  // one for this case).
  return errMessage(err).toLowerCase().includes("protocol version");
}

type Connection = { client: Client };
type ConnectOutcome = { ok: true; client: Client } | { ok: false; code: "ERR_MCP_PROTOCOL" | "ERR_MCP_UPSTREAM"; message: string };

/**
 * Builds the raw wire transport for a server entry. This is a seam, not part
 * of the public contract: `createMcpClient`'s signature and behavior are
 * exactly as specified (specs/phase-2-contracts.md §5), and in production
 * this is always `buildInnerTransport` (real `stdio`/`http` transports).
 * `createMcpClientWithTransportBuilder` exists solely so tests can supply an
 * in-process `InMemoryTransport` half (the pattern the task description asks
 * us to check for and use) without adding a third `McpTransport` kind to the
 * public config type or spawning a real subprocess/socket.
 */
export type TransportBuilder = (transport: McpTransport) => Transport;

async function connectServer(entry: McpServerEntry, buildTransport: TransportBuilder): Promise<ConnectOutcome> {
  const transport = buildTransport(entry.transport);
  const { getNegotiatedVersion } = pinProtocolVersion(transport);
  const client = new Client({ name: "openrupiv-mcp-client", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    if (isProtocolNegotiationError(err)) {
      return { ok: false, code: "ERR_MCP_PROTOCOL", message: `MCP protocol negotiation failed: ${errMessage(err)}` };
    }
    return { ok: false, code: "ERR_MCP_UPSTREAM", message: `MCP connect failed: ${errMessage(err)}` };
  }
  const negotiated = getNegotiatedVersion();
  if (!negotiated || !(SUPPORTED_MCP_REVISIONS as readonly string[]).includes(negotiated)) {
    await client.close().catch(() => {});
    return {
      ok: false,
      code: "ERR_MCP_PROTOCOL",
      message: `unsupported MCP protocol revision negotiated: ${negotiated ?? "unknown"}`,
    };
  }
  return { ok: true, client };
}

export async function createMcpClient(config: McpClientConfig, deps: McpClientDeps): Promise<McpClient> {
  return createMcpClientWithTransportBuilder(config, deps, buildInnerTransport);
}

/** Test-support seam — see `TransportBuilder`. Not part of the §5 contract surface. */
export async function createMcpClientWithTransportBuilder(
  config: McpClientConfig,
  deps: McpClientDeps,
  buildTransport: TransportBuilder,
): Promise<McpClient> {
  const servers = new Map(config.servers.map((s) => [s.name, s] as const));
  const connections = new Map<string, Connection>();

  async function getConnection(entry: McpServerEntry): Promise<ConnectOutcome> {
    const existing = connections.get(entry.name);
    if (existing) return { ok: true, client: existing.client };
    const outcome = await connectServer(entry, buildTransport);
    if (outcome.ok) connections.set(entry.name, { client: outcome.client });
    return outcome;
  }

  async function callTool(opts: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    subject: PolicySubject;
    actorType: ActorType;
  }): Promise<McpCallResult> {
    const { server, tool, args, subject, actorType } = opts;
    const entry = servers.get(server);

    let decision: "allow" | "deny" = "deny";
    let code: McpErrorCode | undefined;
    let message = "";
    let policyReason: string | undefined;

    if (!entry) {
      code = "ERR_MCP_SERVER_UNKNOWN";
      message = `unknown MCP server "${server}"`;
    } else if (!entry.allowedTools.includes(tool)) {
      code = "ERR_MCP_TOOL_NOT_ALLOWED";
      message = `tool "${tool}" is not on server "${server}"'s allowedTools`;
    } else {
      const pd = await deps.policy.decide({
        subject,
        action: `mcp.tool:${server}/${tool}`,
        resource: { type: "mcp.tool", id: `${server}/${tool}`, allowedRoles: [] },
      });
      if (pd.allow) {
        decision = "allow";
      } else {
        code = "ERR_MCP_POLICY_DENIED";
        policyReason = pd.reason;
        message = `policy denied mcp.tool:${server}/${tool}: ${pd.reason}`;
      }
    }

    const argsDigest = digestValue(args);
    try {
      await deps.audit.append({
        event: "mcp.tool_call",
        actor: subject.id,
        actorType,
        subject: `${server}/${tool}`,
        decision,
        attributes: {
          server,
          tool,
          action: `mcp.tool:${server}/${tool}`,
          ...(code ? { code } : {}),
          ...(policyReason !== undefined ? { policyReason } : {}),
          argsDigest: argsDigest.sha256,
          argsBytes: argsDigest.bytes,
        },
      });
    } catch (err) {
      return {
        ok: false,
        code: "ERR_MCP_AUDIT_UNAVAILABLE",
        message: `audit append failed before mcp.tool_call: ${errMessage(err)}`,
      };
    }

    if (decision !== "allow") {
      return { ok: false, code: code ?? "ERR_MCP_POLICY_DENIED", message };
    }

    // entry is guaranteed defined here: decision === "allow" only when entry existed.
    const started = performance.now();
    let result: McpCallResult;
    const conn = await getConnection(entry!);
    if (!conn.ok) {
      result = { ok: false, code: conn.code, message: conn.message };
    } else {
      try {
        const callResult = await conn.client.callTool({ name: tool, arguments: args });
        if (callResult.isError) {
          const text = extractErrorText(callResult.content);
          result = { ok: false, code: "ERR_MCP_UPSTREAM", message: text ?? "MCP tool call returned an error result" };
        } else {
          result = { ok: true, content: callResult.content };
        }
      } catch (err) {
        result = { ok: false, code: "ERR_MCP_UPSTREAM", message: `MCP tool call failed: ${errMessage(err)}` };
      }
    }
    const durationMs = performance.now() - started;

    const resultDigestSource = result.ok ? result.content : { code: result.code, message: result.message };
    const resultDigest = digestValue(resultDigestSource);
    try {
      await deps.audit.append({
        event: "mcp.tool_result",
        actor: subject.id,
        actorType,
        subject: `${server}/${tool}`,
        attributes: {
          server,
          tool,
          outcome: result.ok ? "ok" : "error",
          durationMs: Math.round(durationMs),
          ...(result.ok ? {} : { code: result.code }),
          contentDigest: resultDigest.sha256,
          contentBytes: resultDigest.bytes,
        },
      });
    } catch (err) {
      // Best-effort AFTER audit, mirroring the runtime's own auth login/logout
      // pattern (specs/phase-2-contracts.md §2): the call already happened and
      // its result is already determined, so we surface the real result rather
      // than discard it — but never silently pretend the append succeeded.
      // No `logger` seam exists in this function's contracted signature
      // (specs/phase-2-contracts.md §5); console.error is the fallback so
      // the failure is never silently swallowed.
      console.error(`@openrupiv/mcp: failed to append mcp.tool_result audit record: ${errMessage(err)}`);
    }

    return result;
  }

  async function listTools(server: string): Promise<{ name: string; description?: string }[]> {
    const entry = servers.get(server);
    if (!entry) {
      throw new Error(`unknown MCP server "${server}"`);
    }
    const conn = await getConnection(entry);
    if (!conn.ok) {
      throw new Error(conn.message);
    }
    const listed = await conn.client.listTools();
    const allowed = new Set(entry.allowedTools);
    return listed.tools
      .filter((t) => allowed.has(t.name))
      .map((t) => (t.description !== undefined ? { name: t.name, description: t.description } : { name: t.name }));
  }

  async function close(): Promise<void> {
    for (const conn of connections.values()) {
      await conn.client.close().catch(() => {});
    }
    connections.clear();
  }

  return { callTool, listTools, close };
}

/** Best-effort extraction of a human-readable message from an error tool-result's content blocks. */
function extractErrorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is { type: string; text?: unknown } => !!block && typeof block === "object")
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : undefined))
    .filter((t): t is string => t !== undefined);
  return texts.length > 0 ? texts.join("\n") : undefined;
}
