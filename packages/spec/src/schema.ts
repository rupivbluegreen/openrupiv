/**
 * JSON Schema (draft 2020-12) for the openRupiv app spec v0.1.
 *
 * This schema is the structural contract. Cross-reference rules that JSON
 * Schema cannot express (entity references, state values, role vocabulary)
 * live in `validate.ts` as the semantic pass. Both passes emit the same
 * machine-readable `SpecError` shape.
 */

export const PATTERN_ENTITY_NAME = "^[A-Z][A-Za-z0-9]*$";
export const PATTERN_MEMBER_NAME = "^[a-z][A-Za-z0-9]*$";
export const PATTERN_KEBAB_NAME = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const PATTERN_VALUE_NAME = "^[a-z][a-z0-9_]*$";
export const PATTERN_SEMVER = "^\\d+\\.\\d+\\.\\d+$";

export const appSpecSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openrupiv.invalid/schemas/app-spec/0.1.json",
  title: "openRupiv app spec v0.1",
  type: "object",
  additionalProperties: false,
  required: ["specVersion", "app", "entities"],
  properties: {
    specVersion: { const: "0.1" },
    app: { $ref: "#/$defs/app" },
    entities: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/entity" },
    },
    pages: { type: "array", items: { $ref: "#/$defs/page" } },
    workflows: { type: "array", items: { $ref: "#/$defs/workflow" } },
    policies: { type: "array", items: { $ref: "#/$defs/policy" } },
    agents: { type: "array", items: { $ref: "#/$defs/agentTask" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidenceHook" } },
  },
  $defs: {
    app: {
      type: "object",
      additionalProperties: false,
      required: ["name", "slug", "version"],
      properties: {
        name: { type: "string", minLength: 1 },
        slug: { type: "string", pattern: PATTERN_KEBAB_NAME },
        description: { type: "string" },
        version: { type: "string", pattern: PATTERN_SEMVER },
        roles: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: PATTERN_VALUE_NAME },
        },
      },
    },
    entity: {
      type: "object",
      additionalProperties: false,
      required: ["name", "fields"],
      properties: {
        name: { type: "string", pattern: PATTERN_ENTITY_NAME },
        description: { type: "string" },
        fields: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/field" },
        },
        relations: { type: "array", items: { $ref: "#/$defs/relation" } },
      },
    },
    field: {
      type: "object",
      additionalProperties: false,
      required: ["name", "type"],
      properties: {
        name: { type: "string", pattern: PATTERN_MEMBER_NAME },
        type: {
          enum: [
            "string",
            "text",
            "number",
            "boolean",
            "date",
            "datetime",
            "enum",
            "reference",
          ],
        },
        required: { type: "boolean" },
        unique: { type: "boolean" },
        values: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: PATTERN_VALUE_NAME },
        },
        entity: { type: "string", pattern: PATTERN_ENTITY_NAME },
        default: { type: ["string", "number", "boolean"] },
      },
    },
    relation: {
      type: "object",
      additionalProperties: false,
      required: ["name", "kind", "to"],
      properties: {
        name: { type: "string", pattern: PATTERN_MEMBER_NAME },
        kind: { const: "manyToMany" },
        to: { type: "string", pattern: PATTERN_ENTITY_NAME },
      },
    },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "entity"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        type: { enum: ["list", "detail", "form"] },
        entity: { type: "string", pattern: PATTERN_ENTITY_NAME },
        title: { type: "string" },
        fields: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: PATTERN_MEMBER_NAME },
        },
      },
    },
    predicate: {
      type: "object",
      additionalProperties: false,
      required: ["field", "op"],
      properties: {
        field: { type: "string", pattern: PATTERN_MEMBER_NAME },
        op: { enum: ["eq", "ne", "gt", "gte", "lt", "lte", "set", "notSet"] },
        value: { type: ["string", "number", "boolean"] },
      },
    },
    guard: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        roles: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: PATTERN_VALUE_NAME },
        },
        require: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/predicate" },
        },
      },
    },
    approval: {
      type: "object",
      additionalProperties: false,
      required: ["count"],
      properties: {
        count: { type: "integer", minimum: 2 },
        roles: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: PATTERN_VALUE_NAME },
        },
      },
    },
    transition: {
      type: "object",
      additionalProperties: false,
      required: ["name", "from", "to"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        from: { type: "string", pattern: PATTERN_VALUE_NAME },
        to: { type: "string", pattern: PATTERN_VALUE_NAME },
        guard: { $ref: "#/$defs/guard" },
        approval: { $ref: "#/$defs/approval" },
      },
    },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["name", "entity", "stateField", "initial", "transitions"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        entity: { type: "string", pattern: PATTERN_ENTITY_NAME },
        stateField: { type: "string", pattern: PATTERN_MEMBER_NAME },
        initial: { type: "string", pattern: PATTERN_VALUE_NAME },
        transitions: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/transition" },
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        description: { type: "string" },
        rego: { type: "string" },
      },
    },
    agentTask: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        description: { type: "string" },
      },
    },
    evidenceHook: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: PATTERN_KEBAB_NAME },
        description: { type: "string" },
      },
    },
  },
} as const;
