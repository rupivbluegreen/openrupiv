/**
 * Audit record types. The audit log is append-only and tamper-evident: there
 * is deliberately no update or delete anywhere in these types, the store API,
 * or the SQL. Each record chains to its predecessor by hash (see chain.ts).
 */

export type ActorType = "human" | "agent" | "system";

export interface AuditRecordInput {
  /** Dotted event name, e.g. "auth.login", "workflow.transition". */
  event: string;
  /** Actor identity: OIDC sub, agent id, or "system". */
  actor: string;
  actorType: ActorType;
  /** Optional subject acted on, e.g. "vendor_application:<uuid>". */
  subject?: string;
  /** Decision context when this records a policy-gated action. */
  decision?: "allow" | "deny";
  /** Structured detail. MUST NOT contain secrets/tokens (scrubbed on append). */
  attributes?: Record<string, unknown>;
}

/** The hashed body of a record: everything except its own hash. */
export interface AuditRecordBody extends AuditRecordInput {
  /** Monotonic 1-based sequence within the chain. */
  seq: number;
  /** RFC3339 UTC timestamp (injected — never read from a wall clock in pure code). */
  timestamp: string;
  /** Previous record's hash; the genesis record uses GENESIS_HASH. */
  prevHash: string;
}

export interface AuditRecord extends AuditRecordBody {
  /** sha256 over canonicalize(body). */
  hash: string;
}

export type VerifyResult =
  | { ok: true; count: number }
  | {
      ok: false;
      /** seq of the first record that failed verification. */
      failedSeq: number;
      reason: "hash_mismatch" | "chain_break" | "seq_gap" | "bad_genesis";
    };
