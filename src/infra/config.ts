/**
 * Configuration — Zod-validated settings loaded from env vars or config file.
 */
export * from "./config-schema.ts";
import type { Settings } from "./config-schema.ts";

/**
 * Load settings from environment variables.
 *
 * Env vars:
 *   LLM_PROVIDER - Active provider (openai, anthropic, openai-compatible)
 *   LLM_MODEL - Default model name
 *
 *   # OpenAI provider
 *   OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
 *
 *   # Anthropic provider
 *   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
 *
 *   # OpenAI-compatible (Ollama, LM Studio, etc.)
 *   LLM_BASE_URL - Base URL for compatible provider
 *
 *   # Legacy support
 *   LLM_API_KEY - Falls back to provider-specific key
 *
 *   # System settings
 *   LLM_MAX_CONCURRENT_CALLS, LLM_TIMEOUT
 *   MEMORY_DB_PATH, MEMORY_VECTOR_DB_PATH
 *   AGENT_MAX_ACTIVE_TASKS, AGENT_MAX_CONCURRENT_TOOLS, ...
 *   PEGASUS_LOG_LEVEL, PEGASUS_DATA_DIR
 */

// Singleton
let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (!_settings) {
    // Use dynamic import to avoid circular dependency
    const { loadSettings } = require("./config-loader.ts") as typeof import("./config-loader.ts");
    _settings = loadSettings();
  }
  return _settings;
}

/** Override settings (for testing) */
export function setSettings(s: Settings): void {
  _settings = s;
}

/** Reset settings singleton so next getSettings() reloads from env (for testing) */
export function resetSettings(): void {
  _settings = null;
}

/**
 * Get the active provider's configuration.
 * Returns the provider-specific config merged with defaults.
 */
export function getActiveProviderConfig(settings: Settings): {
  apiKey?: string;
  baseURL?: string;
  model: string;
} {
  const { provider, model: defaultModel, openai, anthropic, baseURL } = settings.llm;

  switch (provider) {
    case "openai":
      return {
        apiKey: openai.apiKey,
        baseURL: openai.baseURL,
        model: openai.model || defaultModel,
      };
    case "anthropic":
      return {
        apiKey: anthropic.apiKey,
        baseURL: anthropic.baseURL,
        model: anthropic.model || defaultModel,
      };
    case "openai-compatible":
      return {
        apiKey: openai.apiKey,
        baseURL: baseURL,
        model: openai.model || defaultModel,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
