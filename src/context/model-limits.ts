/**
 * Model limits registry — stores maxInputTokens, maxOutputTokens, and contextWindow
 * for known LLM models.
 *
 * This replaces the older CONTEXT_WINDOWS (context-windows.ts) which only stored
 * context window sizes. The new format supports real provider-reported input limits
 * that may differ from the context window.
 *
 * Data sourced from OpenRouter API (https://openrouter.ai/api/v1/models)
 * and provider documentation. Last updated: 2026-02-26.
 *
 * Model IDs are stored WITHOUT provider prefix (e.g. "gpt-4o" not "openai/gpt-4o")
 * to match what LanguageModel.modelId typically contains.
 *
 * Date-suffixed variants (e.g. "claude-sonnet-4-20250514") are NOT listed here;
 * getModelLimits() auto-strips date suffixes before lookup.
 */

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./constants.ts";

// ── Types ──

/** Token limits for a single model. */
export interface ModelLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindow: number;
}

// ── Defaults ──

/** Fallback limits when model is unknown. */
export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  maxInputTokens: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
};

// ── Helpers ──

/**
 * Build ModelLimits for models where maxInputTokens = contextWindow.
 * This is the common case — most providers don't distinguish input vs context.
 */
function cw(
  contextWindow: number,
  maxOutputTokens: number = 16_384,
): ModelLimits {
  return { maxInputTokens: contextWindow, maxOutputTokens, contextWindow };
}

/**
 * Build ModelLimits for models where maxInputTokens < contextWindow.
 * Used when the provider reports a distinct input limit.
 */
function ml(
  contextWindow: number,
  maxInputTokens: number,
  maxOutputTokens: number,
): ModelLimits {
  return { maxInputTokens, maxOutputTokens, contextWindow };
}

// ── Static Registry ──

export const MODEL_LIMITS: Record<string, ModelLimits> = {
  // ── OpenAI ──

  // GPT-4.1 family (1M context)
  "gpt-4.1": cw(1_047_576),
  "gpt-4.1-mini": cw(1_047_576),
  "gpt-4.1-nano": cw(1_047_576),

  // GPT-5 family (400k context)
  "gpt-5": cw(400_000),
  "gpt-5-mini": cw(400_000),
  "gpt-5-pro": cw(400_000),
  "gpt-5-codex": cw(400_000),
  "gpt-5.1": cw(400_000),
  "gpt-5.1-codex": cw(400_000),
  "gpt-5.2": cw(400_000),
  "gpt-5.2-codex": cw(400_000),
  "gpt-5.2-pro": cw(400_000),
  "gpt-5.3-codex": cw(400_000),

  // GPT-4o family (128k context)
  "gpt-4o": cw(128_000),
  "gpt-4o-mini": cw(128_000),

  // o-series reasoning models (100k output for extended thinking)
  "o1": cw(200_000, 100_000),
  "o3": cw(200_000, 100_000),
  "o3-pro": cw(200_000, 100_000),
  "o4-mini": cw(200_000, 100_000),

  // ── Anthropic ──

  // Claude 4.6 (1M context)
  "claude-sonnet-4.6": cw(1_000_000),
  "claude-opus-4.6": cw(1_000_000),

  // Claude 4.5
  "claude-sonnet-4.5": cw(1_000_000),
  "claude-opus-4.5": cw(200_000),
  "claude-haiku-4.5": cw(200_000),

  // Claude 4.x
  "claude-opus-4": cw(200_000),
  "claude-opus-4.1": cw(200_000),
  "claude-sonnet-4": cw(1_000_000),

  // ── Google Gemini ── (65k output)

  // Gemini 3.x
  "gemini-3.1-pro-preview": cw(1_048_576, 65_536),
  "gemini-3-pro-preview": cw(1_048_576, 65_536),
  "gemini-3-flash-preview": cw(1_048_576, 65_536),

  // Gemini 2.5
  "gemini-2.5-pro": cw(1_048_576, 65_536),
  "gemini-2.5-pro-preview": cw(1_048_576, 65_536),
  "gemini-2.5-flash": cw(1_048_576, 65_536),
  "gemini-2.5-flash-lite": cw(1_048_576, 65_536),

  // ── Meta Llama ──
  "llama-4-maverick": cw(1_048_576),
  "llama-4-scout": cw(327_680),
  "llama-3.3-70b-instruct": cw(131_072),

  // ── Mistral ──
  "mistral-large": cw(128_000),
  "mistral-medium-3.1": cw(131_072),
  "mistral-medium-3": cw(131_072),
  "codestral": cw(256_000),
  "devstral-medium": cw(131_072),

  // ── xAI Grok ──
  "grok-4": cw(256_000),
  "grok-4-fast": cw(2_000_000),
  "grok-4.1-fast": cw(2_000_000),

  // ── DeepSeek ── (8k output)
  "deepseek-chat": cw(163_840, 8_192),
  "deepseek-r1": ml(64_000, 56_000, 8_000),
  "deepseek-reasoner": cw(163_840, 8_192),
  "deepseek-v3.2": cw(163_840, 8_192),

  // ── 智谱 GLM (Zhipu / z-ai) ──
  "glm-5": cw(204_800),
  "glm-4.7": cw(202_752),
  "glm-4.7-flash": cw(202_752),

  // ── 月之暗面 Kimi (Moonshot) ──
  "kimi-k2.5": cw(262_144),
  "kimi-k2": cw(131_072),

  // ── 阿里 通义千问 (Qwen) ──

  // Qwen 3.5
  "qwen3.5-397b-a17b": cw(262_144),
  "qwen3.5-122b-a10b": cw(262_144),
  "qwen3.5-35b-a3b": cw(262_144),
  "qwen3.5-27b": cw(262_144),

  // Qwen 3
  "qwen3-max": cw(262_144),
  "qwen3-coder": cw(262_144),
  "qwen3-coder-plus": cw(1_000_000),

  // Qwen commercial API aliases
  "qwen-max": cw(32_768),
  "qwen-plus": cw(1_000_000),
  "qwen-long": cw(10_000_000),

  // ── MiniMax ──
  "minimax-m1": cw(1_000_000),
  "minimax-m2.5": cw(196_608),

  // ── 字节跳动 豆包 (ByteDance Seed) ──
  "seed-1.6": cw(262_144),
  "seed-1.6-flash": cw(262_144),

  // ── 阶跃星辰 StepFun ──
  "step-3.5-flash": cw(256_000),

  // ── 百度 ERNIE (Baidu) ──
  "ernie-4.5-300b-a47b": cw(123_000),

  // ── 腾讯 Hunyuan (Tencent) ──
  "hunyuan-a13b-instruct": cw(131_072),

  // ── 小米 Xiaomi ──
  "mimo-v2-flash": cw(262_144),

  // ── Amazon Nova ──
  "nova-premier-v1": cw(1_000_000),
  "nova-pro-v1": cw(300_000),

  // ── Cohere ──
  "command-a": cw(256_000),
};

// ── Lookup ──

/**
 * Get model limits for a model ID. Returns undefined for unknown models.
 *
 * Lookup order:
 * 1. Exact match in MODEL_LIMITS
 * 2. Strip trailing date suffix and retry (e.g. "-20250514", "-2024-08-06", "-0528")
 * 3. undefined
 */
export function getModelLimits(modelId: string): ModelLimits | undefined {
  if (MODEL_LIMITS[modelId]) return MODEL_LIMITS[modelId];

  // Strip date suffix: "-20250514", "-2024-08-06", "-0528", "-2512"
  const stripped = modelId.replace(/-(\d{4}-\d{2}-\d{2}|\d{4,8})$/, "");
  if (stripped !== modelId && MODEL_LIMITS[stripped]) {
    return MODEL_LIMITS[stripped];
  }

  return undefined;
}
