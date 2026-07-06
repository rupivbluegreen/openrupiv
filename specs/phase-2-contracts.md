# Phase 2 — cross-package contracts

> Binding interface contracts for Phase 2 packages, built in dependency
> order. Same rules as `specs/phase-1-contracts.md`: implement your side
> exactly; consume others as written; changing this file means stopping and
> flagging. Audit-log integrity and the agent sandbox are human-only review
> paths (CLAUDE.md).

## 1. `@openrupiv/audit` — hash-chained tamper-evident audit log

The substrate every other Phase 2 component records into. Append-only. No
update or delete exists anywhere in the API, schema, or SQL.

```ts
export interface AuditRecordInput {
  /** Dotted event name, e.g. "auth.login", "workflow.transition". */
  event: string;
  /** Actor identity: OIDC sub, agent id, or "system". */
  actor: string;
  actorType: "human" | "agent" | "system";
  /** Optional subject the event acts on, e.g. "vendor_application:<uuid>". */
  subject?: string;
  /** Decision context when this records a policy-gated action. */
  decision?: "allow" | "deny";
  /** Arbitrary structured detail; MUST NOT contain secrets/tokens. */
  attributes?: Record<string, unknown>;
}

export interface AuditRecord extends AuditRecordInput {
  /** Monotonic 1-based sequence within the chain. */
  seq: number;
  /** RFC3339 UTC timestamp (injected, never read from wall clock in pure code). */
  timestamp: string;
  /** sha256 of the previous record's hash + this record's canonical body. */
  hash: string;
  /** Previous record's hash; genesis uses GENESIS_HASH. */
  prevHash: string;
}

export const GENESIS_HASH: string; // 64 zeros

/** Canonical serialization used for hashing — stable key order, no whitespace. */
export function canonicalize(record: Omit<AuditRecord, "hash">): string;
export function hashRecord(prevHash: string, body: Omit<AuditRecord, "hash" | "prevHash">): string;

/** Pure chain builder: fold inputs into a verifiable chain given a clock. */
export function appendRecord(
  prev: AuditRecord | null,
  input: AuditRecordInput,
  timestamp: string,
): AuditRecord;

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; failedSeq: number; reason: "hash_mismatch" | "chain_break" | "seq_gap" | "bad_genesis" };

/** Verify a full chain: recompute every hash, check linkage, seq monotonicity. */
export function verifyChain(records: AuditRecord[]): VerifyResult;

/** Postgres-backed append-only store (used by the runtime). */
export interface AuditStore {
  append(input: AuditRecordInput): Promise<AuditRecord>;
  /** Read a page in seq order (for verification/export). No mutation methods exist. */
  read(opts?: { fromSeq?: number; limit?: number }): Promise<AuditRecord[]>;
  verify(): Promise<VerifyResult>;
}
export function createAuditStore(db: Queryable, opts?: { clock?: () => string }): AuditStore;

/** SIEM export. */
export function toOtlpLogRecords(records: AuditRecord[]): unknown; // OTLP logs JSON structure
export function toSyslog(records: AuditRecord[]): string[];        // RFC 5424 lines
export function toJsonl(records: AuditRecord[]): string;           // one JSON object per line
```

- The pure functions (`appendRecord`, `verifyChain`, `hashRecord`,
  `canonicalize`, exporters) take no clock/IO and are exhaustively unit
  tested including every tamper mode (mutate a field, drop a record, reorder,
  insert, forge genesis).
- SQL: table `audit_log(seq bigserial primary key, timestamp timestamptz not
  null, event text not null, actor text not null, actor_type text not null,
  subject text, decision text, attributes jsonb not null default '{}',
  prev_hash char(64) not null, hash char(64) not null unique)`. Append uses a
  transaction that locks the last row (`SELECT ... ORDER BY seq DESC LIMIT 1
  FOR UPDATE`) so concurrent appends can't fork the chain. Migration ships in
  the package and is applied by the runtime's infra-table step.
- `attributes` redaction is the caller's responsibility, but `append` runs a
  defense-in-depth scrubber that drops keys named like secrets
  (`/pass|secret|token|authorization|cookie|key/i`) and logs a warning; unit
  tested.

## 2. Runtime wiring (`@openrupiv/runtime`)

- `createServer`/`serveAppDir` gain an optional `auditStore` dep (default:
  `createAuditStore(db)`); when present, these events append to it in the
  SAME transaction as their side effect where one exists (workflow
  transitions, approvals), or best-effort with an error log where none does
  (auth login/logout/session-reject):
  `auth.login`, `auth.logout`, `auth.session_rejected`,
  `auth.dev_role_grant`, `workflow.transition`, `workflow.approval_recorded`,
  `workflow.duplicate_approver`, `workflow.state_write_rejected`.
- New route `GET /admin/audit` (authenticated; requires the `audit.read`
  permission once RBAC lands): returns a verified page of the chain +
  overall `verify()` status. New `GET /admin/audit/export?format=jsonl|otlp|syslog`.
- Appending to the audit log must never silently fail: if the append errors,
  the request fails closed (5xx) for transactional events; for
  best-effort auth events it logs at error level with the event preserved.

## 3. `@openrupiv/policy` — PDP (contract stubbed; full spec when audit lands)

Deny-by-default decision API the runtime calls before privileged actions.
Embedding approach (sidecar vs WASM) is an ADR to be written before build.
Placeholder so downstream packages can import the type:

```ts
export interface PolicyInput { subject: { id: string; roles: string[] }; action: string; resource: string; context?: Record<string, unknown>; }
export interface PolicyDecision { allow: boolean; reason: string; policyId?: string; }
export interface PolicyEngine { decide(input: PolicyInput): Promise<PolicyDecision>; }
```

## Package skeletons

`@openrupiv/audit` ships dependency-complete (no new runtime deps beyond
`pg`, already in the workspace; hashing via node:crypto). Policy/agents/mcp
skeletons are added when their build stages start, each with an ADR for the
load-bearing design choice (OPA embedding; sandbox technology).
