import { describe, it, expect } from "bun:test";
import { LLMConfigSchema } from "../../../src/infra/config-schema.ts";

describe("LLMConfigSchema openrouter", () => {
  it("accepts openrouter config with enabled and apiKey", () => {
    const result = LLMConfigSchema.parse({
      openrouter: { enabled: true, apiKey: "sk-or-test" },
    });
    expect(result.openrouter.enabled).toBe(true);
    expect(result.openrouter.apiKey).toBe("sk-or-test");
  });

  it("defaults openrouter to disabled", () => {
    const result = LLMConfigSchema.parse({});
    expect(result.openrouter.enabled).toBe(false);
    expect(result.openrouter.apiKey).toBeUndefined();
  });

  it("handles string 'true' for enabled", () => {
    const result = LLMConfigSchema.parse({
      openrouter: { enabled: "true", apiKey: "key" },
    });
    expect(result.openrouter.enabled).toBe(true);
  });

  it("handles string 'false' for enabled", () => {
    const result = LLMConfigSchema.parse({
      openrouter: { enabled: "false" },
    });
    expect(result.openrouter.enabled).toBe(false);
  });
});
