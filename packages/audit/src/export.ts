/**
 * SIEM export formats. Pure transforms from audit records to the shapes a
 * downstream collector ingests. No IO — the runtime's export route streams
 * these to the client.
 */

import type { AuditRecord } from "./types";

/** One JSON object per line (JSONL / ndjson). */
export function toJsonl(records: AuditRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * OTLP logs JSON (resourceLogs → scopeLogs → logRecords). Each audit record
 * becomes a log record whose body is the event and whose attributes carry the
 * chain metadata, so a tamper check can be reconstructed downstream.
 */
export function toOtlpLogRecords(records: AuditRecord[]): unknown {
  const kv = (key: string, value: unknown) => ({
    key,
    value:
      typeof value === "number"
        ? { intValue: String(value) }
        : { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [kv("service.name", "openrupiv"), kv("telemetry.kind", "audit")],
        },
        scopeLogs: [
          {
            scope: { name: "@openrupiv/audit" },
            logRecords: records.map((r) => ({
              timeUnixNano: rfc3339ToUnixNano(r.timestamp),
              severityText: r.decision === "deny" ? "WARN" : "INFO",
              body: { stringValue: r.event },
              attributes: [
                kv("seq", r.seq),
                kv("actor", r.actor),
                kv("actor.type", r.actorType),
                ...(r.subject !== undefined ? [kv("subject", r.subject)] : []),
                ...(r.decision !== undefined ? [kv("decision", r.decision)] : []),
                kv("hash", r.hash),
                kv("prev_hash", r.prevHash),
                kv("attributes", r.attributes),
              ],
            })),
          },
        ],
      },
    ],
  };
}

/** RFC 5424 syslog lines (one per record), structured data carrying the hash. */
export function toSyslog(records: AuditRecord[]): string[] {
  // PRI 13 = facility 1 (user-level) * 8 + severity 5 (notice).
  const PRI = 13;
  const escape = (v: string) => v.replace(/[\\\]"]/g, (c) => `\\${c}`);
  return records.map((r) => {
    const sd =
      `[openrupiv@0 seq="${r.seq}" actor="${escape(r.actor)}" actorType="${r.actorType}"` +
      (r.subject !== undefined ? ` subject="${escape(r.subject)}"` : "") +
      (r.decision !== undefined ? ` decision="${r.decision}"` : "") +
      ` hash="${r.hash}" prevHash="${r.prevHash}"]`;
    return `<${PRI}>1 ${r.timestamp} openrupiv audit ${r.seq} ${r.event} ${sd}`;
  });
}

/** RFC3339 → nanoseconds since epoch as a decimal string (best-effort). */
function rfc3339ToUnixNano(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "0";
  return `${ms}000000`;
}
