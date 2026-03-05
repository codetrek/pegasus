/**
 * OpenRouter model limits fetcher.
 *
 * Calls GET https://openrouter.ai/api/v1/models to retrieve model metadata,
 * then normalizes each model's context_length and top_provider.max_completion_tokens
 * into our ModelLimits shape.
 *
 * Key behaviors:
 * - Model IDs are stripped of the provider prefix ("openai/gpt-4o" → "gpt-4o")
 * - maxInputTokens is computed: context_length - maxOutputTokens
 * - Models without context_length are skipped
 * - 10s timeout, 1 retry with 2s delay on 5xx, no retry on 401/403
 * - Never throws — returns empty Map on total failure
 */

import type { ModelLimits } from "../model-limits.ts";
import type { ProviderModelFetcher } from "./types.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../constants.ts";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 1;

/** Shape of a single model entry in the OpenRouter API response. */
interface OpenRouterModel {
  id: string;
  context_length?: number;
  top_provider?: {
    max_completion_tokens?: number | null;
  };
}

/** Shape of the OpenRouter /api/v1/models response. */
interface OpenRouterResponse {
  data: OpenRouterModel[];
}

/**
 * Strip the provider prefix from an OpenRouter model ID.
 * "openai/gpt-4o" → "gpt-4o"
 * "some-model" → "some-model" (no slash, kept as-is)
 */
function stripProviderPrefix(id: string): string {
  const slashIndex = id.indexOf("/");
  return slashIndex >= 0 ? id.slice(slashIndex + 1) : id;
}

export class OpenRouterModelFetcher implements ProviderModelFetcher {
  readonly provider = "openrouter";
  private readonly apiKey: string;
  private readonly retryDelayMs: number;

  constructor(apiKey: string, options?: { retryDelayMs?: number }) {
    this.apiKey = apiKey;
    this.retryDelayMs = options?.retryDelayMs ?? RETRY_DELAY_MS;
  }

  async fetch(): Promise<Map<string, ModelLimits>> {
    try {
      const response = await this.fetchWithRetry();
      if (!response) return new Map();

      const body = (await response.json()) as OpenRouterResponse;
      return this.normalize(body.data ?? []);
    } catch {
      return new Map();
    }
  }

  /** Attempt fetch with 1 retry on 5xx errors. */
  private async fetchWithRetry(): Promise<Response | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          await Bun.sleep(this.retryDelayMs);
        }

        const response = await fetch(OPENROUTER_API_URL, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (response.ok) return response;

        // No retry on auth errors
        if (response.status === 401 || response.status === 403) {
          return null;
        }

        // Retry on 5xx
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          continue;
        }

        return null;
      } catch {
        // Network / timeout error — treat as terminal
        return null;
      }
    }
    return null;
  }

  /** Normalize raw OpenRouter model data into a Map<modelId, ModelLimits>. */
  private normalize(models: OpenRouterModel[]): Map<string, ModelLimits> {
    const result = new Map<string, ModelLimits>();

    for (const model of models) {
      // Skip models without context_length
      if (!model.context_length) continue;

      const contextWindow = model.context_length;
      const maxOutputTokens =
        model.top_provider?.max_completion_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const maxInputTokens = contextWindow - maxOutputTokens;

      const modelId = stripProviderPrefix(model.id);

      result.set(modelId, {
        maxInputTokens,
        maxOutputTokens,
        contextWindow,
      });
    }

    return result;
  }
}
