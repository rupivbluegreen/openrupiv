/**
 * Machine-readable validation errors. The same shape serves both consumers:
 * the generator's retry loop (which feeds errors back to the model) and the
 * human's terminal. Codes are stable API; messages are not.
 */

export type SpecErrorCode =
  /** Input is not an object or declares an unsupported specVersion. */
  | "ERR_SPEC_VERSION"
  /** Structural violation of the JSON Schema. */
  | "ERR_SCHEMA"
  /** Identifier collides with a sibling (entity, field, page, …). */
  | "ERR_DUPLICATE_NAME"
  /** A section names an entity that does not exist. */
  | "ERR_UNKNOWN_ENTITY"
  /** A section names a field that does not exist on its entity. */
  | "ERR_UNKNOWN_FIELD"
  /** Reference field problems (missing/forbidden `entity`, unknown target). */
  | "ERR_BAD_REFERENCE"
  /** Enum field problems (missing/forbidden/duplicate `values`). */
  | "ERR_BAD_ENUM"
  /** Default value incompatible with the field type. */
  | "ERR_BAD_DEFAULT"
  /** Guard predicate malformed (value/op/field-type mismatch). */
  | "ERR_BAD_PREDICATE"
  /** Workflow stateField missing or not an enum field. */
  | "ERR_WORKFLOW_STATE_FIELD"
  /** Workflow initial/from/to not among the state field's values. */
  | "ERR_WORKFLOW_STATE"
  /** Role referenced but not declared in app.roles. */
  | "ERR_UNKNOWN_ROLE";

export interface SpecError {
  code: SpecErrorCode;
  /** JSON Pointer (RFC 6901) to the offending location in the document. */
  path: string;
  message: string;
}
