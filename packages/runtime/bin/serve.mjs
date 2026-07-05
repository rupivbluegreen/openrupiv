#!/usr/bin/env node
/**
 * Serve a compiled app directory:
 *
 *   tsx bin/serve.mjs <appDir>        (or set APP_DIR)
 *
 * The runtime ships as TypeScript source in v0, so this entry must run under
 * a TS-capable loader (the Docker image and the Compose stack use `tsx`,
 * which is a monorepo devDependency). Configuration comes from the
 * environment — see the package README for the variable list.
 */

import { configFromEnv, serveAppDir } from "../src/index.ts";

const appDir = process.argv[2] ?? process.env.APP_DIR;

if (!appDir) {
  process.stderr.write(
    `${JSON.stringify({
      error: "ERR_APP_DIR",
      message: "usage: serve.mjs <appDir> (or set the APP_DIR environment variable)",
    })}\n`,
  );
  process.exit(1);
}

try {
  await serveAppDir(appDir, configFromEnv());
} catch (error) {
  const body =
    error && typeof error.toBody === "function"
      ? error.toBody()
      : {
          error: "ERR_INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exit(1);
}
