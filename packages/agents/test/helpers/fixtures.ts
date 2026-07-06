/**
 * Minimal AppSpec + RegisteredTool fixtures for unit tests. `buildSpec`
 * intentionally mirrors the same "Spec v0.1/v0.2 type gap" cast documented
 * in src/runtime.ts and README.md: @openrupiv/spec's current `AppSpec` type
 * only allows `agents` entries shaped `{ name, description? }`, but this
 * package's own `AgentTaskDef` (src/types.ts) is the richer v0.2 shape with
 * `tools`/`proposes`. Tests construct real-shaped v0.2 task defs and cast
 * the whole spec, exactly the situation createAgentRuntime's own doc
 * comment describes trusting.
 */
import type { AppSpec } from "@openrupiv/spec";
import type { AgentTaskDef, RegisteredTool } from "../../src/types";

export function buildSpec(agentTasks: AgentTaskDef[], slug = "vendor-onboarding"): AppSpec {
  return {
    specVersion: "0.1",
    app: { name: "Vendor Onboarding", slug, version: "0.1.0" },
    entities: [],
    agents: agentTasks,
  } as unknown as AppSpec;
}

export const ECHO_TOOL: RegisteredTool = {
  name: "echo",
  description: "Echoes its input back -- a trivial fixture tool.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      message: { type: "string" },
      secretToken: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  entrypoint: "builtin:echo",
};
