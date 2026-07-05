/**
 * @openrupiv/generator — LLM -> app spec, nothing else (ADR-0001).
 * Contract: specs/phase-1-contracts.md §3.
 */

export { GeneratorError, type GeneratorErrorCode } from "./errors";
export {
  AnthropicSpecModel,
  DEFAULT_ANTHROPIC_MODEL,
  FakeSpecModel,
  type SpecModel,
  type SpecModelRequest,
} from "./model";
export { generateSpec, MAX_ATTEMPTS, type GenerateResult } from "./generate";
export { compareSpecs, type SpecDiff } from "./compare";
export { CORPUS_DIR, loadCorpus, type CorpusEntry } from "./corpus";
export {
  buildRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  GENERATE_MAX_TOKENS,
} from "./prompt";
export { extractSpecJson, type ParsedCandidate } from "./parse";
