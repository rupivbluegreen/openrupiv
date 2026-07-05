#!/usr/bin/env node
/**
 * Dev-mode bin (specs/phase-1-contracts.md §4): the CLI runs from the
 * monorepo, so this wrapper execs tsx on src/main.ts rather than shipping a
 * build. tsx is a monorepo root devDependency; Node resolution walks up
 * from packages/cli to find it.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainTs = path.join(here, "..", "src", "main.ts");

let tsxCli;
try {
  tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
} catch {
  process.stderr.write(
    "openrupiv: ERR_ENVIRONMENT: cannot resolve tsx — the dev-mode bin runs from the " +
      "openRupiv monorepo. Run `corepack pnpm install` at the monorepo root first.\n",
  );
  process.exit(4);
}

const result = spawnSync(process.execPath, [tsxCli, mainTs, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`openrupiv: failed to start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
