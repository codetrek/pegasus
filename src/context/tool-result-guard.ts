/**
 * Tool result size guard — prevents oversized tool results from
 * blowing up the context window.
 *
 * Provides:
 *   - calculateMaxToolResultChars: context-aware char limit
 *   - truncateToolResult: truncate with newline boundary + notice
 *   - truncateOversizedToolResults: batch truncation for message arrays
 *   - hasOversizedToolResults: quick boolean check
 */
import type { Message } from "../infra/llm-types.ts";
import {
  MAX_TOOL_RESULT_CONTEXT_SHARE,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_TOOL_RESULT_KEEP_CHARS,
  CHARS_PER_TOKEN,
} from "./constants.ts";

/** Notice appended to truncated tool results. */
export const TRUNCATION_NOTICE =
  "\n\n[RESULT TRUNCATED — output too large for context window. Use more specific queries or smaller ranges.]";

/**
 * Calculate the maximum characters a single tool result may occupy,
 * scaled to the model's context window.
 *
 * Formula: floor(contextWindowTokens × share × charsPerToken), capped at HARD_MAX.
 */
export function calculateMaxToolResultChars(
  contextWindowTokens: number,
): number {
  const raw = Math.floor(
    contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE * CHARS_PER_TOKEN,
  );
  return Math.min(raw, HARD_MAX_TOOL_RESULT_CHARS);
}

/**
 * Truncate a tool result string if it exceeds maxChars.
 *
 * - Attempts to cut at a newline boundary to avoid partial lines.
 * - Always keeps at least MIN_TOOL_RESULT_KEEP_CHARS.
 * - Appends TRUNCATION_NOTICE to truncated results.
 */
export function truncateToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Ensure we keep at least the minimum
  const keepChars = Math.max(maxChars, MIN_TOOL_RESULT_KEEP_CHARS);

  // Try to find a newline boundary within the keep range
  let cutPoint = text.lastIndexOf("\n", keepChars);
  if (cutPoint <= 0) {
    // No newline found or at position 0 — just use keepChars
    cutPoint = keepChars;
  }

  return text.slice(0, cutPoint) + TRUNCATION_NOTICE;
}

/**
 * Return a new message array with oversized tool results truncated.
 * Does NOT mutate the input array or its messages.
 */
export function truncateOversizedToolResults(
  messages: Message[],
  contextWindowTokens: number,
): Message[] {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return messages.map((msg) => {
    if (msg.role === "tool" && msg.content.length > maxChars) {
      return { ...msg, content: truncateToolResult(msg.content, maxChars) };
    }
    return msg;
  });
}

/**
 * Quick boolean check: do any tool messages exceed the size limit?
 */
export function hasOversizedToolResults(
  messages: Message[],
  contextWindowTokens: number,
): boolean {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return messages.some(
    (msg) => msg.role === "tool" && msg.content.length > maxChars,
  );
}
