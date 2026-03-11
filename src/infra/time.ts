/**
 * Time formatting utilities for passive time perception.
 *
 * Provides consistent timestamp formatting for embedding in LLM messages,
 * giving the model awareness of when events occurred and how long they took.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Format epoch milliseconds to "YYYY-MM-DD HH:MM:SS" (UTC).
 */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Format a bracketed timestamp for tool results, optionally with duration.
 *
 * Examples:
 *   [2026-02-28 14:30:05 | took 2.3s]
 *   [2026-02-28 14:30:05]
 */
export function formatToolTimestamp(
  epochMs: number,
  durationMs?: number,
): string {
  const ts = formatTimestamp(epochMs);
  if (durationMs != null) {
    const secs = (durationMs / 1000).toFixed(1);
    return `[${ts} | took ${secs}s]`;
  }
  return `[${ts}]`;
}

/**
 * Format milliseconds to human-readable duration.
 * Examples: 0 → "0ms", 42 → "42ms", 1234 → "1.2s", 65432 → "1m 5.4s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSecs = ms / 1000;
  if (totalSecs < 60) return `${totalSecs.toFixed(1)}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs - mins * 60;
  return `${mins}m ${secs.toFixed(1)}s`;
}
