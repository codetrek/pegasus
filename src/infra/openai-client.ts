/**
 * OpenAI LLM client using official OpenAI SDK.
 * Works with OpenAI, LiteLLM, and other OpenAI-compatible services.
 */
import OpenAI from "openai";
import type { LanguageModel } from "ai";

export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/**
 * Create an AI SDK compatible LanguageModel from OpenAI SDK client.
 */
export function createOpenAICompatibleModel(config: OpenAIClientConfig): LanguageModel {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  const model: LanguageModel = {
    specificationVersion: "v2",
    provider: "openai",
    modelId: config.model,

    async doGenerate(options: any) {
      try {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: options.prompt,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          top_p: options.topP,
          stream: false,
        });

        const choice = response.choices[0];
        if (!choice) {
          throw new Error("No response from model");
        }
        const message = choice.message;

        return {
          text: message.content || "",
          content: [{ type: "text", text: message.content || "" }],
          finishReason: choice.finish_reason as any,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
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
      const stream = await client.chat.completions.create({
        model: config.model,
        messages: options.prompt,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
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
