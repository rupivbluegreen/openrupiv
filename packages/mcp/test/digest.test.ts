import { describe, expect, it } from "vitest";
import { canonicalJson, digestValue } from "../src/digest";

describe("canonicalJson / digestValue", () => {
  it("is insensitive to object key order", () => {
    const a = canonicalJson({ a: 1, b: 2 });
    const b = canonicalJson({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("keeps array order significant", () => {
    const a = canonicalJson([1, 2, 3]);
    const b = canonicalJson([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it("produces the same digest for structurally-equal-but-differently-ordered input", () => {
    const d1 = digestValue({ tool: "echo", args: { x: 1, y: 2 } });
    const d2 = digestValue({ args: { y: 2, x: 1 }, tool: "echo" });
    expect(d1.sha256).toBe(d2.sha256);
    expect(d1.bytes).toBe(d2.bytes);
  });

  it("produces different digests for different content", () => {
    const d1 = digestValue({ secret: "value-one" });
    const d2 = digestValue({ secret: "value-two" });
    expect(d1.sha256).not.toBe(d2.sha256);
  });

  it("never surfaces the raw value — only a hex sha256 and a byte count", () => {
    const secret = "super-secret-token-value";
    const d = digestValue({ token: secret });
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d)).not.toContain(secret);
  });

  it("treats undefined/missing input as null", () => {
    expect(digestValue(undefined).sha256).toBe(digestValue(null).sha256);
  });
});
