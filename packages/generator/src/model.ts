/**
 * The narrow model seam (specs/phase-1-contracts.md §3): everything the
 * generator needs from an LLM is `complete(request) -> text`. Tests run on
 * FakeSpecModel; the eval script and the CLI run on AnthropicSpecModel.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GeneratorError } from "./errors";

export interface SpecModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface SpecModel {
  complete(req: SpecModelRequest): Promise<string>;
}

/** Default model for spec generation; override via the constructor. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/**
 * Real model behind the SpecModel seam. The API key comes from the
 * constructor or the ANTHROPIC_API_KEY environment variable and is handed
 * straight to the SDK — it is never logged and never written to disk.
 */
export class AnthropicSpecModel implements SpecModel {
  /** Anthropic model id in use (exposed for diagnostics; safe to log). */
  readonly modelId: string;

  private readonly client: Anthropic;

  constructor(opts?: { apiKey?: string; model?: string }) {
    const apiKey = opts?.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new GeneratorError(
        "ERR_NO_API_KEY",
        "no Anthropic API key: pass { apiKey } to AnthropicSpecModel or set the ANTHROPIC_API_KEY environment variable",
      );
    }
    this.client = new Anthropic({ apiKey });
    this.modelId = opts?.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  async complete(req: SpecModelRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    return text;
  }
}

/**
 * Scripted model for tests: returns the given responses in order and records
 * every request it receives. Running past the script is a hard, typed error
 * — never a silent empty response.
 */
export class FakeSpecModel implements SpecModel {
  /** Every request received, in order (for asserting on prompts). */
  readonly requests: SpecModelRequest[] = [];

  private readonly responses: readonly string[];
  private cursor = 0;

  constructor(responses: readonly string[]) {
    this.responses = [...responses];
  }

  complete(req: SpecModelRequest): Promise<string> {
    this.requests.push(req);
    const response = this.responses[this.cursor];
    if (response === undefined) {
      return Promise.reject(
        new GeneratorError(
          "ERR_FAKE_EXHAUSTED",
          `FakeSpecModel has no scripted response for request ${this.cursor + 1} (${this.responses.length} scripted)`,
        ),
      );
    }
    this.cursor += 1;
    return Promise.resolve(response);
  }
}
