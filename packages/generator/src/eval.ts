/**
 * Live eval: run the golden corpus prompts against the real Anthropic model
 * and report semantic diffs against the expected specs.
 *
 * NOT part of CI (requires ANTHROPIC_API_KEY and network). Run with:
 *
 *   ANTHROPIC_API_KEY=... corepack pnpm --filter @openrupiv/generator eval
 *
 * Env:
 *   ANTHROPIC_API_KEY     required — never logged, never written to disk.
 *   OPENRUPIV_EVAL_MODEL  optional model id override (default claude-sonnet-5).
 *
 * Exit codes: 0 all prompts pass; 1 at least one failure; 2 environment error.
 */

import { compareSpecs } from "./compare";
import { loadCorpus } from "./corpus";
import { generateSpec } from "./generate";
import { AnthropicSpecModel } from "./model";

async function main(): Promise<number> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      JSON.stringify({
        error: "ERR_NO_API_KEY",
        message:
          "ANTHROPIC_API_KEY is not set. The eval calls the live Anthropic API; export the key and re-run: ANTHROPIC_API_KEY=... pnpm eval",
      }),
    );
    return 2;
  }

  const modelOverride = process.env["OPENRUPIV_EVAL_MODEL"];
  const model = new AnthropicSpecModel(modelOverride ? { model: modelOverride } : undefined);
  const corpus = loadCorpus();

  console.log(`eval: ${corpus.length} prompts against model ${model.modelId}\n`);

  let passed = 0;
  const failures: string[] = [];

  for (const entry of corpus) {
    process.stdout.write(`${entry.name} ... `);
    try {
      const result = await generateSpec(entry.prompt, model);
      if (!result.ok) {
        failures.push(entry.name);
        console.log(`FAIL (no valid spec after ${result.attempts} attempts)`);
        for (const error of result.errors) {
          console.log(`  ${error.code} ${error.path} ${error.message}`);
        }
        continue;
      }
      const diffs = compareSpecs(entry.expected, result.spec);
      if (diffs.length === 0) {
        passed += 1;
        console.log(`PASS (attempts: ${result.attempts})`);
      } else {
        failures.push(entry.name);
        console.log(`FAIL (valid spec, ${diffs.length} semantic diffs, attempts: ${result.attempts})`);
        for (const diff of diffs) {
          console.log(`  ${diff.path}: ${diff.message}`);
        }
      }
    } catch (err) {
      failures.push(entry.name);
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERROR (${message})`);
    }
  }

  console.log(`\nsummary: ${passed}/${corpus.length} passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.join(", ")}`);
  }
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ error: "ERR_EVAL_CRASH", message }));
    process.exitCode = 2;
  },
);
