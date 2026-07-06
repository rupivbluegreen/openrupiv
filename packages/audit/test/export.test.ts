import { describe, expect, it } from "vitest";
import {
  appendRecord,
  otlpEnvelope,
  otlpLogRecord,
  toJsonl,
  toOtlpLogRecords,
  toSyslog,
} from "../src/index";
import type { AuditRecord } from "../src/index";

function chain(): AuditRecord[] {
  const a = appendRecord(null, { event: "auth.login", actor: "u1", actorType: "human" }, "2026-07-06T00:00:00.000Z");
  const b = appendRecord(
    a,
    { event: "workflow.approval_recorded", actor: "u2", actorType: "human", subject: "vendor_application:x", decision: "allow" },
    "2026-07-06T00:00:01.000Z",
  );
  return [a, b];
}

describe("SIEM exporters", () => {
  it("toJsonl emits one parseable JSON object per line", () => {
    const lines = toJsonl(chain()).split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!).event).toBe("auth.login");
  });

  it("toOtlpLogRecords carries seq, hashes, decision severity", () => {
    const otlp = toOtlpLogRecords(chain()) as any;
    const logs = otlp.resourceLogs[0].scopeLogs[0].logRecords;
    expect(logs).toHaveLength(2);
    expect(logs[0].body.stringValue).toBe("auth.login");
    expect(logs[1].severityText).toBe("INFO");
    const attrKeys = logs[1].attributes.map((a: any) => a.key);
    expect(attrKeys).toEqual(expect.arrayContaining(["seq", "hash", "prev_hash", "decision"]));
  });

  it("toOtlpLogRecords marks deny decisions WARN", () => {
    const deny = appendRecord(null, { event: "policy.decision", actor: "u1", actorType: "human", decision: "deny" }, "2026-07-06T00:00:00.000Z");
    const otlp = toOtlpLogRecords([deny]) as any;
    expect(otlp.resourceLogs[0].scopeLogs[0].logRecords[0].severityText).toBe("WARN");
  });

  it("toSyslog emits RFC5424-shaped lines with structured data", () => {
    const lines = toSyslog(chain());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^<13>1 2026-07-06T00:00:00\.000Z openrupiv audit 1 auth\.login \[openrupiv@0 /);
    expect(lines[1]).toContain('decision="allow"');
    expect(lines[1]).toContain('subject="vendor_application:x"');
  });

  it("otlpEnvelope + otlpLogRecord, comma-joined, reproduce toOtlpLogRecords exactly (streaming equivalence)", () => {
    const records = chain();
    const { open, close } = otlpEnvelope();
    const streamed = open + records.map((r) => JSON.stringify(otlpLogRecord(r))).join(",") + close;
    expect(JSON.parse(streamed)).toEqual(toOtlpLogRecords(records));
  });

  it("otlpEnvelope alone (no records) reproduces an empty-logRecords toOtlpLogRecords", () => {
    const { open, close } = otlpEnvelope();
    expect(JSON.parse(open + close)).toEqual(toOtlpLogRecords([]));
  });
});
