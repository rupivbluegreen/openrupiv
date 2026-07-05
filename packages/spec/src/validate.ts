import Ajv2020 from "ajv/dist/2020.js";
import type { SpecError } from "./errors";
import { appSpecSchema } from "./schema";
import type {
  AppSpec,
  EntityDef,
  FieldDef,
  FieldPredicate,
  SPEC_VERSION,
} from "./types";

export type ValidationResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; errors: SpecError[] };

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const structural = ajv.compile(appSpecSchema);

const COMPARISON_OPS = new Set(["gt", "gte", "lt", "lte"]);
const ORDERED_FIELD_TYPES = new Set(["number", "date", "datetime"]);

/**
 * Validate an untrusted value as an app spec: structural pass (JSON Schema)
 * then semantic pass (cross-references JSON Schema cannot express). Returns
 * either the typed spec or machine-readable errors with JSON Pointer paths —
 * the same shape the generator's retry loop feeds back to the model.
 */
export function validateSpec(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [
        {
          code: "ERR_SPEC_VERSION",
          path: "",
          message: "spec must be a JSON object",
        },
      ],
    };
  }

  const version = (input as Record<string, unknown>)["specVersion"];
  if (version !== ("0.1" satisfies typeof SPEC_VERSION)) {
    return {
      ok: false,
      errors: [
        {
          code: "ERR_SPEC_VERSION",
          path: "/specVersion",
          message: `unsupported specVersion ${JSON.stringify(version)}; this validator supports "0.1"`,
        },
      ],
    };
  }

  if (!structural(input)) {
    const errors: SpecError[] = (structural.errors ?? []).map((e) => {
      let message = e.message ?? "schema violation";
      if (e.keyword === "additionalProperties") {
        const extra = (e.params as { additionalProperty?: string })
          .additionalProperty;
        if (extra) message = `${message}: ${JSON.stringify(extra)}`;
      }
      return { code: "ERR_SCHEMA", path: e.instancePath, message };
    });
    return { ok: false, errors };
  }

  const spec = input as unknown as AppSpec;
  const errors: SpecError[] = [];
  const err = (code: SpecError["code"], path: string, message: string) => {
    errors.push({ code, path, message });
  };

  const entityByName = new Map<string, { entity: EntityDef; index: number }>();
  for (const [i, entity] of spec.entities.entries()) {
    if (entityByName.has(entity.name)) {
      err(
        "ERR_DUPLICATE_NAME",
        `/entities/${i}/name`,
        `duplicate entity name ${JSON.stringify(entity.name)}`,
      );
    } else {
      entityByName.set(entity.name, { entity, index: i });
    }
  }

  const roles = new Set(spec.app.roles ?? []);
  const checkRoles = (names: string[], path: string) => {
    for (const [i, role] of names.entries()) {
      if (!roles.has(role)) {
        err(
          "ERR_UNKNOWN_ROLE",
          `${path}/${i}`,
          `role ${JSON.stringify(role)} is not declared in app.roles`,
        );
      }
    }
  };

  for (const [i, entity] of spec.entities.entries()) {
    const memberNames = new Set<string>();
    const fieldByName = new Map<string, FieldDef>();

    for (const [j, field] of entity.fields.entries()) {
      const path = `/entities/${i}/fields/${j}`;
      if (memberNames.has(field.name)) {
        err(
          "ERR_DUPLICATE_NAME",
          `${path}/name`,
          `duplicate member name ${JSON.stringify(field.name)} on entity ${entity.name}`,
        );
      }
      memberNames.add(field.name);
      fieldByName.set(field.name, field);

      if (field.type === "enum") {
        if (!field.values) {
          err(
            "ERR_BAD_ENUM",
            path,
            `enum field ${JSON.stringify(field.name)} must declare values`,
          );
        }
      } else if (field.values) {
        err(
          "ERR_BAD_ENUM",
          `${path}/values`,
          `field ${JSON.stringify(field.name)} of type ${field.type} must not declare values`,
        );
      }

      if (field.type === "reference") {
        if (!field.entity) {
          err(
            "ERR_BAD_REFERENCE",
            path,
            `reference field ${JSON.stringify(field.name)} must declare a target entity`,
          );
        } else if (!entityByName.has(field.entity)) {
          err(
            "ERR_BAD_REFERENCE",
            `${path}/entity`,
            `reference field ${JSON.stringify(field.name)} targets unknown entity ${JSON.stringify(field.entity)}`,
          );
        }
      } else if (field.entity) {
        err(
          "ERR_BAD_REFERENCE",
          `${path}/entity`,
          `field ${JSON.stringify(field.name)} of type ${field.type} must not declare a target entity`,
        );
      }

      if (field.default !== undefined) {
        const d = field.default;
        const defaultPath = `${path}/default`;
        switch (field.type) {
          case "string":
          case "text":
            if (typeof d !== "string") {
              err("ERR_BAD_DEFAULT", defaultPath, `default for ${field.type} field must be a string`);
            }
            break;
          case "number":
            if (typeof d !== "number") {
              err("ERR_BAD_DEFAULT", defaultPath, "default for number field must be a number");
            }
            break;
          case "boolean":
            if (typeof d !== "boolean") {
              err("ERR_BAD_DEFAULT", defaultPath, "default for boolean field must be a boolean");
            }
            break;
          case "enum":
            if (typeof d !== "string" || !(field.values ?? []).includes(d)) {
              err("ERR_BAD_DEFAULT", defaultPath, "default for enum field must be one of its values");
            }
            break;
          case "date":
          case "datetime":
          case "reference":
            err(
              "ERR_BAD_DEFAULT",
              defaultPath,
              `defaults are not allowed on ${field.type} fields in spec v0.1`,
            );
            break;
        }
      }
    }

    for (const [j, relation] of (entity.relations ?? []).entries()) {
      const path = `/entities/${i}/relations/${j}`;
      if (memberNames.has(relation.name)) {
        err(
          "ERR_DUPLICATE_NAME",
          `${path}/name`,
          `duplicate member name ${JSON.stringify(relation.name)} on entity ${entity.name}`,
        );
      }
      memberNames.add(relation.name);
      if (!entityByName.has(relation.to)) {
        err(
          "ERR_UNKNOWN_ENTITY",
          `${path}/to`,
          `relation ${JSON.stringify(relation.name)} targets unknown entity ${JSON.stringify(relation.to)}`,
        );
      }
    }
  }

  const pageNames = new Set<string>();
  for (const [i, page] of (spec.pages ?? []).entries()) {
    const path = `/pages/${i}`;
    if (pageNames.has(page.name)) {
      err("ERR_DUPLICATE_NAME", `${path}/name`, `duplicate page name ${JSON.stringify(page.name)}`);
    }
    pageNames.add(page.name);

    const target = entityByName.get(page.entity);
    if (!target) {
      err(
        "ERR_UNKNOWN_ENTITY",
        `${path}/entity`,
        `page ${JSON.stringify(page.name)} is bound to unknown entity ${JSON.stringify(page.entity)}`,
      );
      continue;
    }
    if (page.fields) {
      const known = new Set(target.entity.fields.map((f) => f.name));
      for (const [j, name] of page.fields.entries()) {
        if (!known.has(name)) {
          err(
            "ERR_UNKNOWN_FIELD",
            `${path}/fields/${j}`,
            `page ${JSON.stringify(page.name)} selects unknown field ${JSON.stringify(name)} on entity ${page.entity}`,
          );
        }
      }
    }
  }

  const workflowNames = new Set<string>();
  for (const [i, workflow] of (spec.workflows ?? []).entries()) {
    const path = `/workflows/${i}`;
    if (workflowNames.has(workflow.name)) {
      err(
        "ERR_DUPLICATE_NAME",
        `${path}/name`,
        `duplicate workflow name ${JSON.stringify(workflow.name)}`,
      );
    }
    workflowNames.add(workflow.name);

    const target = entityByName.get(workflow.entity);
    if (!target) {
      err(
        "ERR_UNKNOWN_ENTITY",
        `${path}/entity`,
        `workflow ${JSON.stringify(workflow.name)} is bound to unknown entity ${JSON.stringify(workflow.entity)}`,
      );
      continue;
    }

    const fieldByName = new Map(target.entity.fields.map((f) => [f.name, f]));
    const stateField = fieldByName.get(workflow.stateField);
    if (!stateField || stateField.type !== "enum" || !stateField.values) {
      err(
        "ERR_WORKFLOW_STATE_FIELD",
        `${path}/stateField`,
        `workflow ${JSON.stringify(workflow.name)} stateField ${JSON.stringify(workflow.stateField)} must be an enum field on entity ${workflow.entity}`,
      );
      continue;
    }
    const states = new Set(stateField.values);
    if (!states.has(workflow.initial)) {
      err(
        "ERR_WORKFLOW_STATE",
        `${path}/initial`,
        `initial state ${JSON.stringify(workflow.initial)} is not a value of ${workflow.entity}.${workflow.stateField}`,
      );
    }

    const transitionNames = new Set<string>();
    for (const [j, transition] of workflow.transitions.entries()) {
      const tPath = `${path}/transitions/${j}`;
      if (transitionNames.has(transition.name)) {
        err(
          "ERR_DUPLICATE_NAME",
          `${tPath}/name`,
          `duplicate transition name ${JSON.stringify(transition.name)} in workflow ${workflow.name}`,
        );
      }
      transitionNames.add(transition.name);

      for (const end of ["from", "to"] as const) {
        if (!states.has(transition[end])) {
          err(
            "ERR_WORKFLOW_STATE",
            `${tPath}/${end}`,
            `transition ${JSON.stringify(transition.name)} ${end} state ${JSON.stringify(transition[end])} is not a value of ${workflow.entity}.${workflow.stateField}`,
          );
        }
      }

      if (transition.guard?.roles) {
        checkRoles(transition.guard.roles, `${tPath}/guard/roles`);
      }
      for (const [k, predicate] of (transition.guard?.require ?? []).entries()) {
        checkPredicate(predicate, fieldByName, `${tPath}/guard/require/${k}`, err);
      }
      if (transition.approval?.roles) {
        checkRoles(transition.approval.roles, `${tPath}/approval/roles`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec };
}

function checkPredicate(
  predicate: FieldPredicate,
  fieldByName: Map<string, FieldDef>,
  path: string,
  err: (code: SpecError["code"], path: string, message: string) => void,
): void {
  const field = fieldByName.get(predicate.field);
  if (!field) {
    err(
      "ERR_UNKNOWN_FIELD",
      `${path}/field`,
      `predicate references unknown field ${JSON.stringify(predicate.field)}`,
    );
    return;
  }
  if (field.type === "reference") {
    err(
      "ERR_BAD_PREDICATE",
      path,
      "predicates on reference fields are not supported in spec v0.1",
    );
    return;
  }

  const hasValue = predicate.value !== undefined;
  if (predicate.op === "set" || predicate.op === "notSet") {
    if (hasValue) {
      err(
        "ERR_BAD_PREDICATE",
        `${path}/value`,
        `op ${JSON.stringify(predicate.op)} must not carry a value`,
      );
    }
    return;
  }

  if (!hasValue) {
    err(
      "ERR_BAD_PREDICATE",
      path,
      `op ${JSON.stringify(predicate.op)} requires a value`,
    );
    return;
  }

  if (COMPARISON_OPS.has(predicate.op) && !ORDERED_FIELD_TYPES.has(field.type)) {
    err(
      "ERR_BAD_PREDICATE",
      `${path}/op`,
      `op ${JSON.stringify(predicate.op)} requires a number, date, or datetime field; ${JSON.stringify(predicate.field)} is ${field.type}`,
    );
    return;
  }

  const v = predicate.value;
  const valuePath = `${path}/value`;
  switch (field.type) {
    case "enum":
      if (typeof v !== "string" || !(field.values ?? []).includes(v)) {
        err("ERR_BAD_PREDICATE", valuePath, `value must be one of ${JSON.stringify(field.values)}`);
      }
      break;
    case "boolean":
      if (typeof v !== "boolean") {
        err("ERR_BAD_PREDICATE", valuePath, "value must be a boolean");
      }
      break;
    case "number":
      if (typeof v !== "number") {
        err("ERR_BAD_PREDICATE", valuePath, "value must be a number");
      }
      break;
    case "string":
    case "text":
    case "date":
    case "datetime":
      if (typeof v !== "string") {
        err("ERR_BAD_PREDICATE", valuePath, `value must be a string for ${field.type} fields`);
      }
      break;
  }
}
