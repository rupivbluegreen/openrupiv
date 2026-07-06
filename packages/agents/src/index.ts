/**
 * @openrupiv/agents -- governed agent workers. Contract:
 * specs/phase-2-contracts.md §4. See README.md for how it works and the
 * design notes on the underspecified corners of the contract.
 */

export type {
  AgentContext,
  AgentErrorCode,
  AgentIdentity,
  AgentProposal,
  AgentRuntime,
  AgentTaskDef,
  Db,
  Queryable,
  QueryResultLike,
  RegisteredTool,
  SandboxExecuteInput,
  SandboxExecuteResult,
  SandboxLimits,
  ToolCallRequest,
  ToolCallResult,
  ToolSandbox,
} from "./types";

export { AgentTaskNotFoundError } from "./errors";
export { AGENT_PROPOSALS_DDL } from "./migration";
export { digestValue } from "./hashing";
export {
  createAgentRuntime,
  DEFAULT_SANDBOX_LIMITS,
  type CreateAgentRuntimeDeps,
} from "./runtime";
