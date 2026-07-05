/**
 * Deterministic name projections shared by every emitter.
 *
 * These implement the SQL and HTTP naming conventions in
 * specs/phase-1-contracts.md §1 — the runtime assumes exactly these names,
 * so they are pure string functions with no configuration and no
 * environment access.
 */

import type { FieldDef } from "@openrupiv/spec";

/** `HTTPServer` → `HTTP_Server` (before lowering). */
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
/** `vendorApplication` → `vendor_Application` (before lowering). */
const WORD_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** `VendorApplication` → `vendor_application`; `contactEmail` → `contact_email`. */
export function snakeCase(name: string): string {
  return name
    .replace(ACRONYM_BOUNDARY, "$1_$2")
    .replace(WORD_BOUNDARY, "$1_$2")
    .toLowerCase();
}

/** `VendorApplication` → `vendor-application` (entity API path segment). */
export function kebabCase(name: string): string {
  return name
    .replace(ACRONYM_BOUNDARY, "$1-$2")
    .replace(WORD_BOUNDARY, "$1-$2")
    .toLowerCase();
}

/** SQL table for an entity: snake_case of the entity name. */
export function tableName(entityName: string): string {
  return snakeCase(entityName);
}

/**
 * SQL column for a field: snake_case of the field name; reference fields
 * get an `_id` suffix (`vendor` → `vendor_id`).
 */
export function columnName(field: FieldDef): string {
  const base = snakeCase(field.name);
  return field.type === "reference" ? `${base}_id` : base;
}

/** Join table for a manyToMany relation: `<entity_table>_<relation_snake>`. */
export function joinTableName(entityName: string, relationName: string): string {
  return `${snakeCase(entityName)}_${snakeCase(relationName)}`;
}

/** Single-quoted SQL string literal with `'` doubled. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL literal for a spec `default` value (string | number | boolean). */
export function sqlLiteral(value: string | number | boolean): string {
  switch (typeof value) {
    case "string":
      return sqlStringLiteral(value);
    case "number":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
  }
}
