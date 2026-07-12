/**
 * @openrupiv/sandbox -- ADR-0007's bubblewrap sidecar. Consumers outside
 * this package need exactly `createSidecarSandbox` (satisfies
 * `@openrupiv/agents`'s `ToolSandbox`); everything else here is the
 * sidecar's own internal implementation, deployed as the `sandbox` Compose
 * service, not imported directly.
 */

export { createSidecarSandbox, type CreateSidecarSandboxOptions } from "./client";
