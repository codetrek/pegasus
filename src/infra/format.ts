/**
 * Human-readable formatting helpers for log output.
 */

/**
 * Format a number with thousands separators.
 * Examples: 0 → "0", 15234 → "15,234"
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a Map of tool call stats into a human-readable string.
 * Example: "read_file: 5 (5 ok) | bash: 3 (2 ok, 1 fail)"
 *
 * Tools with zero total calls are omitted.
 */
export function formatToolStats(
  stats: Map<string, { ok: number; fail: number }>,
): string {
  const parts: string[] = [];
  for (const [name, { ok, fail }] of stats) {
    const total = ok + fail;
    if (total === 0) continue;
    const detail = fail > 0 ? `${ok} ok, ${fail} fail` : `${ok} ok`;
    parts.push(`${name}: ${total} (${detail})`);
  }
  return parts.join(" | ");
}
