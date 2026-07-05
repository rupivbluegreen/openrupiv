import { describe, expect, it } from "vitest";
import { extractSpecJson } from "../src/parse";

const SPEC = { specVersion: "0.1", app: { name: "X" } };
const SPEC_JSON = JSON.stringify(SPEC);

describe("extractSpecJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractSpecJson(SPEC_JSON)).toEqual({ ok: true, value: SPEC });
  });

  it("parses pretty-printed JSON with surrounding whitespace", () => {
    const raw = `\n\n  ${JSON.stringify(SPEC, null, 2)}  \n`;
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("parses a ```json fenced block", () => {
    const raw = "```json\n" + SPEC_JSON + "\n```";
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("parses a fenced block without a language tag", () => {
    const raw = "```\n" + SPEC_JSON + "\n```";
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("parses a fenced block with leading and trailing prose", () => {
    const raw =
      "Sure, here is the spec you asked for:\n\n```json\n" +
      SPEC_JSON +
      "\n```\n\nLet me know if you need changes.";
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("parses an unfenced object with leading prose", () => {
    const raw = "Here is the spec:\n" + SPEC_JSON;
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("parses an unfenced object with trailing prose", () => {
    const raw = SPEC_JSON + "\nHope this helps!";
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("skips non-JSON brace groups in prose before the object", () => {
    const raw = "Using {placeholder} syntax here, the spec is " + SPEC_JSON;
    expect(extractSpecJson(raw)).toEqual({ ok: true, value: SPEC });
  });

  it("handles braces inside JSON string values", () => {
    const value = { app: { description: "curly {braces} and \"quotes\" inside" } };
    expect(extractSpecJson("intro " + JSON.stringify(value))).toEqual({ ok: true, value });
  });

  it("rejects an empty response", () => {
    const result = extractSpecJson("   \n  ");
    expect(result.ok).toBe(false);
  });

  it("rejects prose with no JSON object", () => {
    const result = extractSpecJson("I cannot produce a spec for that request.");
    expect(result.ok).toBe(false);
  });

  it("rejects a top-level JSON array", () => {
    const result = extractSpecJson("[1, 2, 3]");
    expect(result.ok).toBe(false);
  });

  it("rejects an unterminated object", () => {
    const result = extractSpecJson('{"specVersion": "0.1", "app": {');
    expect(result.ok).toBe(false);
  });
});
