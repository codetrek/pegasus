import { describe, it, expect } from "bun:test";
import { ModelRegistry } from "../../../src/infra/model-registry.ts";

// Helper to create a valid LLMConfig for ModelRegistry constructor
function makeLLMConfig(overrides: Record<string, any> = {}) {
  return {
    providers: {},
    default: "openai/gpt-4o-mini",
    tiers: {},
    codex: { enabled: false, baseURL: "", model: "" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
    maxConcurrentCalls: 3,
    timeout: 120,
    ...overrides,
  };
}

describe("ModelRegistry provider extraction", () => {
  it("getDefaultProvider returns provider from default spec", () => {
    const registry = new ModelRegistry(makeLLMConfig({ default: "copilot/gpt-4o" }));
    expect(registry.getDefaultProvider()).toBe("copilot");
  });

  it("getDefaultProvider returns empty string when no slash in spec", () => {
    const registry = new ModelRegistry(makeLLMConfig({ default: "gpt-4o" }));
    expect(registry.getDefaultProvider()).toBe("");
  });

  it("getProviderForTier returns provider for configured tier", () => {
    const registry = new ModelRegistry(makeLLMConfig({
      default: "copilot/gpt-4o",
      tiers: { fast: "openai/gpt-4o-mini" },
    }));
    expect(registry.getProviderForTier("fast")).toBe("openai");
  });

  it("getProviderForTier falls back to default provider when tier not set", () => {
    const registry = new ModelRegistry(makeLLMConfig({
      default: "copilot/gpt-4o",
      tiers: {},
    }));
    expect(registry.getProviderForTier("fast")).toBe("copilot");
  });

  it("getProviderForTier handles object-form role value", () => {
    const registry = new ModelRegistry(makeLLMConfig({
      default: "copilot/gpt-4o",
      tiers: { balanced: { model: "anthropic/claude-sonnet-4" } },
    }));
    expect(registry.getProviderForTier("balanced")).toBe("anthropic");
  });
});
