import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratorError } from "../src/errors";
import { AnthropicSpecModel, DEFAULT_ANTHROPIC_MODEL, FakeSpecModel } from "../src/model";

describe("FakeSpecModel", () => {
  it("returns scripted responses in order and records requests", async () => {
    const model = new FakeSpecModel(["one", "two"]);
    const req1 = { system: "s", user: "u1", maxTokens: 10 };
    const req2 = { system: "s", user: "u2", maxTokens: 10 };
    await expect(model.complete(req1)).resolves.toBe("one");
    await expect(model.complete(req2)).resolves.toBe("two");
    expect(model.requests).toEqual([req1, req2]);
  });

  it("fails with a typed error when the script is exhausted", async () => {
    const model = new FakeSpecModel([]);
    const promise = model.complete({ system: "s", user: "u", maxTokens: 10 });
    await expect(promise).rejects.toBeInstanceOf(GeneratorError);
    await expect(
      model.complete({ system: "s", user: "u", maxTokens: 10 }),
    ).rejects.toMatchObject({ code: "ERR_FAKE_EXHAUSTED" });
  });
});

describe("AnthropicSpecModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws a typed error when no API key is available", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    let thrown: unknown;
    try {
      new AnthropicSpecModel();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GeneratorError);
    expect((thrown as GeneratorError).code).toBe("ERR_NO_API_KEY");
  });

  it("never leaks the API key through the error or model id", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      new AnthropicSpecModel();
    } catch (err) {
      expect((err as Error).message).not.toContain("sk-");
    }
    const model = new AnthropicSpecModel({ apiKey: "sk-test-secret-key" });
    expect(model.modelId).not.toContain("sk-test-secret-key");
    expect(Object.keys(model)).not.toContain("apiKey");
  });

  it("defaults to claude-sonnet-5 and accepts a model override", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
    expect(new AnthropicSpecModel().modelId).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    const overridden = new AnthropicSpecModel({ apiKey: "k", model: "claude-opus-4-8" });
    expect(overridden.modelId).toBe("claude-opus-4-8");
  });

  it("prefers an explicit apiKey over the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => new AnthropicSpecModel({ apiKey: "explicit" })).not.toThrow();
  });
});
