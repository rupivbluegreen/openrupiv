/**
 * @openrupiv/mcp — MCP client + MCP server. Contract: specs/phase-2-contracts.md
 * §5. See the package README for the full design rationale (in-memory test
 * transport, hand-rolled inbound JSON-RPC dispatcher, redirect guard, digest
 * pattern) and for how the runtime is expected to call `registerMcpServer`.
 */

export {
  MCP_PROTOCOL_REVISION,
  SUPPORTED_MCP_REVISIONS,
  type ExposedCapability,
  type McpCallResult,
  type McpClient,
  type McpClientConfig,
  type McpClientDeps,
  type McpErrorCode,
  type McpServerEntry,
  type McpTransport,
  type RegisterMcpServerOptions,
} from "./types";

export { createMcpClient, createMcpClientWithTransportBuilder, makeSafeFetch, type TransportBuilder } from "./client";
export { registerMcpServer } from "./server";
export { canonicalJson, digestValue, type ValueDigest } from "./digest";
