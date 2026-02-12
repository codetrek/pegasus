/**
 * Anthropic LLM client using official Anthropic SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "./llm-types.ts";

export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/**
 * Create a LanguageModel from Anthropic SDK client.
 */
export function createAnthropicCompatibleModel(config: AnthropicClientConfig): LanguageModel {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  return {
    provider: "anthropic",
    modelId: config.model,

    async generate(options) {
      // Build messages array
      const messages: Anthropic.MessageParam[] = options.messages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }));

      const response = await client.messages.create({
        model: config.model,
        system: options.system,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens || 4096,
        top_p: options.topP,
      });

      // Extract text content
      const textContent = response.content
        .filter((c) => c.type === "text")
        .map((c) => (c as Anthropic.TextBlock).text)
        .join("");

      return {
        text: textContent,
        finishReason: response.stop_reason || "stop",
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
