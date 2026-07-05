/**
 * Machine-readable errors for the generator package itself (as opposed to
 * spec validation errors, which are `SpecError` from @openrupiv/spec and
 * flow through the retry loop). Codes are stable API; messages are not.
 */

export type GeneratorErrorCode =
  /** No Anthropic API key was provided (constructor arg or ANTHROPIC_API_KEY). */
  | "ERR_NO_API_KEY"
  /** A FakeSpecModel ran out of scripted responses. */
  | "ERR_FAKE_EXHAUSTED"
  /** A corpus file is missing, malformed, or contains an invalid spec. */
  | "ERR_CORPUS_INVALID";

export class GeneratorError extends Error {
  readonly code: GeneratorErrorCode;

  constructor(code: GeneratorErrorCode, message: string) {
    super(message);
    this.name = "GeneratorError";
    this.code = code;
  }
}
