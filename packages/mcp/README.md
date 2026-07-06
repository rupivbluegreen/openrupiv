# @openrupiv/mcp

MCP client + MCP server. Contract: `specs/phase-2-contracts.md` §5. Both
directions speak MCP revision **`2025-11-25`** (current stable); tools are
the only MCP primitive in v0.2 — resources, prompts, sampling, elicitation,
and MCP tasks are all OUT. Deny-by-default in both directions: **no config →
no egress; no token → no service.**

## Guarantees

- **Client egress is static.** `createMcpClient` connects ONLY to the
  servers present in the `McpClientConfig` it's given, resolved once at call
  time — no dynamic registration, no discovery. An unknown server name is
  `ERR_MCP_SERVER_UNKNOWN`, before any wire attempt.
- **Outbound enforcement order, fails closed:** server allowlist → tool
  allowlist (`server.allowedTools`, empty = nothing callable) →
  `policy.decide` → audit `mcp.tool_call` (with `decision`) BEFORE the wire
  call — **an audit-append failure here means the call is NOT made**
  (`ERR_MCP_AUDIT_UNAVAILABLE`) — → invoke via the MCP SDK client → audit
  `mcp.tool_result` AFTER (outcome, `durationMs`, digests — never raw
  args/content).
- **Version pinning, both directions.** `MCP_PROTOCOL_REVISION` is offered
  on `initialize`; a negotiated revision outside `SUPPORTED_MCP_REVISIONS`
  (`"2025-11-25" | "2025-06-18"`) is rejected as `ERR_MCP_PROTOCOL` — see
  "Version pinning" below for exactly how, since the SDK's own version check
  uses a broader list than this contract accepts.
- **Secrets never touch config, logs, or audit.** An HTTP connector's bearer
  token is named by an env var (`tokenEnv`) in config; the actual value is
  resolved from `process.env` fresh on every outbound HTTP call, never
  cached, never logged, never placed in an audit attribute.
- **Inbound: nothing is served anonymously**, including `tools/list` — every
  request needs a valid bearer token (`verifyToken`), and the tool list
  itself is filtered to only the capabilities the authenticated subject's
  own policy check allows.
- **Digest, not raw values.** Every audit record this package writes carries
  a sha256 digest + byte size of tool args/content/output — never the raw
  value — mirroring the pattern used for policy-gated audit elsewhere in the
  platform (`@openrupiv/agents`, `workflows.ts`).

## Surface

```ts
import {
  MCP_PROTOCOL_REVISION, SUPPORTED_MCP_REVISIONS,
  createMcpClient, registerMcpServer,
} from "@openrupiv/mcp";
```

See `src/types.ts` for the full contract types (`McpTransport`,
`McpServerEntry`, `McpClientConfig`, `McpErrorCode`, `McpCallResult`,
`McpClient`, `ExposedCapability`). They are implemented verbatim from
`specs/phase-2-contracts.md` §5.

## Client usage

```ts
import { createMcpClient } from "@openrupiv/mcp";

const mcp = await createMcpClient(
  { servers: [
      { name: "github", transport: { kind: "http", url: "https://mcp.github.example/mcp",
          auth: { kind: "bearer", tokenEnv: "GITHUB_MCP_TOKEN" } },
        allowedTools: ["search_issues"] },
  ] },
  { policy, audit },
);

const result = await mcp.callTool({
  server: "github", tool: "search_issues", args: { q: "is:open" },
  subject: { id: sub, roles }, actorType: "human",
});
// { ok: true, content } | { ok: false, code: McpErrorCode, message }
```

`config.servers` is expected to come from the runtime's `MCP_SERVERS_CONFIG`
env var (a path to a JSON file matching `McpClientConfig`); absent → pass
`{ servers: [] }` and the client is fully inert (every `callTool` call
resolves to `ERR_MCP_SERVER_UNKNOWN`). Loading/parsing that file is the
runtime's job, not this package's — `createMcpClient` just takes the parsed
config object.

## Server usage — mounting `POST /mcp`

`registerMcpServer(app, opts)` registers a route at the **literal absolute
path `/mcp`** on whatever `FastifyInstance` (or plugin scope) it is given —
it does not add its own prefix and does not assume it owns the whole app.
Call it directly on the runtime's top-level Fastify instance:

```ts
import { registerMcpServer } from "@openrupiv/mcp";

registerMcpServer(app, {
  capabilities: [/* ExposedCapability[] — see "What this package does NOT do" */],
  policy,
  audit,
  async verifyToken(bearer) {
    // Validate `bearer` against the platform's OIDC issuer, per the pinned
    // revision's authorization spec (OAuth 2.1 resource server), and map it
    // to a PolicySubject. Return null for anything invalid/expired -> 401.
  },
});
```

**Do not** wrap this call in `app.register(plugin, { prefix: "/mcp" })` —
that would mount the route at `/mcp/mcp`. If the runtime's architecture
needs the route registered inside a sub-plugin scope for encapsulation
(shared `onRequest` hooks, etc.), register that sub-plugin with **no
prefix** (or prefix `"/"`), so the literal path stays `/mcp`.

The server always responds with a single JSON body (`Content-Type:
application/json`) — never an SSE stream. v0.2's three supported methods
(`initialize`, `tools/list`, `tools/call`) all complete synchronously, so
there is nothing that needs push/streaming semantics.

## Design decisions worth knowing before touching this code

**Why the inbound server is a small hand-rolled JSON-RPC dispatcher, not the
SDK's `Server` + `StreamableHTTPServerTransport`.** That transport is
fundamentally session/SSE-oriented: its own doc comments say a *stateless*
transport instance "cannot be reused across requests — create a new
transport per request," and its session/protocol-version validation checks
against the SDK's own broader `SUPPORTED_PROTOCOL_VERSIONS`, not this
contract's narrower `SUPPORTED_MCP_REVISIONS`. Every request here must be
independently re-authenticated to a `PolicySubject`, and `tools/list` must
be filtered per that subject on every call — properties that don't fit the
SDK's session-caching `Server` class cleanly. `src/server.ts` still
implements the actual JSON-RPC 2.0 + MCP message shapes
(`initialize`/`tools/list`/`tools/call`) to the pinned revision by hand, just
not through the SDK's session machinery. The **outbound client** does use
the real SDK `Client` + transports, since a single persistent, one-directional
connection per configured server is exactly what the SDK is built for.

**Version pinning against a narrower list than the SDK's own.** The SDK's
`Client.connect()` already validates the negotiated `initialize` result
against its own `SUPPORTED_PROTOCOL_VERSIONS` (a strict superset of this
contract's `SUPPORTED_MCP_REVISIONS` — it additionally accepts
`2025-03-26`, `2024-11-05`, `2024-10-07`) and does not expose the negotiated
version through any public getter afterwards. We install our own
`setProtocolVersion` hook directly on the transport instance before
connecting — the SDK Client always calls
`transport.setProtocolVersion(result.protocolVersion)` right after a
successful handshake, whenever the transport defines that method — capture
the negotiated version there, and re-validate against our narrower list
after `connect()` resolves; an out-of-list version disconnects the client
and surfaces as `ERR_MCP_PROTOCOL`. Same idea inbound: `initialize` checks
the requested `protocolVersion` against `SUPPORTED_MCP_REVISIONS` directly
before responding.

**HTTP redirect safety.** The SDK's `StreamableHTTPClientTransport` doesn't
expose a "never follow cross-origin redirects" option. `makeSafeFetch`
(exported for testing) wraps `fetch` with `redirect: "manual"` and walks
same-origin redirects itself, throwing the moment a `Location` header points
at a different origin. This same wrapper is also where the bearer token
(named by `tokenEnv` in config) is resolved from `process.env` **fresh on
every call** — the config object itself never carries the secret value.

**`exactOptionalPropertyTypes` vs. the SDK's own types.** This workspace
compiles with `exactOptionalPropertyTypes: true`
(`tsconfig.base.json`). `@modelcontextprotocol/sdk`'s
`StreamableHTTPClientTransport` declares `get sessionId(): string |
undefined`, which does not structurally satisfy its own `Transport`
interface's `sessionId?: string` under that flag — reproducible with zero
lines of this package's own code (`skipLibCheck` doesn't suppress it,
because the failure is at our call site's argument-assignability check, not
inside the `.d.ts` file). A single `as Transport` cast at the one point we
hand an SDK transport instance to `Client.connect()` is the documented,
narrowly-scoped workaround; see the comment above `pinProtocolVersion` in
`src/client.ts`.

## What this package does NOT do

This is the **generic** client + server mechanism only. It implements zero
concrete `ExposedCapability` entries — wiring up a real one (e.g. read-only
workflow-instance status, proposed as the v0.2 capability in
`specs/phase-2-contracts.md`'s Open Questions §8) needs runtime internals
(the entity model, `Db`) and is a later wiring-stage concern, gated on
maintainer product sign-off per that section.

## Tests

```bash
pnpm --filter @openrupiv/mcp test
```

No real network and no external process is used anywhere in this suite:

- **Client tests** (`test/client.test.ts`) run against a real, independent
  MCP server built on the SDK's own low-level `Server` class, connected over
  `InMemoryTransport.createLinkedPair()` (`test/helpers/fakeMcpServer.ts`) —
  the SDK does ship an in-memory linked-transport pair for exactly this. The
  public `createMcpClient(config, deps)` signature is exercised unchanged;
  a second export, `createMcpClientWithTransportBuilder(config, deps,
  buildTransport)`, is a test-only seam that swaps only the raw-transport
  construction step (real `stdio`/`http` transports in production, the
  in-memory pair in tests) — every other behavior (enforcement order, audit
  ordering, digesting, protocol pinning) runs for real.
- **Server tests** (`test/server.test.ts`) use Fastify's `inject()`
  (in-process, no sockets) against a real app with `registerMcpServer`
  mounted.
- `test/helpers/fakes.ts` provides an in-memory `AuditStore` built on this
  package's own pure `appendRecord`/`verifyChain` (real hash-chain
  semantics, no Postgres) and a predicate-driven fake `PolicyEngine` — no
  live OPA/WASM bundle needed for these unit tests.

Covered: unknown server / disallowed tool / policy deny, each before any
wire attempt; audit-append failure before the call → `ERR_MCP_AUDIT_UNAVAILABLE`,
upstream never called; a full successful round trip with both audit records
present in order and digested (never raw) attributes; an upstream
`isError` tool result → `ERR_MCP_UPSTREAM`; an unsupported negotiated
protocol revision → `ERR_MCP_PROTOCOL`; connection reuse across calls;
`listTools` filtering to `allowedTools`; the HTTP redirect guard
(same-origin followed, cross-origin refused) and per-call token resolution;
inbound missing/invalid bearer → 401 + `mcp.serve_rejected`; inbound
protocol-version rejection; `tools/list` filtered per-subject; a full
inbound `tools/call` round trip with `mcp.serve_call`/`mcp.serve_result` in
order; inbound policy deny and audit-unavailable fail-closed behavior; and
an empty `McpClientConfig.servers` making the client fully inert.

The **live-interop path** (consuming ≥ 1 real external MCP server —
acceptance criterion 6 in the phase-2 spec) is explicitly a Compose e2e
concern, not this unit-test suite.
