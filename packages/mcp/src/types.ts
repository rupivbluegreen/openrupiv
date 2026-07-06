/**
 * @openrupiv/mcp — MCP client + MCP server. Contract: specs/phase-2-contracts.md
 * §5. Both directions speak MCP revision `2025-11-25` (current stable) only;
 * tools are the only MCP primitive in v0.2. Deny-by-default in both
 * directions: no config -> no egress; no token -> no service.
 */

import type { FastifyInstance } from "fastify";
import type { ActorType, AuditStore } from "@openrupiv/audit";
import type { PolicyEngine, PolicySubject } from "@openrupiv/policy";

/** Offered by the client and by the server on `initialize`. */
export const MCP_PROTOCOL_REVISION = "2025-11-25";

/**
 * Revisions accepted in negotiation, in EITHER direction. Extending this
 * list is a contract change (specs/phase-2-contracts.md §5, open question 10).
 */
export const SUPPORTED_MCP_REVISIONS: readonly ["2025-11-25", "2025-06-18"] = [
  "2025-11-25",
  "2025-06-18",
];

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | {
      kind: "http"; // Streamable HTTP per the pinned revision
      url: string;
      /** Token by env-var NAME only — secret values never appear in config. */
      auth?: { kind: "bearer"; tokenEnv: string };
    };

export interface McpServerEntry {
  /** Connector name, kebab-case, unique. */
  name: string;
  transport: McpTransport;
  /**
   * Tools callable on this server. Deny-by-default: empty = NOTHING callable
   * (deliberately the OPPOSITE of PolicyResource.allowedRoles semantics).
   */
  allowedTools: string[];
}

export interface McpClientConfig {
  servers: McpServerEntry[];
}

export type McpErrorCode =
  | "ERR_MCP_SERVER_UNKNOWN" // server not in the allowlist
  | "ERR_MCP_TOOL_NOT_ALLOWED" // tool not in the server's allowedTools
  | "ERR_MCP_POLICY_DENIED"
  | "ERR_MCP_PROTOCOL" // negotiation failed / unsupported revision
  | "ERR_MCP_UPSTREAM" // upstream error or transport failure
  | "ERR_MCP_AUDIT_UNAVAILABLE"; // audit append failed -> call NOT made

export type McpCallResult =
  | { ok: true; content: unknown } // MCP tool-result content, pinned revision
  | { ok: false; code: McpErrorCode; message: string };

export interface McpClient {
  callTool(opts: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    /** On-behalf-of identity for policy + audit: human sub or agent id. */
    subject: PolicySubject;
    actorType: ActorType;
  }): Promise<McpCallResult>;
  listTools(server: string): Promise<{ name: string; description?: string }[]>;
  close(): Promise<void>;
}

export interface McpClientDeps {
  policy: PolicyEngine;
  audit: AuditStore;
}

/** A platform capability exposed as an MCP tool. */
export interface ExposedCapability {
  /** MCP tool name, kebab-case, unique. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema draft 2020-12
  /** Policy v0.2 semantics: empty = any authenticated subject. */
  allowedRoles: string[];
  handler(args: Record<string, unknown>, subject: PolicySubject): Promise<unknown>;
}

export interface RegisterMcpServerOptions {
  capabilities: ExposedCapability[];
  policy: PolicyEngine;
  audit: AuditStore;
  /** Resolve a bearer token against the platform OIDC issuer; null = 401. */
  verifyToken(bearer: string): Promise<PolicySubject | null>;
}

/** Re-exported for callers that want the type without importing fastify directly. */
export type { FastifyInstance };
