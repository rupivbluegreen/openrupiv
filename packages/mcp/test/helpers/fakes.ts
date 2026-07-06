/**
 * Minimal in-memory fakes for @openrupiv/audit and @openrupiv/policy, built
 * directly against their public interfaces (not the Postgres/OPA-WASM
 * backed implementations) so this package's unit tests never touch a real
 * database or a real policy bundle, and can assert on the exact audit
 * records appended (order, event names, decisions, attributes).
 */

import { appendRecord, verifyChain } from "@openrupiv/audit";
import type { AuditRecord, AuditRecordInput, AuditStore, VerifyResult } from "@openrupiv/audit";
import type { PolicyDecision, PolicyEngine, PolicyInput } from "@openrupiv/policy";

export interface FakeAuditStore extends AuditStore {
  records: AuditRecord[];
}

/** Real hash-chained fake: reuses the package's own pure `appendRecord`/`verifyChain`. */
export function createFakeAuditStore(clock: () => string = () => "2026-01-01T00:00:00.000Z"): FakeAuditStore {
  const records: AuditRecord[] = [];
  return {
    records,
    async append(input: AuditRecordInput): Promise<AuditRecord> {
      const prev = records[records.length - 1] ?? null;
      const record = appendRecord(prev, input, clock());
      records.push(record);
      return record;
    },
    async read(opts?: { fromSeq?: number; limit?: number }): Promise<AuditRecord[]> {
      const from = opts?.fromSeq ?? 1;
      const limit = opts?.limit ?? records.length;
      return records.filter((r) => r.seq >= from).slice(0, limit);
    },
    async verify(): Promise<VerifyResult> {
      return verifyChain(records);
    },
  };
}

/** Wraps a real fake store but makes `append` throw for calls matching `failOn`. */
export function withFailingAppend(
  base: FakeAuditStore,
  failOn: (input: AuditRecordInput, callIndex: number) => boolean,
): FakeAuditStore {
  let callIndex = 0;
  return {
    ...base,
    async append(input: AuditRecordInput): Promise<AuditRecord> {
      const idx = callIndex++;
      if (failOn(input, idx)) {
        throw new Error("audit append failed (test-injected)");
      }
      return base.append(input);
    },
  };
}

/** Policy engine whose decision is driven by a caller-supplied predicate. */
export function createFakePolicyEngine(
  decide: (input: PolicyInput) => PolicyDecision | Promise<PolicyDecision>,
): PolicyEngine {
  return { decide: async (input) => decide(input) };
}

/** Always allows — useful as a default when a test only cares about other behavior. */
export function allowAllPolicyEngine(): PolicyEngine {
  return createFakePolicyEngine(() => ({ allow: true, reason: "test: allow all", policyId: "test" }));
}

/** Denies a specific action, allows everything else. */
export function denyActionPolicyEngine(deniedAction: string, reason = "test: denied"): PolicyEngine {
  return createFakePolicyEngine((input) =>
    input.action === deniedAction
      ? { allow: false, reason, policyId: "test" }
      : { allow: true, reason: "test: allow all", policyId: "test" },
  );
}
