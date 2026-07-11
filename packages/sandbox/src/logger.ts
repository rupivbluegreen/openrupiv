/**
 * Structured JSON logging, deliberately duplicated from
 * `@openrupiv/runtime`'s `logger.ts` rather than imported: this sidecar
 * must not depend on `@openrupiv/runtime` (no reverse/lateral package
 * dependency), matching the same "our own minimal interface" convention
 * `@openrupiv/agents` already uses for `Db`/`Queryable` (see that package's
 * README). Every log line is one JSON object on stdout; the sandbox has no
 * database connection (no route to postgres — see ADR-0007's Network
 * section) so this stdout stream, not a DB-backed audit table, is how an
 * operator correlates sandbox behavior with the platform's audit trail.
 */

const REDACT_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[REDACTED:depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(item, depth + 1);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export function createLogger(sink: LogSink = process.stdout): Logger {
  const emit = (level: LogLevel, fields: Record<string, unknown>, msg: string): void => {
    const record = { level, time: new Date().toISOString(), msg, ...(redact(fields) as Record<string, unknown>) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, time: new Date().toISOString(), msg, logError: "fields were not serializable" });
    }
    sink.write(`${line}\n`);
  };
  return {
    debug: (fields, msg) => emit("debug", fields, msg),
    info: (fields, msg) => emit("info", fields, msg),
    warn: (fields, msg) => emit("warn", fields, msg),
    error: (fields, msg) => emit("error", fields, msg),
  };
}
