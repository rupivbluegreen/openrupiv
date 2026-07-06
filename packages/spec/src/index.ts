export {
  SPEC_VERSION,
  SPEC_VERSION_0_2,
  type AppMeta,
  type AppSpec,
  type AgentProposalRef,
  type AgentTaskDef,
  type ApprovalRule,
  type EntityDef,
  type EvidenceHookDef,
  type FieldDef,
  type FieldPredicate,
  type FieldType,
  type PageDef,
  type PageType,
  type PolicyDef,
  type PredicateOp,
  type RelationDef,
  type SpecVersion,
  type TransitionDef,
  type TransitionGuard,
  type WorkflowDef,
} from "./types";
export { type SpecError, type SpecErrorCode } from "./errors";
export {
  appSpecSchema,
  PATTERN_ENTITY_NAME,
  PATTERN_KEBAB_NAME,
  PATTERN_MEMBER_NAME,
  PATTERN_SEMVER,
  PATTERN_VALUE_NAME,
} from "./schema";
export { validateSpec, type ValidationResult } from "./validate";
export * as fixtures from "./fixtures";
