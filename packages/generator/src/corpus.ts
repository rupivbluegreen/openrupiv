/**
 * Golden corpus loader. Corpus entries live in `corpus/*.json` as
 * `{ "prompt": string, "expected": AppSpec }`. Loading validates every
 * expected spec with validateSpec — an invalid corpus is a hard, typed
 * error, so a drifting spec schema fails CI loudly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpec, type AppSpec } from "@openrupiv/spec";
import { GeneratorError } from "./errors";

export interface CorpusEntry {
  /** File basename without extension, e.g. "vendor-onboarding". */
  name: string;
  prompt: string;
  expected: AppSpec;
}

/** Absolute path of the corpus directory shipped with this package. */
export const CORPUS_DIR = fileURLToPath(new URL("../corpus/", import.meta.url));

export function loadCorpus(dir: string = CORPUS_DIR): CorpusEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    throw new GeneratorError("ERR_CORPUS_INVALID", `corpus directory not readable: ${dir}`);
  }
  if (files.length === 0) {
    throw new GeneratorError("ERR_CORPUS_INVALID", `no corpus entries (*.json) in ${dir}`);
  }

  return files.map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GeneratorError("ERR_CORPUS_INVALID", `${file}: not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new GeneratorError("ERR_CORPUS_INVALID", `${file}: entry must be a JSON object`);
    }
    const { prompt, expected } = parsed as { prompt?: unknown; expected?: unknown };
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new GeneratorError(
        "ERR_CORPUS_INVALID",
        `${file}: "prompt" must be a non-empty string`,
      );
    }
    const result = validateSpec(expected);
    if (!result.ok) {
      throw new GeneratorError(
        "ERR_CORPUS_INVALID",
        `${file}: "expected" is not a valid spec: ${JSON.stringify(result.errors)}`,
      );
    }
    return { name: file.replace(/\.json$/, ""), prompt, expected: result.spec };
  });
}
