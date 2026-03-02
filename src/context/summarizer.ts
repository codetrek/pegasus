/**
 * Chunked message summarizer with serialization and merge overflow protection.
 *
 * Messages are serialized to plain text before sending to the summarize model.
 * Raw tool/assistant messages with toolCalls would cause API errors due to
 * strict pairing requirements, so we convert to `[role]: content` text format
 * and wrap as a single `{ role: "user", content: serialized }` message.
 *
 * For large conversation histories that exceed the model's context window,
 * messages are chunked, each chunk summarized independently, then partial
 * summaries merged. Recursive batching handles merge overflow with a depth
 * limit to guarantee termination.
 */

import type { LanguageModel, Message } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";
import { computeTokenBudget, estimateTokensFromChars } from "./budget.ts";
import { TOKEN_ESTIMATION_SAFETY_MARGIN } from "./constants.ts";

const logger = getLogger("context.summarizer");

/** Max chars per serialized message line (truncate beyond this). */
export const MAX_SERIALIZED_MESSAGE_CHARS = 2000;

/** Maximum recursive merge depth to guarantee termination. */
const MAX_MERGE_DEPTH = 3;

// ── Public types ──

export interface SummarizeOptions {
  /** Messages to summarize. */
  messages: Message[];
  /** Model to use for summarization. */
  model: LanguageModel;
  /** Override context window (tokens). If omitted, looked up from model registry. */
  configContextWindow?: number;
}

// ── Serialization ──

/**
 * Convert messages to plain text `[role]: content` lines.
 * Each message content is truncated to MAX_SERIALIZED_MESSAGE_CHARS.
 * Only content is serialized — toolCalls, toolCallId, images are omitted
 * to avoid strict pairing requirements when resending to a model.
 */
export function serializeMessagesForSummary(messages: Message[]): string {
  if (messages.length === 0) return "";

  const lines: string[] = [];
  for (const msg of messages) {
    let content = msg.content ?? "";
    if (content.length > MAX_SERIALIZED_MESSAGE_CHARS) {
      content = content.slice(0, MAX_SERIALIZED_MESSAGE_CHARS) + "...";
    }
    lines.push(`[${msg.role}]: ${content}`);
  }
  return lines.join("\n");
}

// ── Chunking ──

/**
 * Split messages into chunks that each fit within `maxChunkTokens`.
 * Uses a safety margin for token estimation.
 * An oversized single message is placed alone in its own chunk.
 */
export function chunkMessagesByTokenBudget(
  messages: Message[],
  maxChunkTokens: number,
): Message[][] {
  if (messages.length === 0) return [];

  const safeMax = Math.floor(maxChunkTokens / TOKEN_ESTIMATION_SAFETY_MARGIN);
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokensFromChars(msg.content.length);

    // Oversized single message — flush current, isolate this one
    if (msgTokens > safeMax) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentTokens = 0;
      }
      chunks.push([msg]);
      continue;
    }

    // Adding this message would exceed the budget
    if (currentTokens + msgTokens > safeMax && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ── Summarization ──

const SUMMARIZE_SYSTEM = [
  "You are a conversation summarizer.",
  "Produce a concise summary of the conversation below.",
  "Preserve key decisions, action items, tool results, and important context.",
  "Omit greetings, filler, and redundant exchanges.",
].join(" ");

/**
 * Summarize messages, auto-chunking if they exceed the model's context budget.
 *
 * Flow:
 * 1. Compute token budget for the summarize model.
 * 2. Serialize messages to plain text.
 * 3. If serialized text fits in budget → single-pass summarize.
 * 4. If not → chunk → summarize each chunk → merge partial summaries.
 */
export async function summarizeMessages(
  options: SummarizeOptions,
): Promise<string> {
  const { messages, model, configContextWindow } = options;

  if (messages.length === 0) return "";

  // Compute budget for the summarize model
  const budget = computeTokenBudget({
    modelId: model.modelId,
    configContextWindow,
  });

  // We use effectiveInputBudget minus some room for the system prompt
  const systemTokens = estimateTokensFromChars(SUMMARIZE_SYSTEM.length);
  const availableTokens = budget.effectiveInputBudget - systemTokens;

  // Estimate total message tokens
  const serialized = serializeMessagesForSummary(messages);
  const totalTokens = estimateTokensFromChars(serialized.length);

  if (totalTokens <= availableTokens) {
    // Single pass — everything fits
    return singlePassSummarize(messages, model);
  }

  // Need to chunk
  logger.debug(
    {
      totalTokens,
      availableTokens,
      messageCount: messages.length,
    },
    "summarize_chunking",
  );

  const chunks = chunkMessagesByTokenBudget(messages, availableTokens);

  // Summarize each chunk
  const partials: string[] = [];
  for (const chunk of chunks) {
    const summary = await singlePassSummarize(chunk, model);
    partials.push(summary);
  }

  // Merge partial summaries
  return mergeSummaries(partials, model, availableTokens);
}

/**
 * Single-pass summarization: serialize messages to plain text, send as
 * a single user message. This avoids strict tool/assistant pairing requirements.
 */
async function singlePassSummarize(
  messages: Message[],
  model: LanguageModel,
): Promise<string> {
  const serialized = serializeMessagesForSummary(messages);

  const result = await model.generate({
    system: SUMMARIZE_SYSTEM,
    messages: [{ role: "user", content: serialized }],
  });

  return result.text;
}

/**
 * Merge partial summaries into a single summary.
 *
 * If the combined partials exceed the model's budget AND there are > 2 partials
 * AND depth < MAX_MERGE_DEPTH, recursively batch the partials.
 * At depth >= MAX_MERGE_DEPTH, fall back to concatenation.
 */
async function mergeSummaries(
  partials: string[],
  model: LanguageModel,
  availableTokens: number,
  depth: number = 0,
): Promise<string> {
  if (partials.length === 0) return "";
  if (partials.length === 1) return partials[0]!;

  const combined = partials.join("\n\n---\n\n");
  const combinedTokens = estimateTokensFromChars(combined.length);

  // If it fits, do a single merge
  if (combinedTokens <= availableTokens) {
    const result = await model.generate({
      system:
        "You are a conversation summarizer. Merge the following partial summaries into one coherent summary. Preserve key decisions, action items, and important context.",
      messages: [{ role: "user", content: combined }],
    });
    return result.text;
  }

  // Depth limit reached — concatenate as fallback
  if (depth >= MAX_MERGE_DEPTH) {
    logger.warn(
      { depth, partialCount: partials.length },
      "merge_depth_limit_reached_concatenating",
    );
    return combined;
  }

  // Recursive batching: split partials into batches that fit, summarize each batch
  logger.debug(
    { depth, partialCount: partials.length, combinedTokens, availableTokens },
    "merge_overflow_recursive_batching",
  );

  const safeTokens = Math.floor(
    availableTokens / TOKEN_ESTIMATION_SAFETY_MARGIN,
  );
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const partial of partials) {
    const partialTokens = estimateTokensFromChars(partial.length);

    if (currentTokens + partialTokens > safeTokens && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(partial);
    currentTokens += partialTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // If we couldn't reduce the number of batches, just concatenate to avoid infinite loop
  if (batches.length >= partials.length) {
    logger.warn(
      { depth, batchCount: batches.length },
      "merge_cannot_reduce_batches_concatenating",
    );
    return combined;
  }

  // Summarize each batch
  const batchSummaries: string[] = [];
  for (const batch of batches) {
    const batchText = batch.join("\n\n---\n\n");
    const result = await model.generate({
      system:
        "You are a conversation summarizer. Merge the following partial summaries into one coherent summary. Preserve key decisions, action items, and important context.",
      messages: [{ role: "user", content: batchText }],
    });
    batchSummaries.push(result.text);
  }

  // Recursively merge the batch summaries
  return mergeSummaries(batchSummaries, model, availableTokens, depth + 1);
}
