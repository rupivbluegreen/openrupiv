/**
 * Semantic spec comparison for golden tests and the eval script.
 *
 * Per specs/phase-1-contracts.md §3: entity/page/workflow NAMES and field
 * TYPES must match; descriptions and titles are free. Concretely:
 *
 * Compared (order-insensitive, by name):
 *   - role vocabulary (app.roles, as a set)
 *   - entity names; per entity: field names, field types, enum value sets,
 *     reference targets; relation names, kinds, and targets
 *   - page names; per page: type and bound entity
 *   - workflow names; per workflow: entity, stateField, initial; transition
 *     names; per transition: from, to, guard roles (set), guard predicates
 *     (set), approval presence, count, and roles (set)
 *
 * Free (never diffed): app name/slug/description/version, all descriptions
 * and titles, page field selection/ordering, field required/unique/default,
 * and the ordering of every array.
 */

import type {
  AppSpec,
  EntityDef,
  FieldDef,
  PageDef,
  RelationDef,
  TransitionDef,
  WorkflowDef,
} from "@openrupiv/spec";

export interface SpecDiff {
  /** Name-based path into the spec, e.g. "/entities/Vendor/fields/riskTier/type". */
  path: string;
  message: string;
}

/** Compare two valid specs semantically. Empty result = equivalent. */
export function compareSpecs(expected: AppSpec, actual: AppSpec): SpecDiff[] {
  const diffs: SpecDiff[] = [];

  compareSets(
    expected.app.roles ?? [],
    actual.app.roles ?? [],
    "/app/roles",
    "role",
    diffs,
  );
  compareNamed(expected.entities, actual.entities, "/entities", "entity", diffs, compareEntity);
  compareNamed(expected.pages ?? [], actual.pages ?? [], "/pages", "page", diffs, comparePage);
  compareNamed(
    expected.workflows ?? [],
    actual.workflows ?? [],
    "/workflows",
    "workflow",
    diffs,
    compareWorkflow,
  );

  return diffs;
}

interface Named {
  name: string;
}

function compareNamed<T extends Named>(
  expected: readonly T[],
  actual: readonly T[],
  basePath: string,
  kind: string,
  diffs: SpecDiff[],
  compareItem?: (expected: T, actual: T, path: string, diffs: SpecDiff[]) => void,
): void {
  const expectedByName = new Map(expected.map((item) => [item.name, item]));
  const actualByName = new Map(actual.map((item) => [item.name, item]));

  for (const [name, expectedItem] of expectedByName) {
    const actualItem = actualByName.get(name);
    if (!actualItem) {
      diffs.push({ path: `${basePath}/${name}`, message: `missing ${kind} ${JSON.stringify(name)}` });
      continue;
    }
    compareItem?.(expectedItem, actualItem, `${basePath}/${name}`, diffs);
  }
  for (const name of actualByName.keys()) {
    if (!expectedByName.has(name)) {
      diffs.push({ path: `${basePath}/${name}`, message: `unexpected ${kind} ${JSON.stringify(name)}` });
    }
  }
}

function compareSets(
  expected: readonly string[],
  actual: readonly string[],
  path: string,
  kind: string,
  diffs: SpecDiff[],
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      diffs.push({ path, message: `missing ${kind} ${JSON.stringify(value)}` });
    }
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      diffs.push({ path, message: `unexpected ${kind} ${JSON.stringify(value)}` });
    }
  }
}

function compareScalar(
  expected: string | number | boolean | undefined,
  actual: string | number | boolean | undefined,
  path: string,
  label: string,
  diffs: SpecDiff[],
): void {
  if (expected !== actual) {
    diffs.push({
      path,
      message: `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    });
  }
}

function compareEntity(
  expected: EntityDef,
  actual: EntityDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareNamed(expected.fields, actual.fields, `${path}/fields`, "field", diffs, compareField);
  compareNamed(
    expected.relations ?? [],
    actual.relations ?? [],
    `${path}/relations`,
    "relation",
    diffs,
    compareRelation,
  );
}

function compareField(
  expected: FieldDef,
  actual: FieldDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareScalar(expected.type, actual.type, `${path}/type`, "field type", diffs);
  if (expected.type !== actual.type) return;
  if (expected.type === "enum") {
    compareSets(expected.values ?? [], actual.values ?? [], `${path}/values`, "enum value", diffs);
  }
  if (expected.type === "reference") {
    compareScalar(expected.entity, actual.entity, `${path}/entity`, "reference target", diffs);
  }
}

function compareRelation(
  expected: RelationDef,
  actual: RelationDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareScalar(expected.kind, actual.kind, `${path}/kind`, "relation kind", diffs);
  compareScalar(expected.to, actual.to, `${path}/to`, "relation target", diffs);
}

function comparePage(
  expected: PageDef,
  actual: PageDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareScalar(expected.type, actual.type, `${path}/type`, "page type", diffs);
  compareScalar(expected.entity, actual.entity, `${path}/entity`, "page entity", diffs);
}

function compareWorkflow(
  expected: WorkflowDef,
  actual: WorkflowDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareScalar(expected.entity, actual.entity, `${path}/entity`, "workflow entity", diffs);
  compareScalar(expected.stateField, actual.stateField, `${path}/stateField`, "state field", diffs);
  compareScalar(expected.initial, actual.initial, `${path}/initial`, "initial state", diffs);
  compareNamed(
    expected.transitions,
    actual.transitions,
    `${path}/transitions`,
    "transition",
    diffs,
    compareTransition,
  );
}

function compareTransition(
  expected: TransitionDef,
  actual: TransitionDef,
  path: string,
  diffs: SpecDiff[],
): void {
  compareScalar(expected.from, actual.from, `${path}/from`, "from state", diffs);
  compareScalar(expected.to, actual.to, `${path}/to`, "to state", diffs);

  compareSets(
    expected.guard?.roles ?? [],
    actual.guard?.roles ?? [],
    `${path}/guard/roles`,
    "guard role",
    diffs,
  );
  compareSets(
    (expected.guard?.require ?? []).map(canonicalPredicate),
    (actual.guard?.require ?? []).map(canonicalPredicate),
    `${path}/guard/require`,
    "guard predicate",
    diffs,
  );

  if (expected.approval && !actual.approval) {
    diffs.push({ path: `${path}/approval`, message: "missing approval rule" });
    return;
  }
  if (!expected.approval && actual.approval) {
    diffs.push({ path: `${path}/approval`, message: "unexpected approval rule" });
    return;
  }
  if (expected.approval && actual.approval) {
    compareScalar(
      expected.approval.count,
      actual.approval.count,
      `${path}/approval/count`,
      "approval count",
      diffs,
    );
    compareSets(
      expected.approval.roles ?? [],
      actual.approval.roles ?? [],
      `${path}/approval/roles`,
      "approval role",
      diffs,
    );
  }
}

function canonicalPredicate(predicate: {
  field: string;
  op: string;
  value?: string | number | boolean;
}): string {
  return JSON.stringify([predicate.field, predicate.op, predicate.value ?? null]);
}
