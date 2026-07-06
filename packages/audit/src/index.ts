/**
 * @openrupiv/audit — hash-chained, tamper-evident, append-only audit log.
 * Contract: specs/phase-2-contracts.md §1. Append-only by construction:
 * no update or delete exists in this package's API, types, or SQL.
 */

export type {
  ActorType,
  AuditRecord,
  AuditRecordBody,
  AuditRecordInput,
  VerifyResult,
} from "./types";
export {
  GENESIS_HASH,
  REDACTED,
  appendRecord,
  canonicalize,
  hashRecord,
  scrubAttributes,
  verifyChain,
} from "./chain";
export { toJsonl, toOtlpLogRecords, toSyslog } from "./export";
export {
  appendInTransaction,
  createAuditStore,
  rowToRecord,
  type AppendOptions,
  type AuditStore,
  type AuditStoreOptions,
  type Pool,
  type PoolClient,
  type Queryable,
  type Txn,
} from "./store";
export { AUDIT_LOG_DDL } from "./migration";
