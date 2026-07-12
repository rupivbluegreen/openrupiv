import { describe, expect, it } from "vitest";
import { extractRunId, isValidRunId } from "../src/run-id";

describe("isValidRunId", () => {
  it("accepts a well-formed UUID v4", () => {
    expect(isValidRunId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidRunId("3FA85F64-5717-4562-B3FC-2C963F66AFA6")).toBe(true);
  });

  it("rejects a non-v4 UUID (wrong version nibble)", () => {
    expect(isValidRunId("3fa85f64-5717-1562-b3fc-2c963f66afa6")).toBe(false);
  });

  it("rejects a non-UUID string", () => {
    expect(isValidRunId("not-a-uuid")).toBe(false);
  });

  it("rejects a path-traversal attempt", () => {
    expect(isValidRunId("../../etc/passwd")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(isValidRunId("/etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidRunId("")).toBe(false);
  });
});

describe("extractRunId", () => {
  it("extracts a valid runId from the final path segment", () => {
    expect(extractRunId("/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(extractRunId("/workspaces/3fa85f64-5717-4562-b3fc-2c963f66afa6/")).toBe(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
  });

  it("returns null for a traversal attempt in the final segment", () => {
    expect(extractRunId("/workspaces/../../etc")).toBeNull();
  });

  it("returns null when the final segment is not a UUID", () => {
    expect(extractRunId("/workspaces/not-a-uuid")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(extractRunId("")).toBeNull();
  });
});
