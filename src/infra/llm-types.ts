/**
 * LLM types - Internal abstractions for language model interactions.
 *
 * These types replace the Vercel AI SDK types to keep the codebase
 * independent and maintain direct control over LLM integrations.
 */

/**
 * Message in a conversation with an LLM.
 */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Parameters for text generation.
 */
export interface GenerateTextOptions {
  model: LanguageModel;
  system?: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Result from text generation.
 */
export interface GenerateTextResult {
  text: string;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Language model interface that providers must implement.
 */
export interface LanguageModel {
  provider: string;
  modelId: string;

  /**
   * Generate text from a prompt.
   */
  generate(options: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  }): Promise<GenerateTextResult>;
}
