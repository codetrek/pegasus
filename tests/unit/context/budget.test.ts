// tests/unit/context/budget.test.ts
import { describe, it, expect } from "bun:test";
import {
  computeTokenBudget,
  estimateTokensFromChars,
} from "../../../src/context/budget.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  TOKEN_ESTIMATION_SAFETY_MARGIN,
  DEFAULT_COMPACT_THRESHOLD,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from "../../../src/context/constants.ts";
import { ModelLimitsCache } from "../../../src/context/model-limits-cache.ts";
import type { ModelLimits } from "../../../src/context/model-limits.ts";

describe("computeTokenBudget", () => {
  it("computes budget for a known model (gpt-4o = 128k)", () => {
    const budget = computeTokenBudget({ modelId: "gpt-4o" });
    expect(budget.contextWindow).toBe(128_000);
    // gpt-4o: maxInputTokens = 128_000, maxOutputTokens = 16_384
    expect(budget.maxOutputTokens).toBe(16_384);
    expect(budget.maxInputTokens).toBe(128_000);
    expect(budget.effectiveInputBudget).toBe(
      Math.floor(budget.maxInputTokens / TOKEN_ESTIMATION_SAFETY_MARGIN),
    );
    expect(budget.compactTrigger).toBe(
      Math.floor(budget.effectiveInputBudget * DEFAULT_COMPACT_THRESHOLD),
    );
    expect(budget.source).toBe("registry");
  });

  it("uses config override when provided", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      configContextWindow: 200_000,
    });
    expect(budget.contextWindow).toBe(200_000);
    // Config override: maxInputTokens = configContextWindow
    expect(budget.maxInputTokens).toBe(200_000);
    expect(budget.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(budget.source).toBe("config");
  });

  it("falls back to default for unknown models", () => {
    const budget = computeTokenBudget({ modelId: "unknown-model-xyz" });
    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.maxInputTokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(budget.source).toBe("default");
  });

  it("uses model-specific output tokens from registry", () => {
    // o1 has 100k output tokens
    const budget = computeTokenBudget({ modelId: "o1" });
    expect(budget.maxOutputTokens).toBe(100_000);
    expect(budget.contextWindow).toBe(200_000);
    expect(budget.maxInputTokens).toBe(200_000);
    expect(budget.source).toBe("registry");
  });

  it("respects custom compact threshold", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      compactThreshold: 0.6,
    });
    expect(budget.compactTrigger).toBe(
      Math.floor(budget.effectiveInputBudget * 0.6),
    );
  });

  it("handles large context window model (claude-sonnet-4.6 = 1M)", () => {
    const budget = computeTokenBudget({ modelId: "claude-sonnet-4.6" });
    expect(budget.contextWindow).toBe(1_000_000);
    expect(budget.maxInputTokens).toBe(1_000_000);
    expect(budget.source).toBe("registry");
  });

  it("maxInputTokens is clamped to hard minimum", () => {
    // Even with an unknown model, maxInputTokens >= CONTEXT_WINDOW_HARD_MIN_TOKENS
    const budget = computeTokenBudget({
      modelId: "unknown",
      configContextWindow: 1_000, // tiny config override
    });
    expect(budget.maxInputTokens).toBe(CONTEXT_WINDOW_HARD_MIN_TOKENS);
    expect(budget.compactTrigger).toBeGreaterThan(0);
  });

  it("clamps context window to hard minimum (with room for output)", () => {
    const budget = computeTokenBudget({
      modelId: "unknown",
      configContextWindow: 1_000, // way below hard minimum
    });
    // Clamped to max(16k, maxOutputTokens + 16k) = max(16k, 16k + 16k) = 32k
    expect(budget.contextWindow).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS + CONTEXT_WINDOW_HARD_MIN_TOKENS,
    );
    expect(budget.compactTrigger).toBeGreaterThan(0); // not zero -- no infinite compact
  });

  it("treats configContextWindow=0 as unset (falsy)", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      configContextWindow: 0,
    });
    // 0 is falsy -> falls through to registry lookup
    expect(budget.contextWindow).toBe(128_000);
    expect(budget.source).toBe("registry");
  });

  it("handles compactThreshold=0 (compact always triggers)", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      compactThreshold: 0,
    });
    expect(budget.compactTrigger).toBe(0);
  });

  it("handles compactThreshold=1 (compact at full budget)", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      compactThreshold: 1.0,
    });
    expect(budget.compactTrigger).toBe(budget.effectiveInputBudget);
  });

  it("handles empty modelId gracefully", () => {
    const budget = computeTokenBudget({ modelId: "" });
    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW); // unknown -> default
    expect(budget.source).toBe("default");
  });

  it("uses modelLimitsCache when provided", () => {
    // Create a cache with custom limits in a temp dir
    const tmpDir = `/tmp/budget-test-cache-${Date.now()}`;
    const cache = new ModelLimitsCache(tmpDir);
    const customLimits: ModelLimits = {
      maxInputTokens: 50_000,
      maxOutputTokens: 8_000,
      contextWindow: 64_000,
    };
    cache.update("test-provider", new Map([["custom-model", customLimits]]));

    const budget = computeTokenBudget({
      modelId: "custom-model",
      provider: "test-provider",
      modelLimitsCache: cache,
    });

    expect(budget.contextWindow).toBe(64_000);
    expect(budget.maxInputTokens).toBe(50_000);
    expect(budget.maxOutputTokens).toBe(8_000);
    expect(budget.source).toBe("cache");
    expect(budget.effectiveInputBudget).toBe(
      Math.floor(50_000 / TOKEN_ESTIMATION_SAFETY_MARGIN),
    );
  });

  it("falls through cache to registry for known models", () => {
    // Cache exists but model is not in it — should fall to registry
    const tmpDir = `/tmp/budget-test-cache-fallback-${Date.now()}`;
    const cache = new ModelLimitsCache(tmpDir);

    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      modelLimitsCache: cache,
    });

    expect(budget.contextWindow).toBe(128_000);
    expect(budget.source).toBe("registry");
  });

  it("falls through cache to default for unknown models", () => {
    const tmpDir = `/tmp/budget-test-cache-default-${Date.now()}`;
    const cache = new ModelLimitsCache(tmpDir);

    const budget = computeTokenBudget({
      modelId: "totally-unknown-model",
      modelLimitsCache: cache,
    });

    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(budget.source).toBe("default");
  });

  it("handles model with distinct input limit (deepseek-r1)", () => {
    // deepseek-r1: contextWindow=64000, maxInputTokens=56000, maxOutputTokens=8000
    const budget = computeTokenBudget({ modelId: "deepseek-r1" });
    expect(budget.contextWindow).toBe(64_000);
    expect(budget.maxInputTokens).toBe(56_000);
    expect(budget.maxOutputTokens).toBe(8_000);
    expect(budget.effectiveInputBudget).toBe(
      Math.floor(56_000 / TOKEN_ESTIMATION_SAFETY_MARGIN),
    );
    expect(budget.source).toBe("registry");
  });
});

describe("estimateTokensFromChars", () => {
  it("estimates tokens from character count", () => {
    expect(estimateTokensFromChars(3500)).toBe(1000);
    expect(estimateTokensFromChars(7)).toBe(2); // ceil(7/3.5)
    expect(estimateTokensFromChars(0)).toBe(0);
  });
});
