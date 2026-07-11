#!/usr/bin/env node
// Sandbox supervisor entrypoint (mirrors packages/runtime/bin/serve.mjs's
// shape). Reads SandboxConfig from the environment, runs the boot canary
// via the real assertion jail, then serves. Any canary failure still
// starts the HTTP server (so /healthz can report WHY) but /v1/execute
// refuses every request per ADR-0007's fail-closed contract.
import { configFromEnv } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { runBootCanary } from "../src/canary.ts";
import { runJail } from "../src/jail-executor.ts";
import { createLogger } from "../src/logger.ts";

const logger = createLogger();

async function main() {
  const config = configFromEnv();

  const canaryResult = await runBootCanary({
    runAssertionJail: async () => {
      const outcome = await runJail({
        entrypointPath: `${config.toolRoot}/canary/main.py`,
        workspaceHostPath: `${config.workspaceRoot}/boot-canary`,
        pythonRoot: config.pythonRoot,
        toolRoot: config.toolRoot,
        seccompBpfPath: config.seccompBpfPath,
        limits: { wallClockMs: 10_000, memoryBytes: 268_435_456, maxOutputBytes: 65_536 },
      });
      return {
        stdout: outcome.ok ? JSON.stringify(outcome.output) : "",
        exitCode: outcome.ok ? 0 : 1,
        signal: null,
      };
    },
  });

  logger.info({ event: "sandbox.canary", ok: canaryResult.ok, assertions: canaryResult.assertions }, "boot canary complete");
  if (!canaryResult.ok) {
    logger.error({ event: "sandbox.canary_failed" }, "boot canary failed — /v1/execute will refuse every request");
  }

  const app = await createServer({
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    pythonRoot: config.pythonRoot,
    toolRoot: config.toolRoot,
    seccompBpfPath: config.seccompBpfPath,
    canaryResult,
    logger,
  });

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ event: "sandbox.listening", port: config.port }, "sandbox supervisor listening");
}

main().catch((err) => {
  logger.error({ event: "sandbox.fatal", err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, "sandbox supervisor failed to start");
  process.exitCode = 1;
});
