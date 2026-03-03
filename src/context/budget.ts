/**
 * Token budget computation.
 *
 * Answers: "Given this model and config, how many tokens can I use
 * for messages before I should compact?"
 *
 * All LLM call sites share this single function.
 */
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MIN_OUTPUT_RESERVE_TOKENS,
  TOKEN_ESTIMATION_SAFETY_MARGIN,
  DEFAULT_COMPACT_THRESHOLD,
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from "./constants.ts";
import { getContextWindowSize, isModelKnown } from "./context-windows.ts";

/** Resolved token budget for a specific LLM call site. */
export interface TokenBudget {
  /** Total context window for this model. */
  contextWindow: number;
  /** Tokens reserved for model output. */
  outputReserve: number;
  /** Max tokens available for input (system + messages). */
  inputBudget: number;
  /** Input budget with safety margin applied. */
  effectiveInputBudget: number;
  /** Token count that triggers compact. */
  compactTrigger: number;
  /** Source of context window value. */
  source: "config" | "registry" | "default";
}

export interface BudgetOptions {
  /** Model ID (e.g. "gpt-4o", "claude-sonnet-4.6"). */
  modelId: string;
  /** Config-level context window override. */
  configContextWindow?: number;
  /** Config-level output reserve override. */
  outputReserveTokens?: number;
  /** Compact threshold (0.0 - 1.0). Defaults to 0.8. */
  compactThreshold?: number;
}

export function computeTokenBudget(options: BudgetOptions): TokenBudget {
  // 1. Resolve context window
  let source: TokenBudget["source"];
  let contextWindow: number;

  if (options.configContextWindow) {
    contextWindow = options.configContextWindow;
    source = "config";
  } else {
    contextWindow = getContextWindowSize(options.modelId);
    source = isModelKnown(options.modelId) ? "registry" : "default";
  }

  // 1b. Resolve output reserve (computed early so clamp can account for it)
  const outputReserve = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
  );

  // 1c. Enforce minimum context window to prevent degenerate budgets
  //     (e.g., contextWindow < outputReserve -> inputBudget=0 -> compactTrigger=0 -> infinite compact)
  //     Minimum must leave room for at least some input tokens beyond the output reserve.
  const effectiveMinContextWindow = Math.max(
    CONTEXT_WINDOW_HARD_MIN_TOKENS,
    outputReserve + CONTEXT_WINDOW_HARD_MIN_TOKENS,
  );
  if (contextWindow < effectiveMinContextWindow) {
    contextWindow = effectiveMinContextWindow;
  }

  // 2. Compute input budget
  const inputBudget = Math.max(0, contextWindow - outputReserve);

  // 4. Apply safety margin
  const effectiveInputBudget = Math.floor(
    inputBudget / TOKEN_ESTIMATION_SAFETY_MARGIN,
  );

  // 5. Compute compact trigger
  const threshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  const compactTrigger = Math.floor(effectiveInputBudget * threshold);

  return {
    contextWindow,
    outputReserve,
    inputBudget,
    effectiveInputBudget,
    compactTrigger,
    source,
  };
}

/** Estimate token count from character count. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
