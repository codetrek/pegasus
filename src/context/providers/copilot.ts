import type { ModelLimits } from "../model-limits.ts";
import type { ProviderModelFetcher } from "./types.ts";

/** Timeout for each fetch attempt (ms). */
const FETCH_TIMEOUT_MS = 10_000;

/** Delay before the single retry attempt (ms). */
const RETRY_DELAY_MS = 2_000;

/** HTTP status codes that should NOT be retried. */
const NO_RETRY_STATUSES = new Set([401, 403]);

/**
 * Shape of a single model entry in the Copilot /models response.
 * We only read the fields we need — extra fields are ignored.
 */
interface CopilotModelEntry {
  id: string;
  capabilities?: {
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_context_window_tokens?: number;
    };
  };
}

/**
 * Fetches model limits from GitHub Copilot's `/models` endpoint.
 *
 * - Normalizes `max_prompt_tokens → maxInputTokens`, `max_output_tokens → maxOutputTokens`,
 *   `max_context_window_tokens → contextWindow`.
 * - Retries once with 2s delay on 5xx / network errors.
 * - Never retries on 401/403.
 * - Never throws — returns an empty Map on total failure.
 */
export class CopilotModelFetcher implements ProviderModelFetcher {
  readonly provider = "copilot";
  private readonly retryDelayMs: number;

  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly baseURL: string,
    options?: { retryDelayMs?: number },
  ) {
    this.retryDelayMs = options?.retryDelayMs ?? RETRY_DELAY_MS;
  }

  async fetch(): Promise<Map<string, ModelLimits>> {
    const maxAttempts = 2; // 1 initial + 1 retry

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.attempt();
        if (result !== null) return result;
      } catch {
        // Network error or unexpected failure — retryable
      }

      // If this was the last attempt, stop
      if (attempt + 1 >= maxAttempts) break;

      // Wait before retry
      await Bun.sleep(this.retryDelayMs);
    }

    return new Map();
  }

  /**
   * Single fetch attempt. Returns:
   * - Map on success (may be empty if data is empty)
   * - null on retryable failure (5xx, network error)
   * - empty Map on non-retryable failure (401, 403, bad JSON)
   *   The empty Map is returned directly so the caller knows NOT to retry.
   *
   * Throws on network errors so the caller can decide to retry.
   */
  private async attempt(): Promise<Map<string, ModelLimits> | null> {
    const token = await this.tokenProvider();

    const response = await globalThis.fetch(`${this.baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Non-retryable auth errors → return empty Map immediately
    if (NO_RETRY_STATUSES.has(response.status)) {
      return new Map();
    }

    // Server errors → retryable
    if (response.status >= 500) {
      return null;
    }

    // Non-200 that isn't 5xx or auth → treat as non-retryable
    if (!response.ok) {
      return new Map();
    }

    return this.parseResponse(response);
  }

  /**
   * Parse the response body and normalize models.
   * Returns empty Map on parse failure (non-retryable).
   */
  private async parseResponse(
    response: Response,
  ): Promise<Map<string, ModelLimits>> {
    const result = new Map<string, ModelLimits>();

    let body: { data?: CopilotModelEntry[] };
    try {
      body = (await response.json()) as { data?: CopilotModelEntry[] };
    } catch {
      // Malformed JSON
      return result;
    }

    if (!Array.isArray(body.data)) {
      return result;
    }

    for (const entry of body.data) {
      const limits = entry.capabilities?.limits;
      if (!limits) continue;

      const maxInputTokens = limits.max_prompt_tokens;
      const maxOutputTokens = limits.max_output_tokens;
      const contextWindow = limits.max_context_window_tokens;

      // Skip models missing any required field
      if (
        typeof maxInputTokens !== "number" ||
        typeof maxOutputTokens !== "number" ||
        typeof contextWindow !== "number"
      ) {
        continue;
      }

      result.set(entry.id, { maxInputTokens, maxOutputTokens, contextWindow });
    }

    return result;
  }
}
