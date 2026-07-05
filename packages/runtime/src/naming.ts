/**
 * Deterministic name mappings between spec identifiers and SQL/HTTP names,
 * mirroring the SQL conventions in specs/phase-1-contracts.md §1.
 *
 * Identifiers reaching SQL are validated against a strict pattern before
 * interpolation. Spec names are already shape-checked by validateSpec, so a
 * failure here is an internal invariant violation — it throws, never
 * degrades.
 */

import type { FieldDef } from "@openrupiv/spec";
import { RuntimeError } from "./errors";

/** `VendorApplication` → `vendor_application`, `contactEmail` → `contact_email`. */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Table name for an entity per the SQL conventions. */
export function entityTable(entityName: string): string {
  return toSnakeCase(entityName);
}

/** API path segment: `VendorApplication` → `vendor-application`. */
export function entityApiSegment(entityName: string): string {
  return toSnakeCase(entityName).replace(/_/g, "-");
}

/** Column name for a field; reference fields get an `_id` suffix. */
export function columnFor(field: FieldDef): string {
  const base = toSnakeCase(field.name);
  return field.type === "reference" ? `${base}_id` : base;
}

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Quote an identifier for interpolation into SQL. Rejects anything that is
 * not a plain lowercase identifier — values never reach this path (they are
 * always parameterized), this is belt-and-braces for names.
 */
export function quoteIdent(name: string): string {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new RuntimeError(
      "ERR_SQL_IDENTIFIER",
      `refusing to use unsafe SQL identifier ${JSON.stringify(name)}`,
    );
  }
  return `"${name}"`;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
