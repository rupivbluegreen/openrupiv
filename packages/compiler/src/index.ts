/**
 * @openrupiv/compiler — deterministic projection of a validated app spec
 * into the ADR-0004 app directory (spec.json, SQL migration, docs,
 * standalone tests, optional server entry).
 *
 * Contract: specs/phase-1-contracts.md §1.
 */

export { compileApp } from "./compile";
export {
  columnName,
  joinTableName,
  kebabCase,
  snakeCase,
  tableName,
} from "./naming";
export type {
  CompiledFile,
  CompileResult,
  CompilerError,
  CompilerErrorCode,
} from "./types";
