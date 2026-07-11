import { describe, expect, it } from "vitest";
import { hashToken, tokensMatch } from "../src/token-auth";

describe("hashToken", () => {
  it("produces a fixed 32-byte digest regardless of input length", () => {
    expect(hashToken("short").length).toBe(32);
    expect(hashToken("a".repeat(500)).length).toBe(32);
  });

  it("is deterministic", () => {
    expect(hashToken("same-value")).toEqual(hashToken("same-value"));
  });
});

describe("tokensMatch", () => {
  it("returns true for identical tokens", () => {
    expect(tokensMatch("secret-value-123", "secret-value-123")).toBe(true);
  });

  it("returns false for different tokens of the same length", () => {
    expect(tokensMatch("secret-value-123", "secret-value-124")).toBe(false);
  });

  it("returns false for different-length tokens without throwing", () => {
    expect(() => tokensMatch("short", "a-much-longer-token-value")).not.toThrow();
    expect(tokensMatch("short", "a-much-longer-token-value")).toBe(false);
  });

  it("returns false for an empty presented token against a real one", () => {
    expect(tokensMatch("", "real-token")).toBe(false);
  });
});
