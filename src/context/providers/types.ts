import type { ModelLimits } from "../model-limits.ts";

/** Adapter interface for fetching model limits from an LLM provider. */
export interface ProviderModelFetcher {
  /** Unique provider identifier (e.g. "copilot", "openrouter"). */
  readonly provider: string;

  /**
   * Fetch model limits from the provider's API.
   * Returns a Map of modelId → ModelLimits.
   * Never throws — returns an empty Map on failure.
   */
  fetch(): Promise<Map<string, ModelLimits>>;
}
