/**
 * Environment-variable configuration for the sandbox supervisor, mirroring
 * `@openrupiv/runtime`'s `config.ts` fail-fast style: every required value
 * is validated at startup, never defaulted to something insecure.
 */

export interface SandboxConfig {
  token: string;
  workspaceRoot: string;
  pythonRoot: string;
  toolRoot: string;
  seccompBpfPath: string;
  port: number;
}

export class SandboxConfigError extends Error {}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const token = env["SANDBOX_TOKEN"];
  if (!token || token.length < 32) {
    throw new SandboxConfigError("SANDBOX_TOKEN must be set to a random value >= 32 characters");
  }
  const workspaceRoot = env["SANDBOX_WORKSPACE_ROOT"] ?? "/workspaces";
  const pythonRoot = env["SANDBOX_PYTHON_ROOT"] ?? "/usr";
  const toolRoot = env["SANDBOX_TOOL_ROOT"] ?? "/opt/sandbox-tools";
  const seccompBpfPath = env["SANDBOX_SECCOMP_BPF_PATH"] ?? "/opt/sandbox/seccomp/tool.bpf";
  const port = Number(env["PORT"] ?? "8443");
  if (!Number.isInteger(port) || port <= 0) {
    throw new SandboxConfigError(`PORT must be a positive integer, got "${env["PORT"]}"`);
  }
  return { token, workspaceRoot, pythonRoot, toolRoot, seccompBpfPath, port };
}
