/**
 * In-memory `AuditStore` (@openrupiv/audit) for unit tests -- no live
 * Postgres. Uses the REAL pure chain functions (`appendRecord`,
 * `verifyChain`) from @openrupiv/audit, so the chain semantics (hash
 * linkage, seq monotonicity) are genuine, just backed by an array instead
 * of a table. This is `deps.audit` in tests; `deps.db`'s FakeDb (fakeDb.ts)
 * separately reproduces the exact `audit_log` SQL shapes for the
 * `propose()` same-transaction append via `appendInTransaction` -- the two
 * are intentionally independent stores, mirroring the real split between
 * "events appended in the caller's own transaction" and "events appended on
 * a separate connection" described in packages/runtime/src/audit.ts.
 */
import { appendRecord, verifyChain } from "@openrupiv/audit";
import type { AuditRecord, AuditRecordInput, AuditStore, VerifyResult } from "@openrupiv/audit";

export interface FakeAuditStoreOptions {
  clock?: () => string;
}

export class FakeAuditStore implements AuditStore {
  readonly records: AuditRecord[] = [];
  private failPattern: RegExp | undefined;
  private failSkip = 0;
  private readonly clock: () => string;

  constructor(opts: FakeAuditStoreOptions = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Make the next append() whose `event` matches `pattern` throw (default:
   * matches any event) -- for ERR_AUDIT_UNAVAILABLE tests. Pass `occurrence`
   * > 1 to let earlier matches succeed and fail only the Nth.
   */
  failNextAppend(pattern: RegExp = /.*/, occurrence = 1): void {
    this.failPattern = pattern;
    this.failSkip = Math.max(occurrence, 1) - 1;
  }

  async append(input: AuditRecordInput): Promise<AuditRecord> {
    if (this.failPattern?.test(input.event)) {
      if (this.failSkip > 0) {
        this.failSkip--;
      } else {
        this.failPattern = undefined;
        throw new Error(`FakeAuditStore: injected failure for event ${input.event}`);
      }
    }
    const prev = this.records[this.records.length - 1] ?? null;
    const record = appendRecord(prev, input, this.clock());
    this.records.push(record);
    return record;
  }

  async read(opts: { fromSeq?: number; limit?: number } = {}): Promise<AuditRecord[]> {
    const from = opts.fromSeq ?? 1;
    const limit = opts.limit ?? 1000;
    return this.records.filter((r) => r.seq >= from).slice(0, limit);
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(this.records);
  }
}
