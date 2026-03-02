/**
 * Context window sizes for known LLM models.
 * Used by compact trigger to determine when session is too large.
 *
 * Data sourced from OpenRouter API (https://openrouter.ai/api/v1/models)
 * and provider documentation. Last updated: 2026-02-26.
 *
 * Model IDs are stored WITHOUT provider prefix (e.g. "gpt-4o" not "openai/gpt-4o")
 * to match what LanguageModel.modelId typically contains.
 *
 * Date-suffixed variants (e.g. "claude-sonnet-4-20250514") are NOT listed here;
 * getContextWindowSize() auto-strips date suffixes before lookup.
 */

import { DEFAULT_CONTEXT_WINDOW } from "./constants.ts";

const CONTEXT_WINDOWS: Record<string, number> = {
  // ── OpenAI ──

  // GPT-4.1 family (1M context)
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,

  // GPT-5 family (400k context)
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-pro": 400_000,
  "gpt-5-codex": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.3-codex": 400_000,

  // GPT-4o family (128k context)
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,

  // o-series reasoning models
  "o1": 200_000,
  "o3": 200_000,
  "o3-pro": 200_000,
  "o4-mini": 200_000,

  // ── Anthropic ──

  // Claude 4.6 (1M context)
  "claude-sonnet-4.6": 1_000_000,
  "claude-opus-4.6": 1_000_000,

  // Claude 4.5
  "claude-sonnet-4.5": 1_000_000,
  "claude-opus-4.5": 200_000,
  "claude-haiku-4.5": 200_000,

  // Claude 4.x
  "claude-opus-4": 200_000,
  "claude-opus-4.1": 200_000,
  "claude-sonnet-4": 1_000_000,

  // ── Google Gemini ──

  // Gemini 3.x
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  "gemini-3-flash-preview": 1_048_576,

  // Gemini 2.5
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-pro-preview": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-flash-lite": 1_048_576,

  // ── Meta Llama ──
  "llama-4-maverick": 1_048_576,
  "llama-4-scout": 327_680,
  "llama-3.3-70b-instruct": 131_072,

  // ── Mistral ──
  "mistral-large": 128_000,
  "mistral-medium-3.1": 131_072,
  "mistral-medium-3": 131_072,
  "codestral": 256_000,
  "devstral-medium": 131_072,

  // ── xAI Grok ──
  "grok-4": 256_000,
  "grok-4-fast": 2_000_000,
  "grok-4.1-fast": 2_000_000,

  // ── DeepSeek ──
  "deepseek-chat": 163_840,
  "deepseek-r1": 64_000,
  "deepseek-reasoner": 163_840,
  "deepseek-v3.2": 163_840,

  // ── 智谱 GLM (Zhipu / z-ai) ──
  "glm-5": 204_800,
  "glm-4.7": 202_752,
  "glm-4.7-flash": 202_752,

  // ── 月之暗面 Kimi (Moonshot) ──
  "kimi-k2.5": 262_144,
  "kimi-k2": 131_072,

  // ── 阿里 通义千问 (Qwen) ──

  // Qwen 3.5
  "qwen3.5-397b-a17b": 262_144,
  "qwen3.5-122b-a10b": 262_144,
  "qwen3.5-35b-a3b": 262_144,
  "qwen3.5-27b": 262_144,

  // Qwen 3
  "qwen3-max": 262_144,
  "qwen3-coder": 262_144,
  "qwen3-coder-plus": 1_000_000,

  // Qwen commercial API aliases
  "qwen-max": 32_768,
  "qwen-plus": 1_000_000,
  "qwen-long": 10_000_000,

  // ── MiniMax ──
  "minimax-m1": 1_000_000,
  "minimax-m2.5": 196_608,

  // ── 字节跳动 豆包 (ByteDance Seed) ──
  "seed-1.6": 262_144,
  "seed-1.6-flash": 262_144,

  // ── 阶跃星辰 StepFun ──
  "step-3.5-flash": 256_000,

  // ── 百度 ERNIE (Baidu) ──
  "ernie-4.5-300b-a47b": 123_000,

  // ── 腾讯 Hunyuan (Tencent) ──
  "hunyuan-a13b-instruct": 131_072,

  // ── 小米 Xiaomi ──
  "mimo-v2-flash": 262_144,

  // ── Amazon Nova ──
  "nova-premier-v1": 1_000_000,
  "nova-pro-v1": 300_000,

  // ── Cohere ──
  "command-a": 256_000,
};

/**
 * Get context window size for a model. Falls back to 128k for unknown models.
 *
 * Lookup order:
 * 1. configOverride (user-supplied)
 * 2. Exact match in CONTEXT_WINDOWS
 * 3. Strip trailing date suffix and retry (e.g. "-20250514", "-2024-08-06", "-0528")
 * 4. 128k default
 */
export function getContextWindowSize(
  modelId: string,
  configOverride?: number,
): number {
  if (configOverride) return configOverride;
  if (CONTEXT_WINDOWS[modelId]) return CONTEXT_WINDOWS[modelId];

  // Strip date suffix: "-20250514", "-2024-08-06", "-0528", "-2512"
  const stripped = modelId.replace(/-(\d{4}-\d{2}-\d{2}|\d{4,8})$/, "");
  if (stripped !== modelId && CONTEXT_WINDOWS[stripped]) {
    return CONTEXT_WINDOWS[stripped];
  }

  return DEFAULT_CONTEXT_WINDOW;
}
