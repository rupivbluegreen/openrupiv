import { describe, expect, it } from "vitest";
import type { FieldDef } from "@openrupiv/spec";
import {
  columnFor,
  entityApiSegment,
  entityTable,
  isUuid,
  quoteIdent,
  toSnakeCase,
} from "../src/naming";
import { RuntimeError } from "../src/errors";

describe("name mappings (SQL conventions, contracts §1)", () => {
  it("maps entity names to snake_case tables", () => {
    expect(entityTable("Vendor")).toBe("vendor");
    expect(entityTable("VendorApplication")).toBe("vendor_application");
  });

  it("maps entity names to kebab-case API segments", () => {
    expect(entityApiSegment("Vendor")).toBe("vendor");
    expect(entityApiSegment("VendorApplication")).toBe("vendor-application");
  });

  it("maps field names to snake_case columns", () => {
    expect(toSnakeCase("contactEmail")).toBe("contact_email");
    expect(toSnakeCase("annualSpend")).toBe("annual_spend");
    expect(toSnakeCase("status")).toBe("status");
  });

  it("suffixes reference columns with _id", () => {
    const reference: FieldDef = { name: "vendor", type: "reference", entity: "Vendor" };
    const scalar: FieldDef = { name: "justification", type: "text" };
    expect(columnFor(reference)).toBe("vendor_id");
    expect(columnFor(scalar)).toBe("justification");
  });
});

describe("quoteIdent", () => {
  it("quotes plain identifiers", () => {
    expect(quoteIdent("vendor_application")).toBe('"vendor_application"');
  });

  it("throws a typed error on anything unsafe", () => {
    for (const bad of ["Vendor", "a;drop table", 'a"b', "1abc", "a b", ""]) {
      expect(() => quoteIdent(bad)).toThrowError(RuntimeError);
      try {
        quoteIdent(bad);
      } catch (error) {
        expect((error as RuntimeError).code).toBe("ERR_SQL_IDENTIFIER");
      }
    }
  });
});

describe("isUuid", () => {
  it("accepts canonical uuids and rejects everything else", () => {
    expect(isUuid("7c9e6679-7425-40de-944b-e07fc1f90ae7")).toBe(true);
    expect(isUuid("7C9E6679-7425-40DE-944B-E07FC1F90AE7")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
