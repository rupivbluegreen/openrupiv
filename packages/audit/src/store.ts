/**
 * Postgres-backed append-only audit store. Concurrency safety: every append
 * first takes a FIXED advisory transaction lock (`pg_advisory_xact_lock`),
 * then reads the chain tail via `SELECT ... FOR UPDATE`. There is no update
 * or delete method — the store cannot mutate history, by construction.
 *
 * Why the advisory lock, and not just the tail row lock: under READ
 * COMMITTED, `SELECT ... ORDER BY seq DESC LIMIT 1 FOR UPDATE` identifies and
 * locks ONE SPECIFIC ROW (the current tail) before returning it. A second,
 * concurrent append blocks trying to lock that SAME row. The first append
 * does not modify that row — it INSERTs a brand-new one — so when the first
 * commits and releases the row lock, the second transaction's blocked
 * statement simply resumes with the SAME (now-stale) row it was already
 * holding onto; Postgres has no reason to re-run the ORDER BY/LIMIT scan
 * (EvalPlanQual re-checks only apply to rows that were themselves updated
 * out from under the waiter, which never happens here). The result: both
 * transactions compute the same "next seq"/prevHash and the second's INSERT
 * collides on the seq PRIMARY KEY / hash UNIQUE constraint — confirmed by a
 * live-Postgres repro (see test/store.live.test.ts).
 *
 * `pg_advisory_xact_lock` sidesteps this: a waiter blocks on lock
 * acquisition itself (not on a specific row), and once granted — after the
 * holder's transaction ends — its OWN subsequent `SELECT` is a fresh
 * statement that (under READ COMMITTED) sees everything the holder
 * committed, including the new tail row.
 */

import { appendRecord, scrubAttributes, verifyChain } from "./chain";
import type { AuditRecord, AuditRecordInput, VerifyResult } from "./types";

/** Minimal query seam so tests inject a fake and the runtime passes node-postgres. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface Txn extends Queryable {}
export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
}
export interface PoolClient extends Queryable {
  release(): void;
}

export interface AuditStore {
  append(input: AuditRecordInput): Promise<AuditRecord>;
  read(opts?: { fromSeq?: number; limit?: number }): Promise<AuditRecord[]>;
  verify(): Promise<VerifyResult>;
}

export interface AppendOptions {
  /** Injected clock returning an RFC3339 UTC string; defaults to real time. */
  clock?: () => string;
  /** Called when the defensive scrubber removes secret-looking keys. */
  onScrub?: (event: string, keys: string[]) => void;
}
export type AuditStoreOptions = AppendOptions;

const COLUMNS =
  "seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash";

const SELECT_TAIL = `SELECT ${COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE`;
const INSERT_RECORD = `INSERT INTO audit_log (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;

/**
 * Fixed advisory-lock key serializing every append to this chain. The value
 * is arbitrary but must stay stable — changing it would let a process still
 * running the old value append concurrently with one running the new value,
 * silently reopening the race this lock exists to close. Comfortably inside
 * the safe-integer range so it round-trips through JS/pg without precision
 * loss; picked with no significance beyond "unlikely to collide with
 * unrelated advisory-lock use in the same database".
 */
export const AUDIT_CHAIN_LOCK_KEY = 847_293_017_734;
const LOCK_CHAIN_TAIL = "SELECT pg_advisory_xact_lock($1)";

export function rowToRecord(row: unknown): AuditRecord {
  const r = row as Record<string, unknown>;
  const base = {
    seq: Number(r["seq"]),
    timestamp:
      r["timestamp"] instanceof Date
        ? (r["timestamp"] as Date).toISOString()
        : String(r["timestamp"]),
    event: String(r["event"]),
    actor: String(r["actor"]),
    actorType: String(r["actor_type"]) as AuditRecord["actorType"],
    attributes: (r["attributes"] as Record<string, unknown>) ?? {},
    prevHash: String(r["prev_hash"]),
    hash: String(r["hash"]),
  };
  return {
    ...base,
    ...(r["subject"] != null ? { subject: String(r["subject"]) } : {}),
    ...(r["decision"] != null ? { decision: String(r["decision"]) as "allow" | "deny" } : {}),
  };
}

function insertParams(record: AuditRecord): unknown[] {
  return [
    record.seq,
    record.timestamp,
    record.event,
    record.actor,
    record.actorType,
    record.subject ?? null,
    record.decision ?? null,
    JSON.stringify(record.attributes),
    record.prevHash,
    record.hash,
  ];
}

/**
 * Append one record using an EXISTING transaction/connection (`tx`). Does not
 * BEGIN/COMMIT — the caller's transaction owns that, so the audit record and
 * the caller's side effect commit or roll back atomically together.
 *
 * Concurrency: first acquires the fixed advisory transaction lock
 * (`AUDIT_CHAIN_LOCK_KEY`), released automatically at COMMIT/ROLLBACK, THEN
 * reads and locks the chain tail. Both `append()` below and every
 * `appendInTransaction` caller (e.g. the runtime's in-transaction workflow
 * events) go through this one function, so the lock covers the whole append
 * path regardless of entry point. See the module doc comment for why the
 * tail row lock alone is not sufficient.
 */
export async function appendInTransaction(
  tx: Queryable,
  input: AuditRecordInput,
  opts: AppendOptions = {},
): Promise<AuditRecord> {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const { attributes, scrubbed } = scrubAttributes(input.attributes);
  if (scrubbed.length > 0) opts.onScrub?.(input.event, scrubbed);
  await tx.query(LOCK_CHAIN_TAIL, [AUDIT_CHAIN_LOCK_KEY]);
  const tail = await tx.query(SELECT_TAIL);
  const prev = tail.rows.length > 0 ? rowToRecord(tail.rows[0]) : null;
  const record = appendRecord(prev, { ...input, attributes }, clock());
  await tx.query(INSERT_RECORD, insertParams(record));
  return record;
}

export function createAuditStore(pool: Pool, opts: AuditStoreOptions = {}): AuditStore {
  return {
    async append(input: AuditRecordInput): Promise<AuditRecord> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const record = await appendInTransaction(client, input, opts);
        await client.query("COMMIT");
        return record;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async read(opts2: { fromSeq?: number; limit?: number } = {}): Promise<AuditRecord[]> {
      const from = opts2.fromSeq ?? 1;
      const limit = opts2.limit ?? 1000;
      const res = await pool.query(
        `SELECT ${COLUMNS} FROM audit_log WHERE seq >= $1 ORDER BY seq ASC LIMIT $2`,
        [from, limit],
      );
      return res.rows.map(rowToRecord);
    },

    async verify(): Promise<VerifyResult> {
      let fromSeq = 1;
      const page = 5000;
      let all: AuditRecord[] = [];
      for (;;) {
        const res = await pool.query(
          `SELECT ${COLUMNS} FROM audit_log WHERE seq >= $1 ORDER BY seq ASC LIMIT $2`,
          [fromSeq, page],
        );
        if (res.rows.length === 0) break;
        all = all.concat(res.rows.map(rowToRecord));
        if (res.rows.length < page) break;
        fromSeq = all[all.length - 1]!.seq + 1;
      }
      return verifyChain(all);
    },
  };
}
