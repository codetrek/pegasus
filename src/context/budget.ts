/**
 * Token budget computation.
 *
 * Answers: "Given this model and config, how many tokens can I use
 * for messages before I should compact?"
 *
 * All LLM call sites share this single function.
 */
import {
  TOKEN_ESTIMATION_SAFETY_MARGIN,
  DEFAULT_COMPACT_THRESHOLD,
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from "./constants.ts";
import type { ModelLimitsCache } from "./model-limits-cache.ts";
import {
  getModelLimits,
  DEFAULT_MODEL_LIMITS,
  type ModelLimits,
} from "./model-limits.ts";

/** Resolved token budget for a specific LLM call site. */
export interface TokenBudget {
  /** Total context window for this model. */
  contextWindow: number;
  /** Max tokens the model can generate (from ModelLimits). */
  maxOutputTokens: number;
  /** Max tokens available for input — real provider limit. */
  maxInputTokens: number;
  /** Input budget with safety margin applied. */
  effectiveInputBudget: number;
  /** Token count that triggers compact. */
  compactTrigger: number;
  /** Source of model limits. */
  source: "config" | "cache" | "registry" | "default";
}

export interface BudgetOptions {
  /** Model ID (e.g. "gpt-4o", "claude-sonnet-4.6"). */
  modelId: string;
  /** Provider identifier for cache lookup (e.g. "copilot", "openrouter"). */
  provider?: string;
  /** Config-level context window override. */
  configContextWindow?: number;
  /** Compact threshold (0.0 - 1.0). Defaults to 0.8. */
  compactThreshold?: number;
  /** Cache for provider-fetched model limits. */
  modelLimitsCache?: ModelLimitsCache;
}

export function computeTokenBudget(options: BudgetOptions): TokenBudget {
  let source: TokenBudget["source"];
  let limits: ModelLimits;

  // 1. Config override (highest priority)
  if (options.configContextWindow) {
    limits = {
      maxInputTokens: options.configContextWindow,
      maxOutputTokens: DEFAULT_MODEL_LIMITS.maxOutputTokens,
      contextWindow: options.configContextWindow,
    };
    source = "config";
  } else if (options.modelLimitsCache) {
    // 2. Cache → registry → default (via ModelLimitsCache)
    const resolved = options.modelLimitsCache.resolve(
      options.modelId,
      options.provider,
    );
    limits = resolved.limits;
    source = resolved.source;
  } else {
    // 3. Static registry (backward compat when no cache provided)
    const staticLimits = getModelLimits(options.modelId);
    if (staticLimits) {
      limits = staticLimits;
      source = "registry";
    } else {
      limits = DEFAULT_MODEL_LIMITS;
      source = "default";
    }
  }

  // Enforce minimum context window
  let contextWindow = limits.contextWindow;
  const effectiveMinContextWindow = Math.max(
    CONTEXT_WINDOW_HARD_MIN_TOKENS,
    limits.maxOutputTokens + CONTEXT_WINDOW_HARD_MIN_TOKENS,
  );
  if (contextWindow < effectiveMinContextWindow) {
    contextWindow = effectiveMinContextWindow;
  }

  // maxInputTokens — clamp to at least CONTEXT_WINDOW_HARD_MIN_TOKENS
  const maxInputTokens = Math.max(
    CONTEXT_WINDOW_HARD_MIN_TOKENS,
    limits.maxInputTokens,
  );

  // Apply safety margin
  const effectiveInputBudget = Math.floor(
    maxInputTokens / TOKEN_ESTIMATION_SAFETY_MARGIN,
  );

  // Compute compact trigger
  const threshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  const compactTrigger = Math.floor(effectiveInputBudget * threshold);

  return {
    contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    maxInputTokens,
    effectiveInputBudget,
    compactTrigger,
    source,
  };
}

/** Estimate token count from character count. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
