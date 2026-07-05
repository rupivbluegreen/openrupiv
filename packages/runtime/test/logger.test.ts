import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/logger";

describe("redact", () => {
  it("redacts sensitive keys at any depth", () => {
    const input = {
      user: "alice",
      accessToken: "tok-123",
      nested: {
        client_secret: "sssh",
        Authorization: "Bearer abc",
        deep: { cookie: "openrupiv_session=abc", password: "pw" },
      },
      list: [{ idToken: "id-abc", keep: 1 }],
    };
    const out = redact(input) as Record<string, never>;
    expect(out).toEqual({
      user: "alice",
      accessToken: "[REDACTED]",
      nested: {
        client_secret: "[REDACTED]",
        Authorization: "[REDACTED]",
        deep: { cookie: "[REDACTED]", password: "[REDACTED]" },
      },
      list: [{ idToken: "[REDACTED]", keep: 1 }],
    });
  });

  it("redacts sessionSecret, apiKey, api_key, codeVerifier and set-cookie variants", () => {
    const out = redact({
      sessionSecret: "x",
      apiKey: "x",
      api_key: "x",
      codeVerifier: "x",
      "set-cookie": "x",
      credential: "x",
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) {
      expect(value).toBe("[REDACTED]");
    }
  });

  it("leaves non-sensitive values untouched", () => {
    expect(redact({ count: 3, name: "n", flag: true, nothing: null })).toEqual({
      count: 3,
      name: "n",
      flag: true,
      nothing: null,
    });
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
  });

  it("summarizes Error values without their stack", () => {
    const out = redact(new Error("boom")) as Record<string, unknown>;
    expect(out).toEqual({ name: "Error", message: "boom" });
    expect(JSON.stringify(out)).not.toContain("stack");
  });

  it("fails closed beyond the depth limit", () => {
    let deep: Record<string, unknown> = { secretless: "leaf" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const text = JSON.stringify(redact(deep));
    expect(text).toContain("[REDACTED:depth]");
    expect(text).not.toContain("leaf");
  });
});

describe("createLogger", () => {
  function capture(): { lines: string[]; sink: { write(l: string): void } } {
    const lines: string[] = [];
    return { lines, sink: { write: (l: string) => lines.push(l) } };
  }

  it("emits one JSON object per line with level, time, msg and fields", () => {
    const { lines, sink } = capture();
    const logger = createLogger(sink);
    logger.info({ event: "test.event", value: 7 }, "hello");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record["level"]).toBe("info");
    expect(record["msg"]).toBe("hello");
    expect(record["event"]).toBe("test.event");
    expect(record["value"]).toBe(7);
    expect(typeof record["time"]).toBe("string");
  });

  it("never lets tokens, cookies or authorization headers reach the sink", () => {
    const { lines, sink } = capture();
    const logger = createLogger(sink);
    logger.warn(
      {
        event: "auth.debug",
        authorization: "Bearer super-secret-token",
        cookie: "openrupiv_session=signed-value",
        idToken: "eyJhbGciOi...",
      },
      "attempted leak",
    );
    const line = lines[0] as string;
    expect(line).not.toContain("super-secret-token");
    expect(line).not.toContain("signed-value");
    expect(line).not.toContain("eyJhbGciOi");
    expect(line).toContain("[REDACTED]");
  });

  it("supports all four levels", () => {
    const { lines, sink } = capture();
    const logger = createLogger(sink);
    logger.debug({}, "d");
    logger.info({}, "i");
    logger.warn({}, "w");
    logger.error({}, "e");
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });

  it("survives unserializable fields without dropping the event", () => {
    const { lines, sink } = capture();
    const logger = createLogger(sink);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    logger.info(circular, "circular");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record["msg"]).toBe("circular");
  });
});
