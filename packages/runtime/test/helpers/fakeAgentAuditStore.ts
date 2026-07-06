import type { AuditRecord, AuditRecordInput, AuditStore, VerifyResult } from "@openrupiv/audit";

export class FakeAuditStore implements AuditStore {
  readonly records: AuditRecordInput[] = [];
  async append(input: AuditRecordInput): Promise<AuditRecord> {
    this.records.push(input);
    return { ...input, seq: this.records.length, timestamp: "2026-01-01T00:00:00.000Z", hash: "h", prevHash: "p" } as AuditRecord;
  }
  async read(): Promise<AuditRecord[]> {
    return [];
  }
  async verify(): Promise<VerifyResult> {
    return { ok: true, count: this.records.length };
  }
}
