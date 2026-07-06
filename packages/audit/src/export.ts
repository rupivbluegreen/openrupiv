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

function otlpKv(key: string, value: unknown): unknown {
  return {
    key,
    value:
      typeof value === "number"
        ? { intValue: String(value) }
        : { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
  };
}

/** One audit record as a single OTLP log record (no resourceLogs/scopeLogs wrapper). */
export function otlpLogRecord(r: AuditRecord): unknown {
  return {
    timeUnixNano: rfc3339ToUnixNano(r.timestamp),
    severityText: r.decision === "deny" ? "WARN" : "INFO",
    body: { stringValue: r.event },
    attributes: [
      otlpKv("seq", r.seq),
      otlpKv("actor", r.actor),
      otlpKv("actor.type", r.actorType),
      ...(r.subject !== undefined ? [otlpKv("subject", r.subject)] : []),
      ...(r.decision !== undefined ? [otlpKv("decision", r.decision)] : []),
      otlpKv("hash", r.hash),
      otlpKv("prev_hash", r.prevHash),
      otlpKv("attributes", r.attributes),
    ],
  };
}

/**
 * OTLP logs JSON (resourceLogs → scopeLogs → logRecords). Each audit record
 * becomes a log record whose body is the event and whose attributes carry the
 * chain metadata, so a tamper check can be reconstructed downstream.
 */
export function toOtlpLogRecords(records: AuditRecord[]): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [otlpKv("service.name", "openrupiv"), otlpKv("telemetry.kind", "audit")],
        },
        scopeLogs: [
          {
            scope: { name: "@openrupiv/audit" },
            logRecords: records.map(otlpLogRecord),
          },
        ],
      },
    ],
  };
}

/**
 * Split the OTLP wrapper around an EMPTY `logRecords` array so a streaming
 * caller can write `open`, then each record's `otlpLogRecord()` JSON
 * comma-joined, then `close`, and get output identical to
 * `JSON.stringify(toOtlpLogRecords(allRecords))` without ever holding every
 * record (or their OTLP transforms) in memory at once — see the runtime's
 * `/admin/audit/export` route (finding "audit-read-unbounded-memory").
 * Derived from `toOtlpLogRecords` itself (never duplicated by hand) so the
 * envelope can never drift from the non-streaming shape.
 */
export function otlpEnvelope(): { open: string; close: string } {
  const empty = JSON.stringify(toOtlpLogRecords([]));
  const marker = '"logRecords":[]';
  const markerIndex = empty.indexOf(marker);
  if (markerIndex === -1) {
    // Only reachable if toOtlpLogRecords's own wrapper shape changes without
    // updating this splice point — fail loudly rather than emit truncated
    // or malformed JSON to a SIEM ingester.
    throw new Error(
      "otlpEnvelope: could not locate the empty logRecords array in toOtlpLogRecords([]) output",
    );
  }
  const bracketIndex = markerIndex + marker.length - 1; // index of the "]" in "[]"
  return { open: empty.slice(0, bracketIndex), close: empty.slice(bracketIndex) };
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
