/**
 * @openrupiv/cli — `openrupiv new` (deterministic offline workspace
 * scaffold) and `openrupiv generate` (LLM spec → validate → deterministic
 * compile → commit). Contract: specs/phase-1-contracts.md §4.
 *
 * The process entry point is src/main.ts (run via bin/openrupiv.mjs);
 * this module is the programmatic/test surface.
 */

export { runCli, CLI_VERSION } from "./program";
export { runNew } from "./commands/new";
export {
  runGenerate,
  type GenerateOptions,
  type GenerateResultJson,
} from "./commands/generate";
export type { CliDeps } from "./deps";
export {
  CliError,
  EXIT_COMPILE_FAILED,
  EXIT_ENVIRONMENT,
  EXIT_GENERATE_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CliErrorCode,
  type ReportedError,
} from "./errors";
export { git, makeRunGit, type ExecResult, type RunGit } from "./git";
export {
  assertGeneratorModule,
  loadGeneratorModule,
  type GenerateResult,
  type GeneratorModule,
  type SpecModel,
  type SpecModelRequest,
} from "./generator-contract";
export {
  DEV_OIDC_CLIENT_ID,
  DEV_OIDC_CLIENT_SECRET,
  DEV_USER_EMAIL,
  DEV_USER2_EMAIL,
  DEV_USER_PASSWORD,
  DEV_USER_PASSWORD_BCRYPT,
  DEX_IMAGE,
  POSTGRES_IMAGE,
  workspaceFiles,
  type WorkspaceFile,
  type WorkspaceFileInputs,
} from "./workspace-files";
