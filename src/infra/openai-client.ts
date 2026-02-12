/**
 * OpenAI LLM client using official OpenAI SDK.
 * Works with OpenAI, LiteLLM, and other OpenAI-compatible services.
 */
import OpenAI from "openai";
import type { LanguageModel } from "./llm-types.ts";

export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/**
 * Create a LanguageModel from OpenAI SDK client.
 */
export function createOpenAICompatibleModel(config: OpenAIClientConfig): LanguageModel {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  return {
    provider: "openai",
    modelId: config.model,

    async generate(options) {
      // Build messages array with system prompt if provided
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (options.system) {
        messages.push({ role: "system", content: options.system });
      }

      // Add conversation messages
      for (const msg of options.messages) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }

      const response = await client.chat.completions.create({
        model: config.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        top_p: options.topP,
        stream: false,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No response from OpenAI model");
      }

      return {
        text: choice.message.content || "",
        finishReason: choice.finish_reason,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
        },
      };
    },
  };
}
