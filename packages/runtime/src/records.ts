/**
 * Entity models, request-body validation/coercion, and row <-> record
 * mapping between spec camelCase field names and SQL snake_case columns.
 *
 * Workflow state fields are READ-ONLY through create/update: the server sets
 * the initial state on create, and workflow transitions are the only writer.
 * Any attempt to write a state field is a typed 400, never silently dropped.
 */

import type {
  AppSpec,
  EntityDef,
  FieldDef,
  PageDef,
  WorkflowDef,
} from "@openrupiv/spec";
import { RuntimeError } from "./errors";
import { columnFor, entityApiSegment, entityTable, isUuid } from "./naming";

export interface EntityModel {
  entity: EntityDef;
  /** SQL table name, e.g. `vendor_application`. */
  table: string;
  /** API path segment, e.g. `vendor-application`. */
  apiSegment: string;
  fieldByName: Map<string, FieldDef>;
  /** Workflow state fields on this entity: field name → initial state. */
  stateFields: Map<string, string>;
  /** Workflows bound to this entity. */
  workflows: WorkflowDef[];
}

export function buildEntityModel(spec: AppSpec, entity: EntityDef): EntityModel {
  const workflows = (spec.workflows ?? []).filter(
    (w) => w.entity === entity.name,
  );
  const stateFields = new Map<string, string>();
  for (const workflow of workflows) {
    stateFields.set(workflow.stateField, workflow.initial);
  }
  return {
    entity,
    table: entityTable(entity.name),
    apiSegment: entityApiSegment(entity.name),
    fieldByName: new Map(entity.fields.map((f) => [f.name, f])),
    stateFields,
    workflows,
  };
}

export function buildEntityModels(spec: AppSpec): Map<string, EntityModel> {
  return new Map(
    spec.entities.map((entity) => [entity.name, buildEntityModel(spec, entity)]),
  );
}

/** First detail/list/form page bound to an entity, if any. */
export function pageFor(
  spec: AppSpec,
  entityName: string,
  type: PageDef["type"],
): PageDef | undefined {
  return (spec.pages ?? []).find(
    (p) => p.type === type && p.entity === entityName,
  );
}

export type BodySource = "json" | "form";

interface FieldProblem {
  field: string;
  message: string;
}

/**
 * Validate and coerce a create/update body against the entity model.
 * Returns a map of field name → value ready for SQL parameters. Throws
 * RuntimeError (400) on any problem — unknown fields included.
 */
export function validateBody(
  model: EntityModel,
  body: unknown,
  mode: "create" | "update",
  source: BodySource,
): Map<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RuntimeError("ERR_VALIDATION", "request body must be an object", {
      statusCode: 400,
    });
  }

  const input = body as Record<string, unknown>;
  const problems: FieldProblem[] = [];
  const data = new Map<string, unknown>();

  for (const key of Object.keys(input)) {
    if (model.stateFields.has(key)) {
      // Read-only through this API; transitions are the only writer.
      throw new RuntimeError(
        "ERR_STATE_FIELD_READONLY",
        `field ${JSON.stringify(key)} is a workflow state field and is read-only; ` +
          "use the transition endpoints to change it",
        { statusCode: 400, details: { field: key } },
      );
    }
    if (!model.fieldByName.has(key)) {
      problems.push({ field: key, message: "unknown field" });
    }
  }

  for (const field of model.entity.fields) {
    if (model.stateFields.has(field.name)) continue;
    const raw = input[field.name];
    const present =
      raw !== undefined && !(source === "form" && raw === "");

    if (!present) {
      if (
        mode === "create" &&
        field.required === true &&
        field.default === undefined
      ) {
        problems.push({ field: field.name, message: "required field is missing" });
      }
      continue;
    }

    if (raw === null) {
      if (field.required === true) {
        problems.push({ field: field.name, message: "required field must not be null" });
      } else {
        data.set(field.name, null);
      }
      continue;
    }

    const coerced = coerceValue(field, raw, source, problems);
    if (coerced !== INVALID) data.set(field.name, coerced);
  }

  if (problems.length > 0) {
    throw new RuntimeError("ERR_VALIDATION", "request body failed validation", {
      statusCode: 400,
      details: problems,
    });
  }

  return data;
}

const INVALID = Symbol("invalid");

function coerceValue(
  field: FieldDef,
  raw: unknown,
  source: BodySource,
  problems: FieldProblem[],
): unknown {
  const fail = (message: string): typeof INVALID => {
    problems.push({ field: field.name, message });
    return INVALID;
  };

  switch (field.type) {
    case "string":
    case "text":
      if (typeof raw !== "string") return fail("must be a string");
      return raw;

    case "number": {
      let value: number;
      if (typeof raw === "number") {
        value = raw;
      } else if (source === "form" && typeof raw === "string") {
        value = Number(raw);
      } else {
        return fail("must be a number");
      }
      if (!Number.isFinite(value)) return fail("must be a finite number");
      return value;
    }

    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (source === "form" && typeof raw === "string") {
        if (raw === "true" || raw === "on" || raw === "1") return true;
        if (raw === "false" || raw === "off" || raw === "0") return false;
      }
      return fail("must be a boolean");
    }

    case "date":
    case "datetime": {
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        return fail(`must be an ISO ${field.type} string`);
      }
      return raw;
    }

    case "enum": {
      if (typeof raw !== "string" || !(field.values ?? []).includes(raw)) {
        return fail(`must be one of ${JSON.stringify(field.values ?? [])}`);
      }
      return raw;
    }

    case "reference": {
      if (!isUuid(raw)) return fail("must be a UUID referencing an existing record");
      return raw;
    }
  }
}

/** Map a SQL row to the API record shape (camelCase fields + metadata). */
export function rowToRecord(
  model: EntityModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = { id: row["id"] ?? null };
  for (const field of model.entity.fields) {
    record[field.name] = normalizeValue(row[columnFor(field)]);
  }
  record["createdAt"] = normalizeValue(row["created_at"]);
  record["updatedAt"] = normalizeValue(row["updated_at"]);
  return record;
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
