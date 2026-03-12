/**
 * LLM types - Internal abstractions for language model interactions.
 *
 * These types replace the Vercel AI SDK types to keep the codebase
 * independent and maintain direct control over LLM integrations.
 */

import type { ToolCall, ToolDefinition } from "../models/tool.ts";
import type { ImageAttachment } from "../media/types.ts";

/**
 * Message in a conversation with an LLM.
 */
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: ImageAttachment[]; // optional image attachments
  toolCallId?: string;
  toolCalls?: ToolCall[];
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
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  /** Agent that initiated this LLM call (for log correlation). */
  agentId?: string;
  /** Unique request ID to correlate start/done/error log lines. */
  requestId?: string;
}

/**
 * Result from text generation.
 */
export interface GenerateTextResult {
  text: string;
  finishReason: string;
  toolCalls?: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
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
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none";
    agentId?: string;
    requestId?: string;
  }): Promise<GenerateTextResult>;

  /**
   * Count tokens for the given text.
   *
   * Implementation varies by provider:
   * - Anthropic: calls the /v1/messages/count_tokens API
   * - OpenAI: uses tiktoken locally
   * - Others: character-based estimation
   *
   * Optional — callers should fall back to character estimation when absent.
   */
  countTokens?(text: string): Promise<number>;
}
