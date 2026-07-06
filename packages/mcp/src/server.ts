/**
 * MCP server — platform capabilities exposed as MCP tools over `POST /mcp`
 * (Streamable HTTP, JSON responses only — no SSE/streaming; v0.2's supported
 * methods (`initialize`, `tools/list`, `tools/call`) all complete
 * synchronously, and resources/prompts/sampling/elicitation/tasks are OUT
 * per specs/phase-2-contracts.md §5). Deny-by-default: no valid bearer token
 * -> 401, including for `tools/list`.
 *
 * DESIGN NOTE — why this is a small hand-rolled JSON-RPC dispatcher instead
 * of the SDK's `Server` + `StreamableHTTPServerTransport`: that transport is
 * fundamentally session/SSE-oriented (its own doc comments: a *stateless*
 * transport instance "cannot be reused across requests — create a new
 * transport per request", and its session/protocol-version validation uses
 * the SDK's own broader `SUPPORTED_PROTOCOL_VERSIONS`, not this contract's
 * narrower `SUPPORTED_MCP_REVISIONS`). Every inbound request here must be
 * independently re-authenticated to a `PolicySubject` and `tools/list` must
 * be filtered per that subject — properties that don't fit the SDK's
 * session-caching `Server` class cleanly. The wire-level JSON-RPC 2.0 +
 * MCP method shapes (`initialize`, `tools/list`, `tools/call`) are still
 * hand-implemented to the pinned revision's spec, just not through the SDK's
 * session machinery. See the package README for the full rationale.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditRecordInput } from "@openrupiv/audit";
import type { PolicySubject } from "@openrupiv/policy";
import { digestValue } from "./digest";
import { SUPPORTED_MCP_REVISIONS, type ExposedCapability, type RegisterMcpServerOptions } from "./types";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface JsonRpcRequestLike {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isJsonRpcRequest(body: unknown): body is { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as JsonRpcRequestLike;
  return b.jsonrpc === "2.0" && typeof b.method === "string";
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function toCallToolResult(output: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  const isStructured = !!output && typeof output === "object" && !Array.isArray(output);
  return {
    content: [{ type: "text", text }],
    ...(isStructured ? { structuredContent: output as Record<string, unknown> } : {}),
  };
}

function toErrorCallToolResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Mounts the MCP inbound surface as `POST /mcp` on the given Fastify
 * instance/plugin scope. See the package README for exactly how the runtime
 * is expected to call this (the absolute path this registers, and why).
 */
export function registerMcpServer(app: FastifyInstance, opts: RegisterMcpServerOptions): void {
  const capsByName = new Map<string, ExposedCapability>(opts.capabilities.map((c) => [c.name, c]));

  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request.headers.authorization);
    const body = request.body;
    const requestId: string | number | null =
      body && typeof body === "object" && !Array.isArray(body) && "id" in body
        ? ((body as JsonRpcRequestLike).id as string | number | null)
        : null;

    let subject: PolicySubject | null = null;
    if (bearer) {
      subject = await opts.verifyToken(bearer);
    }
    if (!subject) {
      await safeAudit(opts, {
        event: "mcp.serve_rejected",
        actor: "system",
        actorType: "system",
        attributes: { reason: bearer ? "invalid_token" : "missing_token", channel: "mcp" },
      });
      reply.code(401);
      return reply.send(jsonRpcError(requestId, -32001, "Unauthorized"));
    }

    if (!isJsonRpcRequest(body)) {
      reply.code(400);
      return reply.send(jsonRpcError(null, -32600, "Invalid Request"));
    }

    const id = body.id ?? null;

    switch (body.method) {
      case "initialize":
        return handleInitialize(body.params, id, subject, opts, reply);
      case "notifications/initialized":
        reply.code(202);
        return reply.send();
      case "tools/list":
        return handleToolsList(id, subject, opts, reply, capsByName);
      case "tools/call":
        return handleToolsCall(body.params, id, subject, opts, reply, capsByName);
      default:
        reply.code(200);
        return reply.send(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
    }
  });
}

async function safeAudit(
  opts: RegisterMcpServerOptions,
  input: AuditRecordInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await opts.audit.append(input);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errMessage(err) };
  }
}

async function handleInitialize(
  params: unknown,
  id: string | number | null,
  subject: PolicySubject,
  opts: RegisterMcpServerOptions,
  reply: FastifyReply,
) {
  const requestedVersion =
    params && typeof params === "object" && "protocolVersion" in params
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;

  const supported = typeof requestedVersion === "string" && (SUPPORTED_MCP_REVISIONS as readonly string[]).includes(requestedVersion);
  if (!supported) {
    await safeAudit(opts, {
      event: "mcp.serve_rejected",
      actor: subject.id,
      actorType: "human",
      attributes: {
        reason: "unsupported_protocol_version",
        channel: "mcp",
        requestedVersion: typeof requestedVersion === "string" ? requestedVersion : String(requestedVersion),
      },
    });
    reply.code(400);
    return reply.send(
      jsonRpcError(id, -32000, `Unsupported protocol version: ${String(requestedVersion)}`, { code: "ERR_MCP_PROTOCOL" }),
    );
  }

  reply.code(200);
  return reply.send(
    jsonRpcResult(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "openrupiv-mcp-server", version: "0.1.0" },
    }),
  );
}

/**
 * Returns only capabilities the authenticated subject would actually be
 * allowed to call — each capability's own policy check runs BEFORE it is
 * included, not just before the eventual `tools/call`. This filtering pass
 * is deliberately NOT itself audited as `mcp.serve_call`/`mcp.serve_result`:
 * those events model an actual dispatch (see `handleToolsCall`), and
 * auditing every capability on every `tools/list` poll would be audit-log
 * noise for a read-only listing operation, not a governed action in its own
 * right. (Flagged in the implementation report as a judgment call.)
 */
async function handleToolsList(
  id: string | number | null,
  subject: PolicySubject,
  opts: RegisterMcpServerOptions,
  reply: FastifyReply,
  capsByName: Map<string, ExposedCapability>,
) {
  const visible: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const cap of capsByName.values()) {
    const decision = await opts.policy.decide({
      subject,
      action: `mcp.serve:${cap.name}`,
      resource: { type: "mcp.capability", id: cap.name, allowedRoles: cap.allowedRoles },
    });
    if (decision.allow) {
      visible.push({ name: cap.name, description: cap.description, inputSchema: cap.inputSchema });
    }
  }
  reply.code(200);
  return reply.send(jsonRpcResult(id, { tools: visible }));
}

async function handleToolsCall(
  params: unknown,
  id: string | number | null,
  subject: PolicySubject,
  opts: RegisterMcpServerOptions,
  reply: FastifyReply,
  capsByName: Map<string, ExposedCapability>,
) {
  const p = params && typeof params === "object" ? (params as { name?: unknown; arguments?: unknown }) : {};
  const name = typeof p.name === "string" ? p.name : undefined;
  const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};

  const cap = name ? capsByName.get(name) : undefined;

  if (!name || !cap) {
    const audited = await safeAudit(opts, {
      event: "mcp.serve_call",
      actor: subject.id,
      actorType: "human",
      subject: name ?? "unknown",
      decision: "deny",
      attributes: { capability: name ?? "unknown", code: "capability_unknown", channel: "mcp" },
    });
    if (!audited.ok) {
      reply.code(500);
      return reply.send(jsonRpcError(id, -32000, "Internal error: audit unavailable", { code: "ERR_MCP_AUDIT_UNAVAILABLE" }));
    }
    reply.code(200);
    return reply.send(jsonRpcError(id, -32602, `Unknown tool: ${String(name)}`));
  }

  const decision = await opts.policy.decide({
    subject,
    action: `mcp.serve:${cap.name}`,
    resource: { type: "mcp.capability", id: cap.name, allowedRoles: cap.allowedRoles },
  });

  const argsDigest = digestValue(args);
  const audited = await safeAudit(opts, {
    event: "mcp.serve_call",
    actor: subject.id,
    actorType: "human",
    subject: cap.name,
    decision: decision.allow ? "allow" : "deny",
    attributes: {
      capability: cap.name,
      action: `mcp.serve:${cap.name}`,
      channel: "mcp",
      ...(decision.allow ? {} : { reason: decision.reason }),
      argsDigest: argsDigest.sha256,
      argsBytes: argsDigest.bytes,
    },
  });
  if (!audited.ok) {
    reply.code(500);
    return reply.send(jsonRpcError(id, -32000, "Internal error: audit unavailable", { code: "ERR_MCP_AUDIT_UNAVAILABLE" }));
  }

  if (!decision.allow) {
    reply.code(200);
    return reply.send(jsonRpcError(id, -32001, `Forbidden: ${decision.reason}`, { code: "ERR_MCP_POLICY_DENIED" }));
  }

  const started = performance.now();
  let outcome: "ok" | "error";
  let output: unknown;
  let errorText: string | undefined;
  try {
    output = await cap.handler(args, subject);
    outcome = "ok";
  } catch (err) {
    outcome = "error";
    errorText = errMessage(err);
  }
  const durationMs = performance.now() - started;

  const contentDigest = digestValue(outcome === "ok" ? output : { message: errorText });
  const afterResult = await safeAudit(opts, {
    event: "mcp.serve_result",
    actor: subject.id,
    actorType: "human",
    subject: cap.name,
    attributes: {
      capability: cap.name,
      channel: "mcp",
      outcome,
      durationMs: Math.round(durationMs),
      contentDigest: contentDigest.sha256,
      contentBytes: contentDigest.bytes,
    },
  });
  if (!afterResult.ok) {
    // Best-effort AFTER audit: the handler already ran and produced a real
    // result, so we surface it rather than discard it — mirroring the
    // client-side `mcp.tool_result` best-effort behavior.
    console.error(`@openrupiv/mcp: failed to append mcp.serve_result audit record: ${afterResult.message}`);
  }

  reply.code(200);
  if (outcome === "ok") {
    return reply.send(jsonRpcResult(id, toCallToolResult(output)));
  }
  return reply.send(jsonRpcResult(id, toErrorCallToolResult(errorText ?? "tool execution failed")));
}
