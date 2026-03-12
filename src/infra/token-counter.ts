/**
 * Token counting utilities for different LLM providers.
 *
 * - TiktokenCounter: local token counting via tiktoken (OpenAI models)
 * - EstimateCounter: rough character-based fallback
 *
 * These are used internally by pi-ai-adapter to implement
 * LanguageModel.countTokens(). Consumers should call model.countTokens()
 * rather than using these directly.
 */
import { encoding_for_model, get_encoding } from "tiktoken";
import { getLogger } from "./logger.ts";

const log = getLogger("token_counter");

// ── Interface ────────────────────────────────────

export interface TokenCounter {
  count(text: string): Promise<number>;
}

// ── TiktokenCounter ──────────────────────────────

export class TiktokenCounter implements TokenCounter {
  private encoder;

  constructor(model?: string) {
    try {
      this.encoder = encoding_for_model((model as any) ?? "gpt-4o");
      log.debug({ model }, "tiktoken encoder created for model");
    } catch {
      this.encoder = get_encoding("cl100k_base");
      log.debug({ model }, "tiktoken model not found, falling back to cl100k_base");
    }
  }

  async count(text: string): Promise<number> {
    return this.encoder.encode(text).length;
  }
}

// ── EstimateCounter ──────────────────────────────

export class EstimateCounter implements TokenCounter {
  async count(text: string): Promise<number> {
    return Math.ceil(text.length / 3.5);
  }
}
