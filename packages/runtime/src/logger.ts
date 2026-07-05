/**
 * Structured JSON logging with mandatory redaction.
 *
 * Every log line is a single JSON object on stdout. All caller-supplied
 * fields pass through `redact()` before serialization, so tokens, cookies,
 * secrets, passwords, and Authorization headers can never reach the log
 * stream even if a call site passes them by accident. These logs become the
 * audit substrate in Phase 2 — treat shape changes as API changes.
 */

const REDACT_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|session|credential|api[-_]?key|verifier|assertion|private[-_]?key)/i;

const MAX_DEPTH = 10;

/**
 * Deep-copy `value` with every property whose key matches the sensitive-key
 * pattern replaced by "[REDACTED]". Arrays and nested objects are walked;
 * anything deeper than MAX_DEPTH is redacted wholesale (fail closed).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[REDACTED:depth]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const err = value as Error & { code?: unknown; statusCode?: unknown };
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.code !== undefined) out["code"] = err.code;
    if (err.statusCode !== undefined) out["statusCode"] = err.statusCode;
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redact(item, depth + 1);
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

/** Create a structured JSON logger. Defaults to stdout; tests inject a sink. */
export function createLogger(sink: LogSink = process.stdout): Logger {
  const emit = (
    level: LogLevel,
    fields: Record<string, unknown>,
    msg: string,
  ): void => {
    const record = {
      level,
      time: new Date().toISOString(),
      msg,
      ...(redact(fields) as Record<string, unknown>),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular or otherwise unserializable fields: never crash the caller,
      // never drop the event silently.
      line = JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg,
        logError: "fields were not serializable and were dropped",
      });
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
