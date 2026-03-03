// tests/unit/context/budget.test.ts
import { describe, it, expect } from "bun:test";
import {
  computeTokenBudget,
  estimateTokensFromChars,
} from "../../../src/context/budget.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MIN_OUTPUT_RESERVE_TOKENS,
  TOKEN_ESTIMATION_SAFETY_MARGIN,
  DEFAULT_COMPACT_THRESHOLD,
} from "../../../src/context/constants.ts";

describe("computeTokenBudget", () => {
  it("computes budget for a known model (gpt-4o = 128k)", () => {
    const budget = computeTokenBudget({ modelId: "gpt-4o" });
    expect(budget.contextWindow).toBe(128_000);
    expect(budget.outputReserve).toBe(DEFAULT_OUTPUT_RESERVE_TOKENS);
    expect(budget.inputBudget).toBe(128_000 - DEFAULT_OUTPUT_RESERVE_TOKENS);
    expect(budget.effectiveInputBudget).toBe(
      Math.floor(budget.inputBudget / TOKEN_ESTIMATION_SAFETY_MARGIN),
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
    expect(budget.source).toBe("config");
  });

  it("falls back to default for unknown models", () => {
    const budget = computeTokenBudget({ modelId: "unknown-model-xyz" });
    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.source).toBe("default");
  });

  it("respects custom output reserve", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      outputReserveTokens: 32_000,
    });
    expect(budget.outputReserve).toBe(32_000);
    expect(budget.inputBudget).toBe(128_000 - 32_000);
  });

  it("enforces minimum output reserve", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      outputReserveTokens: 100, // below MIN_OUTPUT_RESERVE_TOKENS
    });
    expect(budget.outputReserve).toBe(MIN_OUTPUT_RESERVE_TOKENS);
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
    expect(budget.inputBudget).toBe(1_000_000 - DEFAULT_OUTPUT_RESERVE_TOKENS);
    expect(budget.source).toBe("registry");
  });

  it("inputBudget never negative even with huge outputReserve", () => {
    const budget = computeTokenBudget({
      modelId: "gpt-4o",
      outputReserveTokens: 999_999,
    });
    expect(budget.inputBudget).toBeGreaterThanOrEqual(0);
  });

  it("clamps context window to hard minimum (with room for input)", () => {
    const budget = computeTokenBudget({
      modelId: "unknown",
      configContextWindow: 1_000, // way below hard minimum
    });
    // Clamped to outputReserve + CONTEXT_WINDOW_HARD_MIN_TOKENS = 16k + 16k = 32k
    expect(budget.contextWindow).toBe(32_000);
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
});

describe("estimateTokensFromChars", () => {
  it("estimates tokens from character count", () => {
    expect(estimateTokensFromChars(3500)).toBe(1000);
    expect(estimateTokensFromChars(7)).toBe(2); // ceil(7/3.5)
    expect(estimateTokensFromChars(0)).toBe(0);
  });
});
