/**
 * TypeScript types for the openrupiv app spec, version 0.1.
 *
 * The JSON Schema in `schema.ts` is the contract; these types mirror it and
 * the fixture tests keep the two from drifting. The spec is the single
 * artifact the LLM is allowed to produce (ADR-0001) — everything downstream
 * (compiler, runtime) is a deterministic projection of a value of `AppSpec`.
 */

export const SPEC_VERSION = "0.1" as const;
export const SPEC_VERSION_0_2 = "0.2" as const;
export type SpecVersion = typeof SPEC_VERSION | typeof SPEC_VERSION_0_2;

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "reference";

export interface FieldDef {
  /** camelCase identifier, unique within the entity. */
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  /** enum only: allowed values (snake_case), at least one. */
  values?: string[];
  /** reference only: target entity name. */
  entity?: string;
  /** Not allowed on date/datetime/reference fields in v0. */
  default?: string | number | boolean;
}

export interface RelationDef {
  /** camelCase identifier, unique within the entity (also vs field names). */
  name: string;
  kind: "manyToMany";
  /** Target entity name. */
  to: string;
}

export interface EntityDef {
  /** PascalCase identifier, unique within the spec. */
  name: string;
  description?: string;
  fields: FieldDef[];
  relations?: RelationDef[];
}

export type PageType = "list" | "detail" | "form";

export interface PageDef {
  /** kebab-case slug, unique within the spec. */
  name: string;
  type: PageType;
  /** Entity the page is bound to. */
  entity: string;
  title?: string;
  /** Subset + ordering of the entity's field names; defaults to all fields. */
  fields?: string[];
}

export type PredicateOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "set"
  | "notSet";

export interface FieldPredicate {
  field: string;
  op: PredicateOp;
  /** Required for comparison ops; forbidden for set/notSet. */
  value?: string | number | boolean;
}

export interface TransitionGuard {
  /** Roles allowed to fire the transition (subset of app.roles). */
  roles?: string[];
  /** All predicates must hold on the current record. */
  require?: FieldPredicate[];
}

/**
 * n-eyes approval: the transition completes only after `count` approvals
 * from distinct authenticated users. count >= 2 by construction — a
 * single-approver step is just a guarded transition, not an approval rule.
 */
export interface ApprovalRule {
  count: number;
  /** Roles allowed to approve (subset of app.roles); defaults to guard roles. */
  roles?: string[];
}

export interface TransitionDef {
  /** kebab-case identifier, unique within the workflow. */
  name: string;
  from: string;
  to: string;
  guard?: TransitionGuard;
  approval?: ApprovalRule;
}

export interface WorkflowDef {
  /** kebab-case identifier, unique within the spec. */
  name: string;
  entity: string;
  /** Must name an enum field on the entity; its values are the states. */
  stateField: string;
  /** Must be one of the state field's values. */
  initial: string;
  transitions: TransitionDef[];
}

/**
 * Reserved sections. Their shapes are versioned here so specs can carry
 * them, but the v0 compiler rejects them with ERR_UNSUPPORTED_SECTION —
 * never a silent no-op (CLAUDE.md non-negotiable #2).
 */
export interface PolicyDef {
  name: string;
  description?: string;
  rego?: string;
}

export interface AgentProposalRef {
  /** Must name an existing `WorkflowDef.name`. */
  workflow: string;
  /** Must name an existing transition within that workflow that carries an `approval` rule. */
  transition: string;
}

/**
 * v0.2: a governed agent task. `tools`/`proposes` are new in v0.2; a v0.1
 * spec must not populate them (enforced structurally: v0.1 specs can only
 * ever have an empty/absent `agents` array once compileApp accepts them —
 * see the `ERR_AGENTS_REQUIRE_V0_2` semantic check in validate.ts).
 */
export interface AgentTaskDef {
  /** kebab-case, unique across `agents`. */
  name: string;
  description?: string;
  /** Tool allowlist. Deny-by-default: absent/empty = the task may call no tools. */
  tools?: string[];
  /** Human-gated transitions this task may propose. Agents never fire transitions directly. */
  proposes?: AgentProposalRef[];
}

export interface EvidenceHookDef {
  name: string;
  description?: string;
}

export interface AppMeta {
  /** Human-readable name. */
  name: string;
  /** kebab-case slug; becomes package/database identifiers downstream. */
  slug: string;
  description?: string;
  /** semver `major.minor.patch`. */
  version: string;
  /** Role vocabulary referenced by workflow guards/approvals. */
  roles?: string[];
}

export interface AppSpec {
  specVersion: SpecVersion;
  app: AppMeta;
  entities: EntityDef[];
  pages?: PageDef[];
  workflows?: WorkflowDef[];
  policies?: PolicyDef[];
  agents?: AgentTaskDef[];
  evidence?: EvidenceHookDef[];
}
