/**
 * A real, in-process MCP server used as the "remote" peer for
 * `@openrupiv/mcp`'s client tests, speaking the actual MCP wire protocol
 * over the SDK's `InMemoryTransport.createLinkedPair()` — no real network,
 * no external process. Built on the SDK's low-level `Server` class (the
 * same package the client under test uses), NOT on our own hand-rolled
 * inbound dispatcher (`src/server.ts`), so the client is exercised against
 * an independent, spec-faithful peer.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type FakeToolHandler = (args: Record<string, unknown>) => {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface FakeMcpServerOptions {
  tools?: Record<string, FakeToolHandler>;
  /** Force the `initialize` response to negotiate this exact revision (for testing version pinning). */
  protocolVersionOverride?: string;
}

export interface FakeMcpServer {
  /** The client-side half of the in-memory linked pair — hand this to a test's `TransportBuilder`. */
  clientTransport: Transport;
  close(): Promise<void>;
}

const defaultTools: Record<string, FakeToolHandler> = {
  echo: (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
  boom: () => ({ content: [{ type: "text", text: "tool exploded" }], isError: true }),
};

export async function startFakeMcpServer(opts: FakeMcpServerOptions = {}): Promise<FakeMcpServer> {
  const server = new Server({ name: "fake-remote-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const tools = opts.tools ?? defaultTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.keys(tools).map((name) => ({ name, inputSchema: { type: "object" as const } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = tools[request.params.name];
    if (!handler) {
      throw new Error(`fake MCP server: unknown tool "${request.params.name}"`);
    }
    return handler((request.params.arguments as Record<string, unknown> | undefined) ?? {});
  });

  if (opts.protocolVersionOverride) {
    const forcedVersion = opts.protocolVersionOverride;
    server.setRequestHandler(InitializeRequestSchema, async () => ({
      protocolVersion: forcedVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-remote-mcp", version: "1.0.0" },
    }));
  }

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    clientTransport,
    close: async () => {
      await server.close();
    },
  };
}
