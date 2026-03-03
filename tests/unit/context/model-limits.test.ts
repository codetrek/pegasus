// tests/unit/context/model-limits.test.ts
import { describe, it, expect } from "bun:test";
import {
  type ModelLimits,
  DEFAULT_MODEL_LIMITS,
  MODEL_LIMITS,
  getModelLimits,
} from "../../../src/context/model-limits.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../../src/context/constants.ts";

describe("ModelLimits", () => {
  describe("interface shape", () => {
    it("DEFAULT_MODEL_LIMITS has all required fields", () => {
      const limits: ModelLimits = DEFAULT_MODEL_LIMITS;
      expect(limits).toHaveProperty("maxInputTokens");
      expect(limits).toHaveProperty("maxOutputTokens");
      expect(limits).toHaveProperty("contextWindow");
    });
  });

  describe("DEFAULT_MODEL_LIMITS values", () => {
    it("has expected default values", () => {
      expect(DEFAULT_MODEL_LIMITS.maxInputTokens).toBe(128_000);
      expect(DEFAULT_MODEL_LIMITS.maxOutputTokens).toBe(16_000);
      expect(DEFAULT_MODEL_LIMITS.contextWindow).toBe(128_000);
    });

    it("maxInputTokens <= contextWindow", () => {
      expect(DEFAULT_MODEL_LIMITS.maxInputTokens).toBeLessThanOrEqual(
        DEFAULT_MODEL_LIMITS.contextWindow,
      );
    });

    it("maxOutputTokens matches DEFAULT_MAX_OUTPUT_TOKENS constant", () => {
      expect(DEFAULT_MODEL_LIMITS.maxOutputTokens).toBe(
        DEFAULT_MAX_OUTPUT_TOKENS,
      );
    });
  });

  describe("MODEL_LIMITS registry", () => {
    it("contains known OpenAI models", () => {
      expect(MODEL_LIMITS["gpt-4o"]).toBeDefined();
      expect(MODEL_LIMITS["gpt-4.1"]).toBeDefined();
      expect(MODEL_LIMITS["o3"]).toBeDefined();
    });

    it("contains known Anthropic models", () => {
      expect(MODEL_LIMITS["claude-sonnet-4"]).toBeDefined();
      expect(MODEL_LIMITS["claude-opus-4"]).toBeDefined();
      expect(MODEL_LIMITS["claude-sonnet-4.5"]).toBeDefined();
    });

    it("contains known Gemini models", () => {
      expect(MODEL_LIMITS["gemini-2.5-pro"]).toBeDefined();
      expect(MODEL_LIMITS["gemini-2.5-flash"]).toBeDefined();
    });

    it("contains known DeepSeek models", () => {
      expect(MODEL_LIMITS["deepseek-chat"]).toBeDefined();
      expect(MODEL_LIMITS["deepseek-r1"]).toBeDefined();
      expect(MODEL_LIMITS["deepseek-reasoner"]).toBeDefined();
    });

    it("contains known Chinese provider models", () => {
      expect(MODEL_LIMITS["glm-5"]).toBeDefined();
      expect(MODEL_LIMITS["kimi-k2.5"]).toBeDefined();
      expect(MODEL_LIMITS["qwen3-max"]).toBeDefined();
      expect(MODEL_LIMITS["minimax-m1"]).toBeDefined();
    });

    it("every entry has positive numbers", () => {
      for (const [, limits] of Object.entries(MODEL_LIMITS)) {
        expect(limits.maxInputTokens).toBeGreaterThan(0);
        expect(limits.maxOutputTokens).toBeGreaterThan(0);
        expect(limits.contextWindow).toBeGreaterThan(0);
      }
    });

    it("every entry has maxInputTokens <= contextWindow", () => {
      for (const [, limits] of Object.entries(MODEL_LIMITS)) {
        expect(limits.maxInputTokens).toBeLessThanOrEqual(
          limits.contextWindow,
        );
      }
    });

    it("deepseek-r1 has maxInputTokens < contextWindow", () => {
      const r1 = MODEL_LIMITS["deepseek-r1"]!;
      expect(r1).toBeDefined();
      expect(r1.contextWindow).toBe(64_000);
      expect(r1.maxInputTokens).toBe(56_000);
      expect(r1.maxOutputTokens).toBe(8_000);
      expect(r1.maxInputTokens).toBeLessThan(r1.contextWindow);
    });

    it("o-series reasoning models have 100k maxOutputTokens", () => {
      for (const modelId of ["o1", "o3", "o3-pro", "o4-mini"]) {
        const limits = MODEL_LIMITS[modelId]!;
        expect(limits).toBeDefined();
        expect(limits.maxOutputTokens).toBe(100_000);
      }
    });

    it("Gemini models have 65k maxOutputTokens", () => {
      for (const modelId of ["gemini-2.5-pro", "gemini-2.5-flash"]) {
        const limits = MODEL_LIMITS[modelId]!;
        expect(limits).toBeDefined();
        expect(limits.maxOutputTokens).toBe(65_536);
      }
    });
  });

  describe("getModelLimits", () => {
    it("returns correct limits for a known model", () => {
      const limits = getModelLimits("gpt-4o")!;
      expect(limits).toBeDefined();
      expect(limits.contextWindow).toBe(128_000);
      expect(limits.maxInputTokens).toBe(128_000);
    });

    it("strips YYYYMMDD date suffix", () => {
      const limits = getModelLimits("claude-sonnet-4-20250514")!;
      expect(limits).toBeDefined();
      expect(limits.contextWindow).toBe(
        MODEL_LIMITS["claude-sonnet-4"]!.contextWindow,
      );
    });

    it("strips YYYY-MM-DD date suffix", () => {
      const limits = getModelLimits("gpt-4o-2024-08-06")!;
      expect(limits).toBeDefined();
      expect(limits.contextWindow).toBe(
        MODEL_LIMITS["gpt-4o"]!.contextWindow,
      );
    });

    it("strips short date suffix (4 digits)", () => {
      const limits = getModelLimits("claude-sonnet-4-0528")!;
      expect(limits).toBeDefined();
      expect(limits.contextWindow).toBe(
        MODEL_LIMITS["claude-sonnet-4"]!.contextWindow,
      );
    });

    it("returns undefined for unknown model", () => {
      const limits = getModelLimits("totally-unknown-model-xyz");
      expect(limits).toBeUndefined();
    });

    it("returns undefined for unknown model even after stripping suffix", () => {
      const limits = getModelLimits("unknown-model-20250514");
      expect(limits).toBeUndefined();
    });

    it("returns exact match over stripped match", () => {
      // If a model exists with the exact ID, it should be returned directly
      const limits = getModelLimits("deepseek-r1")!;
      expect(limits).toBeDefined();
      expect(limits.maxInputTokens).toBe(56_000);
    });
  });
});
