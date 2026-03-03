/**
 * Context overflow error detection.
 *
 * Distinguishes genuine context-window overflow errors from rate-limit errors
 * and other transient failures. Used by the compaction retry loop to decide
 * whether emergency summarization should be attempted.
 */

/** Patterns that indicate context window / prompt size overflow. */
const OVERFLOW_PATTERNS = [
  /context.*(window|length).*(exceed|too\s+(large|long)|over|limit|max)/i,
  /prompt.*too\s+(large|long)/i,
  /request_too_large/i,
  /maximum\s+context\s+length/i,
  /token.*limit.*exceed/i,
  /input.*too\s+long/i,
  /上下文(过长|超出|超过)/,
  /输入.*超(出|过).*限/,
];

/** Patterns that indicate rate limiting (NOT context overflow). */
const RATE_LIMIT_PATTERNS = [
  /tokens?\s+per\s+minute/i,
  /rate[\s._-]?limit/i,
  /too\s+many\s+requests/i,
  /\bHTTP\s+429\b/i,
];

/**
 * Determine if an error is a context overflow error.
 *
 * Rate-limit errors are excluded first to avoid false positives
 * (e.g. "token per minute limit exceeded" matches both overflow
 * and rate-limit patterns, but is a rate-limit error).
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = extractMessage(error);
  if (!message) return false;

  // Exclude rate-limit errors first
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(message)) return false;
  }

  // Check overflow patterns
  for (const pattern of OVERFLOW_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  return false;
}

/** Extract a string message from various error shapes. */
function extractMessage(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    const msg = (error as { message: unknown }).message;
    return typeof msg === "string" ? msg : undefined;
  }
  return undefined;
}
