/**
 * LLM utilities - Helper functions for language model interactions.
 */
import type { GenerateTextOptions, GenerateTextResult } from "./llm-types.ts";

/**
 * Generate text using a language model.
 *
 * This is a simple wrapper that calls the model's generate method.
 */
export async function generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
  return options.model.generate({
    system: options.system,
    messages: options.messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
  });
}
