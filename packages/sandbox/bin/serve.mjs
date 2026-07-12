#!/usr/bin/env node
// Sandbox supervisor entrypoint (mirrors packages/runtime/bin/serve.mjs's
// shape). Reads SandboxConfig from the environment, runs the boot canary
// via the real assertion jail, then serves. Any canary failure still
// starts the HTTP server (so /healthz can report WHY) but /v1/execute
// refuses every request per ADR-0007's fail-closed contract.
import { mkdirSync } from "node:fs";
import { configFromEnv } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { runBootCanary } from "../src/canary.ts";
import { runJail } from "../src/jail-executor.ts";
import { createLogger } from "../src/logger.ts";

const logger = createLogger();

async function main() {
  const config = configFromEnv();

  // The canary's workspace is NOT created by createWorkspace (that only
  // runs for real /v1/execute calls) and the Dockerfile's `mkdir -p
  // /workspaces` is masked at runtime by the tmpfs Compose/`docker run`
  // mounts there — so this fixed path must be created here, on the
  // writable tmpfs, before every boot. Idempotent (recursive: true) and
  // 0700 to match createWorkspace's own workspace directories.
  mkdirSync(`${config.workspaceRoot}/boot-canary`, { recursive: true, mode: 0o700 });

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
      // Surface WHY the canary jail did not succeed. Without this, a jail
      // that crashes (e.g. an assertion raising inside the jail) collapses
      // to a bare "exit code 1" with no detail — runJail captures the jail's
      // stderr in outcome.message, so log the whole outcome so operators (and
      // CI) can see the traceback / classification instead of guessing.
      if (!outcome.ok) {
        logger.error({ event: "sandbox.canary_jail_error", outcome }, "canary assertion jail did not succeed");
      }
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
