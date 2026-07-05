/**
 * Commander wiring. `runCli` is a pure-ish function of (argv, deps) → exit
 * code so the whole surface — commands, options, exit codes, output streams
 * — is unit-testable without spawning processes or touching process.exit.
 */

import { Command, CommanderError } from "commander";
import type { CliDeps } from "./deps";
import { EXIT_OK, EXIT_USAGE } from "./errors";
import { runGenerate, type GenerateOptions } from "./commands/generate";
import { runNew } from "./commands/new";

export const CLI_VERSION = "0.1.0";

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode = EXIT_OK;

  const program = new Command();
  program
    .name("openrupiv")
    .description(
      "openRupiv CLI — scaffold workspaces and generate apps as a reviewable " +
        "spec + deterministic code projection (LLM writes the spec only).",
    )
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.stdout(text),
      writeErr: (text) => deps.stderr(text),
    });

  program
    .command("new")
    .description("scaffold a new openrupiv workspace (offline, deterministic, no LLM)")
    .argument("<name>", "workspace directory name (kebab-case)")
    .action(async (name: string) => {
      exitCode = await runNew(name, deps);
    });

  program
    .command("generate")
    .description("generate an app from a natural-language description and commit it")
    .argument("<description>", "what the app should do, in plain language")
    .option("--dir <workspace>", "workspace directory (default: current directory)")
    .option("--json", "emit a single {ok, files, errors, attempts} JSON object on stdout")
    .action(async (description: string, options: GenerateOptions) => {
      exitCode = await runGenerate(description, options, deps);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help/--version resolve with exitCode 0; usage errors (unknown
      // command, missing argument) are 1 — distinct from the contract's
      // 2/3/4 outcome codes. Commander has already printed the diagnostics
      // through configureOutput.
      return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    }
    throw error;
  }
  return exitCode;
}
