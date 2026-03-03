/**
 * Tests for ModelRegistry — tier-based model resolution with caching.
 * Tests for TiersConfigSchema — tier value union type validation.
 *
 * Updated for tier-based API: getDefault, getForTier, resolve, etc.
 */
import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { TiersConfigSchema } from "@pegasus/infra/config-schema.ts";

function baseLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    providers: {
      openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
      anthropic: { apiKey: "sk-ant-test", baseURL: undefined, type: undefined },
    },
    default: "openai/gpt-4o",
    tiers: {},
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
    ...overrides,
  };
}

describe("ModelRegistry", () => {
  // ── Core tier-based API tests ─────────────────────────

  test("getDefault() returns model with correct modelId", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const model = registry.getDefault();
    expect(model.modelId).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
  });

  test('getForTier("fast") falls back to default when tiers not configured', () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const fastModel = registry.getForTier("fast");
    const defaultModel = registry.getDefault();
    // Same spec → same cached instance
    expect(fastModel).toBe(defaultModel);
  });

  test('getForTier("fast") returns tier-specific model when configured', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
      },
    }));
    const fastModel = registry.getForTier("fast");
    const defaultModel = registry.getDefault();
    expect(fastModel.modelId).toBe("gpt-4o-mini");
    expect(defaultModel.modelId).toBe("gpt-4o");
    expect(fastModel).not.toBe(defaultModel);
  });

  test('getForTier("balanced") and getForTier("powerful") work independently', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        balanced: "openai/gpt-4o-mini",
        powerful: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.getDefault().modelId).toBe("gpt-4o");
    expect(registry.getForTier("balanced").modelId).toBe("gpt-4o-mini");
    expect(registry.getForTier("powerful").modelId).toBe("claude-haiku-3.5");
    // fast is not configured → falls back to default
    expect(registry.getForTier("fast")).toBe(registry.getDefault());
  });

  test("same spec across tiers returns same cached instance", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        balanced: "openai/gpt-4o", // same as default
      },
    }));
    const defaultModel = registry.getDefault();
    const balancedModel = registry.getForTier("balanced");
    expect(defaultModel).toBe(balancedModel);
  });

  test("all tiers can be configured independently", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: "openai/gpt-4o-mini",
        powerful: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.getDefault().modelId).toBe("gpt-4o");
    expect(registry.getForTier("fast").modelId).toBe("gpt-4o-mini");
    expect(registry.getForTier("balanced").modelId).toBe("gpt-4o-mini");
    expect(registry.getForTier("powerful").modelId).toBe("claude-haiku-3.5");
    // fast and balanced share same spec → same instance
    expect(registry.getForTier("fast")).toBe(registry.getForTier("balanced"));
  });

  // ── ModelId extraction tests ──────────────────────────

  test("getDefaultModelId() extracts model name", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    expect(registry.getDefaultModelId()).toBe("gpt-4o");
  });

  test("getModelIdForTier() works for configured and fallback tiers", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.getModelIdForTier("fast")).toBe("claude-haiku-3.5");
    // Unconfigured tier falls back to default
    expect(registry.getModelIdForTier("balanced")).toBe("gpt-4o");
    expect(registry.getModelIdForTier("powerful")).toBe("gpt-4o");
  });

  // ── resolve() tests ───────────────────────────────────

  test('resolve("openai/gpt-4o") — specific model spec (has "/")', () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const model = registry.resolve("openai/gpt-4o");
    expect(model.modelId).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
  });

  test('resolve("fast") — tier name (no "/")', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: { fast: "openai/gpt-4o-mini" },
    }));
    const model = registry.resolve("fast");
    expect(model.modelId).toBe("gpt-4o-mini");
  });

  test('resolve("balanced") — tier name', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: { balanced: "anthropic/claude-haiku-3.5" },
    }));
    const model = registry.resolve("balanced");
    expect(model.modelId).toBe("claude-haiku-3.5");
    expect(model.provider).toBe("anthropic");
  });

  test("resolve() with unknown tier name falls back to default", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    // "unknown" has no "/", treated as tier name, not found → falls back to default
    const model = registry.resolve("unknown");
    expect(model.modelId).toBe("gpt-4o");
  });

  test("resolve() with direct spec caches same as getDefault()", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const viaResolve = registry.resolve("openai/gpt-4o");
    const viaDefault = registry.getDefault();
    // Same spec → same cached instance
    expect(viaResolve).toBe(viaDefault);
  });

  // ── Error cases ───────────────────────────────────────

  test("invalid spec (no slash) in default throws on model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "gpt-4o", // no provider prefix
    }));
    expect(() => registry.getDefault()).toThrow('Invalid model spec "gpt-4o"');
  });

  test("unknown provider throws", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "unknown-provider/gpt-4o",
    }));
    expect(() => registry.getDefault()).toThrow('Provider "unknown-provider" not found');
  });

  test("custom provider with explicit type works", () => {
    const registry = new ModelRegistry({
      ...baseLLMConfig(),
      providers: {
        ...baseLLMConfig().providers,
        myhost: { apiKey: "key", baseURL: "http://localhost:8080/v1", type: "openai" },
      },
      default: "myhost/my-model",
    });
    const model = registry.getDefault();
    expect(model.modelId).toBe("my-model");
    expect(model.provider).toBe("openai");
  });

  test("anthropic provider creates model with correct provider", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "anthropic/claude-sonnet-4",
    }));
    const model = registry.getDefault();
    expect(model.modelId).toBe("claude-sonnet-4");
    expect(model.provider).toBe("anthropic");
  });

  // ── Context window tests ──────────────────────────────

  test("getDefaultContextWindow() returns undefined for string values", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    expect(registry.getDefaultContextWindow()).toBeUndefined();
  });

  test("getDefaultContextWindow() returns value for object values", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o", contextWindow: 128_000 },
    }));
    expect(registry.getDefaultContextWindow()).toBe(128_000);
  });

  test("getContextWindowForTier() returns tier-specific values", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
        powerful: { model: "anthropic/claude-haiku-3.5", contextWindow: 16_000 },
      },
    }));
    expect(registry.getContextWindowForTier("fast")).toBeUndefined();
    expect(registry.getContextWindowForTier("balanced")).toBe(32_000);
    expect(registry.getContextWindowForTier("powerful")).toBe(16_000);
  });

  test("getContextWindowForTier() falls back to default for unconfigured tiers", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o", contextWindow: 128_000 },
    }));
    // All unconfigured tiers fall back to default's contextWindow
    expect(registry.getContextWindowForTier("fast")).toBe(128_000);
    expect(registry.getContextWindowForTier("balanced")).toBe(128_000);
    expect(registry.getContextWindowForTier("powerful")).toBe(128_000);
  });

  test("object tier values work correctly with getForTier() and getModelIdForTier()", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o", contextWindow: 128_000 },
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
      },
    }));

    // getForTier() should resolve models correctly
    expect(registry.getDefault().modelId).toBe("gpt-4o");
    expect(registry.getForTier("balanced").modelId).toBe("gpt-4o-mini");
    expect(registry.getForTier("fast").modelId).toBe("gpt-4o-mini");

    // getModelIdForTier() should extract model name
    expect(registry.getDefaultModelId()).toBe("gpt-4o");
    expect(registry.getModelIdForTier("balanced")).toBe("gpt-4o-mini");

    // balanced (object) and fast (string) with same model spec → same cached instance
    expect(registry.getForTier("balanced")).toBe(registry.getForTier("fast"));

    // contextWindow should return per-tier values
    expect(registry.getDefaultContextWindow()).toBe(128_000);
    expect(registry.getContextWindowForTier("balanced")).toBe(32_000);
    expect(registry.getContextWindowForTier("fast")).toBeUndefined();
    // powerful falls back to default
    expect(registry.getContextWindowForTier("powerful")).toBe(128_000);
  });

  test("object default without contextWindow returns undefined for getDefaultContextWindow", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o" },
    }));
    expect(registry.getDefaultContextWindow()).toBeUndefined();
    expect(registry.getDefault().modelId).toBe("gpt-4o");
  });

  // ── setCodexCredentials tests ──────────────────────────

  test("setCodexCredentials enables codex model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "codex/gpt-5.3-codex",
    }));

    // Without credentials, codex model throws
    expect(() => registry.getDefault()).toThrow("requires OAuth authentication");

    // Set credentials
    registry.setCodexCredentials({
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3600000,
      accountId: "acct-123",
    });

    // Now it works
    const model = registry.getDefault();
    expect(model.provider).toBe("openai-codex");
    expect(model.modelId).toBe("gpt-5.3-codex");
  });

  test("setCodexCredentials invalidates cached codex models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "codex/gpt-5.3-codex",
    }));

    // Set initial credentials and create model
    registry.setCodexCredentials({
      accessToken: "token-v1",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });
    const model1 = registry.getDefault();

    // Update credentials — should invalidate cache
    registry.setCodexCredentials({
      accessToken: "token-v2",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });
    const model2 = registry.getDefault();

    // Should be a different instance (re-created with new token)
    expect(model1).not.toBe(model2);
  });

  test("setCodexCredentials does not invalidate non-codex cached models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "codex/gpt-5.3-codex",
      },
    }));

    // Create and cache the openai model via getDefault
    const openaiModel1 = registry.getDefault();

    // Set codex credentials
    registry.setCodexCredentials({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });

    // OpenAI model should still be the same cached instance
    const openaiModel2 = registry.getDefault();
    expect(openaiModel1).toBe(openaiModel2);
  });

  // ── setCopilotCredentials tests ──────────────────────────

  test("setCopilotCredentials enables copilot model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "copilot/gpt-4o",
    }));

    // Without credentials, copilot model throws
    expect(() => registry.getDefault()).toThrow("requires authentication");

    // Set credentials
    registry.setCopilotCredentials(
      "tid=test;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );

    // Now it works
    const model = registry.getDefault();
    expect(model.provider).toBe("copilot");
    expect(model.modelId).toBe("gpt-4o");
  });

  test("setCopilotCredentials invalidates cached copilot models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "copilot/gpt-4o",
    }));

    // Set initial credentials and create model
    registry.setCopilotCredentials(
      "tid=v1;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );
    const model1 = registry.getDefault();

    // Update credentials — should invalidate cache
    registry.setCopilotCredentials(
      "tid=v2;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );
    const model2 = registry.getDefault();

    // Should be a different instance (re-created with new token)
    expect(model1).not.toBe(model2);
  });

  test("setCopilotCredentials does not invalidate non-copilot cached models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "copilot/gpt-4o",
      },
    }));

    // Create and cache the openai model via getDefault
    const openaiModel1 = registry.getDefault();

    // Set copilot credentials
    registry.setCopilotCredentials(
      "tid=tok;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );

    // OpenAI model should still be the same cached instance
    const openaiModel2 = registry.getDefault();
    expect(openaiModel1).toBe(openaiModel2);
  });

  // ── setOAuthCredentials tests ──────────────────────────

  test("setOAuthCredentials stores credentials for a provider", () => {
    const registry = new ModelRegistry(baseLLMConfig());

    // Should not throw
    registry.setOAuthCredentials(
      "custom-oauth",
      { access: "tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
      "https://custom.example.com/v1",
    );
  });

  test("setOAuthCredentials invalidates cached models for the provider", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      providers: {
        openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
        myoauth: { apiKey: "tok1", baseURL: "https://custom.example.com/v1", type: "openai" },
      },
      tiers: {
        fast: "myoauth/my-model",
      },
    }));

    // Create and cache both models
    const openaiModel1 = registry.getDefault();
    const oauthModel1 = registry.getForTier("fast");

    // Set OAuth credentials for "openai" provider — should invalidate its cache
    registry.setOAuthCredentials(
      "openai", // match the piProvider resolved name, since myoauth type: "openai" → piProvider = "openai"
      { access: "new-tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
    );

    // openai model was invalidated (provider matches "openai")
    const openaiModel2 = registry.getDefault();
    expect(openaiModel1).not.toBe(openaiModel2);

    // myoauth model cache key uses the resolved provider "openai",
    // so it was also invalidated
    const oauthModel2 = registry.getForTier("fast");
    expect(oauthModel1).not.toBe(oauthModel2);
  });

  test("setOAuthCredentials does not invalidate models for other providers", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      providers: {
        openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
        anthropic: { apiKey: "sk-ant-test", baseURL: undefined, type: undefined },
      },
      tiers: {
        fast: "anthropic/claude-haiku-3.5",
      },
    }));

    // Create and cache both models
    const openaiModel1 = registry.getDefault();
    const anthropicModel1 = registry.getForTier("fast");

    // Set OAuth credentials for "some-other" — should not invalidate any existing caches
    registry.setOAuthCredentials(
      "some-other",
      { access: "tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
    );

    // Both should be same cached instances
    const openaiModel2 = registry.getDefault();
    const anthropicModel2 = registry.getForTier("fast");
    expect(openaiModel1).toBe(openaiModel2);
    expect(anthropicModel1).toBe(anthropicModel2);
  });
});

// ── TiersConfigSchema + RoleValueSchema validation tests ─────────────

describe("TiersConfigSchema", () => {
  test("accepts all string tier values", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
      balanced: "openai/gpt-4o",
      powerful: "anthropic/claude-haiku-3.5",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBe("openai/gpt-4o");
  });

  test("accepts object tier values with contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
      powerful: { model: "openai/gpt-4o", contextWindow: 128_000 },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o-mini", contextWindow: 32_000 });
    expect(result.powerful).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000 });
  });

  test("accepts object tier values without contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o" });
  });

  test("accepts mixed string and object tier values", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
      balanced: { model: "openai/gpt-4o", contextWindow: 128_000 },
      powerful: { model: "anthropic/claude-haiku-3.5", contextWindow: 16_000 },
    });
    expect(typeof result.fast).toBe("string");
    expect(typeof result.balanced).toBe("object");
    expect(typeof result.powerful).toBe("object");
  });

  test("coerces contextWindow string to number", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: "128000" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000 });
  });

  test("rejects object tier value without model field", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { contextWindow: 128_000 },
    })).toThrow();
  });

  test("rejects negative contextWindow", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: -1 },
    })).toThrow();
  });

  test("accepts object tier values with apiType", () => {
    const result = TiersConfigSchema.parse({
      powerful: { model: "myhost/claude-sonnet-4", apiType: "anthropic" },
    });
    expect(result.powerful).toEqual({ model: "myhost/claude-sonnet-4", apiType: "anthropic" });
  });

  test("accepts object tier values with apiType and contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: 128_000, apiType: "openai" },
      powerful: { model: "myhost/claude-sonnet-4", contextWindow: 200_000, apiType: "anthropic" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000, apiType: "openai" });
    expect(result.powerful).toEqual({ model: "myhost/claude-sonnet-4", contextWindow: 200_000, apiType: "anthropic" });
  });

  test("rejects invalid apiType value", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", apiType: "invalid" },
    })).toThrow();
  });

  test("defaults to empty object", () => {
    const result = TiersConfigSchema.parse(undefined);
    expect(result).toEqual({});
  });

  test("all tier fields are optional", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBeUndefined();
    expect(result.powerful).toBeUndefined();
  });
});
