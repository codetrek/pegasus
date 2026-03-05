/**
 * CompactionManager — context window management for conversation agents.
 *
 * Extracted from MainAgent. Handles proactive context compaction:
 *   1. Check if messages exceed context window threshold
 *   2. If so, summarize and archive old messages
 *   3. Fallback chain: LLM summary → mechanical summary → hard truncate
 */

import type { Message } from "../infra/llm-types.ts";
import type { SessionStore } from "../session/store.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type { Settings } from "../infra/config.ts";
import type { TokenCounter } from "../infra/token-counter.ts";
import { EstimateCounter } from "../infra/token-counter.ts";
import {
  computeTokenBudget,
  summarizeMessages,
  type ModelLimitsCache,
} from "../context/index.ts";
import { errorToString } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("compaction_manager");

export interface CompactionManagerDeps {
  sessionStore: SessionStore;
  models: ModelRegistry;
  settings: Settings;
  modelLimitsCache?: ModelLimitsCache;
}

export class CompactionManager {
  private readonly sessionStore: SessionStore;
  private readonly models: ModelRegistry;
  private readonly settings: Settings;
  private readonly modelLimitsCache?: ModelLimitsCache;
  private readonly tokenCounter: TokenCounter;

  constructor(deps: CompactionManagerDeps) {
    this.sessionStore = deps.sessionStore;
    this.models = deps.models;
    this.settings = deps.settings;
    this.modelLimitsCache = deps.modelLimitsCache;
    this.tokenCounter = new EstimateCounter();
  }

  /**
   * Check if context needs compaction based on token estimate.
   * If so, compact and return true. Otherwise return false.
   */
  async checkAndCompact(
    messages: Message[],
    lastPromptTokens: number,
  ): Promise<boolean> {
    const budget = computeTokenBudget({
      modelId: this.models.getDefaultModelId(),
      provider: this.models.getDefaultProvider(),
      configContextWindow:
        this.models.getDefaultContextWindow() ??
        this.settings.llm.contextWindow,
      compactThreshold: this.settings.session?.compactThreshold,
      modelLimitsCache: this.modelLimitsCache,
    });

    // Estimate current token usage
    const keepLastNTurns = this.settings.vision?.keepLastNTurns ?? 5;
    let estimatedTokens: number;
    if (lastPromptTokens > 0) {
      // Use lastPromptTokens as base, but also estimate full session
      // to catch cases where many messages were added since last LLM call
      const fullEstimate = await this.sessionStore.estimateTokens(
        messages,
        this.tokenCounter,
        keepLastNTurns,
      );
      // Use the larger of: lastPromptTokens or full estimate
      estimatedTokens = Math.max(lastPromptTokens, fullEstimate);
    } else {
      // First call: no lastPromptTokens, estimate everything
      estimatedTokens = await this.sessionStore.estimateTokens(
        messages,
        this.tokenCounter,
        keepLastNTurns,
      );
    }

    if (estimatedTokens < budget.compactTrigger) return false;

    // Trigger compact
    logger.info(
      {
        estimatedTokens,
        compactTrigger: budget.compactTrigger,
        contextWindow: budget.contextWindow,
      },
      "compact_triggered",
    );

    // Generate summary via fallback chain
    const summary = await this.compactWithFallback(messages);

    // Archive current session and create new one with summary
    const archiveName = await this.sessionStore.compact(summary);

    logger.info({ archiveName }, "compact_completed");
    return true;
  }

  /**
   * 3-level compact fallback:
   *   1. Chunked LLM summarize
   *   2. Mechanical summary (no LLM)
   *   3. Hard truncate (last resort)
   *
   * Returns the summary text.
   */
  async compactWithFallback(messages: Message[]): Promise<string> {
    try {
      return await this._generateSummary(messages);
    } catch (err) {
      logger.warn(
        { error: errorToString(err) },
        "chunked_summary_failed_trying_mechanical",
      );
    }
    try {
      return this._mechanicalSummary(messages);
    } catch (err) {
      logger.warn(
        { error: errorToString(err) },
        "mechanical_summary_failed_hard_truncate",
      );
    }
    return "[Session history truncated due to context window limit. Previous context was lost.]";
  }

  /**
   * Generate a summary of messages via an independent LLM call.
   * Uses the "fast" tier model for cost efficiency.
   */
  private async _generateSummary(messages: Message[]): Promise<string> {
    return summarizeMessages({
      messages,
      model: this.models.getForTier("fast"),
      configContextWindow: this.models.getContextWindowForTier("fast"),
      modelLimitsCache: this.modelLimitsCache,
    });
  }

  /**
   * Mechanical (non-LLM) summary: extract key stats from messages.
   * Used as fallback when LLM summarization fails.
   */
  _mechanicalSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const toolMessages = messages.filter((m) => m.role === "tool");
    const recentUsers = userMessages.slice(-3).map(
      (m, i) =>
        `  ${i + 1}. ${
          typeof m.content === "string"
            ? m.content.slice(0, 200)
            : String(m.content).slice(0, 200)
        }`,
    );
    const toolNames = new Set<string>();
    for (const m of assistantMessages) {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) toolNames.add(tc.name);
      }
    }
    return [
      `[Session compacted — ${messages.length} messages archived]`,
      "",
      "Recent user messages:",
      ...recentUsers,
      "",
      `Tools used: ${[...toolNames].join(", ") || "(none)"}`,
      `Total exchanges: ${userMessages.length} user, ${assistantMessages.length} assistant, ${toolMessages.length} tool`,
    ].join("\n");
  }
}
