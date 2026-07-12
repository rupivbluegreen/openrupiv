/**
 * Runtime wiring for the hash-chained audit log (@openrupiv/audit), per
 * specs/phase-2-contracts.md §2.
 *
 * `createDbAuditStore(db)` adapts the runtime's narrow `Db` seam to the audit
 * package's `AuditStore` contract. Each `append` runs in its own transaction
 * on its own pooled connection (`db.transaction` acquires one per call), so
 * events recorded through this store persist INDEPENDENTLY of any caller
 * transaction — exactly what rejection events (`workflow.duplicate_approver`,
 * `workflow.state_write_rejected`) and auth events need. Events that must be
 * atomic with a database side effect do NOT go through this store: they use
 * `appendInTransaction(tx, …)` inside the side effect's own transaction
 * (see workflows.ts).
 *
 * Failure posture (contract §2 — appends never silently fail):
 * - `appendOrFail`: the append error fails the request closed
 *   (`ERR_AUDIT_APPEND_FAILED`, 5xx) — used for workflow rejection events and
 *   policy-decision records.
 * - `appendAllOrFail`: like `appendOrFail`, but for a BATCH of independent
 *   events where one failure must never abandon the rest untraced (finding
 *   "flush-drops-later-events") — every event is attempted regardless of
 *   earlier failures, each failure is logged individually (reusing
 *   `appendOrFail`'s own error-log shape), and one `ERR_AUDIT_APPEND_FAILED`
 *   is thrown at the end if any failed.
 * - `auditBestEffort`: logs at error level with the event preserved and never
 *   throws — returns `true`/`false` so a caller MAY react to failure (a2a.ts
 *   fails its own request closed on a pre-dispatch append failure) but need
 *   not (auth.ts, which has no DB side effect to bind auth events to and
 *   must not let a broken audit database take down login/logout, ignores
 *   the return value).
 */

import {
  appendInTransaction,
  rowToRecord,
  verifyChain,
  type AppendOptions,
  type AuditRecord,
  type AuditRecordInput,
  type AuditStore,
  type VerifyResult,
} from "@openrupiv/audit";
import type { Db } from "./db";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";

const COLUMNS =
  "seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash";

/**
 * AuditStore over the runtime `Db` seam. Appends serialize on the chain tail
 * (FOR UPDATE inside `appendInTransaction`); reads page in seq order. There
 * is no update or delete — the audit log is append-only by construction.
 */
export function createDbAuditStore(db: Db, logger?: Logger): AuditStore {
  const opts: AppendOptions = {
    onScrub: (event, keys) => {
      logger?.warn(
        { event: "audit.attributes_scrubbed", auditEvent: event, keys },
        "secret-looking audit attribute keys were scrubbed before append",
      );
    },
  };

  async function readPage(fromSeq: number, limit: number): Promise<AuditRecord[]> {
    const res = await db.query(
      `SELECT ${COLUMNS} FROM audit_log WHERE seq >= $1 ORDER BY seq ASC LIMIT $2`,
      [fromSeq, limit],
    );
    return res.rows.map(rowToRecord);
  }

  return {
    append(input: AuditRecordInput): Promise<AuditRecord> {
      return db.transaction((tx) => appendInTransaction(tx, input, opts));
    },

    read(readOpts: { fromSeq?: number; limit?: number } = {}): Promise<AuditRecord[]> {
      return readPage(readOpts.fromSeq ?? 1, readOpts.limit ?? 1000);
    },

    async verify(): Promise<VerifyResult> {
      const page = 5000;
      let fromSeq = 1;
      let all: AuditRecord[] = [];
      for (;;) {
        const batch = await readPage(fromSeq, page);
        if (batch.length === 0) break;
        all = all.concat(batch);
        if (batch.length < page) break;
        fromSeq = all[all.length - 1]!.seq + 1;
      }
      return verifyChain(all);
    },
  };
}

/** Read the whole chain in seq order (verification/export). */
export async function readAllRecords(store: AuditStore): Promise<AuditRecord[]> {
  const page = 5000;
  let fromSeq = 1;
  let all: AuditRecord[] = [];
  for (;;) {
    const batch = await store.read({ fromSeq, limit: page });
    if (batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < page) break;
    fromSeq = all[all.length - 1]!.seq + 1;
  }
  return all;
}

/**
 * Fail-closed append: an audit-append failure becomes a 5xx for the request.
 * Used for every security event EXCEPT best-effort auth events. The failure
 * is logged with the full event so the record is preserved at least in the
 * structured log stream.
 */
export async function appendOrFail(
  store: AuditStore,
  logger: Logger,
  input: AuditRecordInput,
): Promise<void> {
  try {
    await store.append(input);
  } catch (error) {
    logger.error(
      { event: "audit.append_failed", auditEvent: input.event, auditRecord: input, err: error },
      "audit append failed; failing the request closed",
    );
    throw new RuntimeError(
      "ERR_AUDIT_APPEND_FAILED",
      `audit append failed for ${input.event}; request fails closed`,
      { statusCode: 500 },
    );
  }
}

/**
 * Attempt to append EVERY event in `inputs`, even if an earlier one in the
 * batch failed — a single append failure must never cause the rest to be
 * abandoned with no attempt and no log line (finding
 * "flush-drops-later-events"). Each failure is logged individually (via
 * `appendOrFail`, which logs the full event at error level before it
 * throws); once every event has been attempted, if ANY failed, this throws
 * one `ERR_AUDIT_APPEND_FAILED` — the request still fails closed overall,
 * it just no longer does so at the cost of silently dropping the events
 * queued after the first failure.
 */
export async function appendAllOrFail(
  store: AuditStore,
  logger: Logger,
  inputs: readonly AuditRecordInput[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const input of inputs) {
    try {
      await appendOrFail(store, logger, input);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new RuntimeError(
      "ERR_AUDIT_APPEND_FAILED",
      `${failures.length} of ${inputs.length} independent audit event(s) failed to append; ` +
        "request fails closed (see the preceding audit.append_failed log line for each)",
      { statusCode: 500 },
    );
  }
}

/**
 * Best-effort append for auth events (no DB side effect to bind to): an
 * append failure is logged at error level WITH the event preserved, and the
 * request proceeds — a broken audit database must not brick login/logout.
 * Returns whether the append succeeded so callers that DO want to react to
 * failure (e.g. a2a.ts failing its own request closed on a pre-dispatch
 * `a2a.call` append failure) can — callers that don't care (auth.ts) can
 * simply ignore the returned boolean exactly as they ignored `void` before.
 */
export async function auditBestEffort(
  store: AuditStore,
  logger: Logger,
  input: AuditRecordInput,
): Promise<boolean> {
  try {
    await store.append(input);
    return true;
  } catch (error) {
    logger.error(
      { event: "audit.append_failed", auditEvent: input.event, auditRecord: input, err: error },
      "best-effort audit append failed; event preserved in this log line",
    );
    return false;
  }
}
