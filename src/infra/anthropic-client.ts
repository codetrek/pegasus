/**
 * Anthropic LLM client using official Anthropic SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "ai";

export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/**
 * Create an AI SDK compatible LanguageModel from Anthropic SDK client.
 */
export function createAnthropicCompatibleModel(config: AnthropicClientConfig): LanguageModel {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  const model: LanguageModel = {
    specificationVersion: "v2",
    provider: "anthropic",
    modelId: config.model,

    async doGenerate(options: any) {
      try {
        const response = await client.messages.create({
          model: config.model,
          messages: options.prompt,
          temperature: options.temperature,
          max_tokens: options.maxTokens || 4096,
          top_p: options.topP,
          stream: false,
        });

        // Extract text content
        const textContent = response.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");

        return {
          text: textContent,
          content: response.content.map((c: any) => ({
            type: c.type,
            text: c.type === "text" ? c.text : undefined,
          })),
          finishReason: response.stop_reason as any,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
          },
          rawResponse: {
            headers: {},
          },
          warnings: [],
          logprobs: undefined,
          rawCall: {
            rawPrompt: {
              messages: options.prompt,
            },
            rawSettings: {},
          },
        };
      } catch (error) {
        throw error;
      }
    },

    async doStream(options: any) {
      const stream = await client.messages.create({
        model: config.model,
        messages: options.prompt,
        temperature: options.temperature,
        max_tokens: options.maxTokens || 4096,
        top_p: options.topP,
        stream: true,
      });

      return {
        stream: stream as any,
        rawResponse: {
          headers: {},
        },
        warnings: [],
      };
    },
  } as any;

  return model;
}
