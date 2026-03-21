/**
 * TUI Bridge — polls AppStats at a fixed interval and pushes snapshots
 * into the TUI reactive layer via a setter callback.
 *
 * AppStats is a plain mutable object (no Solid reactivity). The bridge
 * periodically clones it and feeds the snapshot into the Solid store,
 * keeping the TUI panels up to date without tight coupling.
 */
import type { AppStats } from "../stats/app-stats.ts"

const DEFAULT_POLL_INTERVAL_MS = 500

export function startStatsBridge(
  appStats: AppStats,
  setStats: (snapshot: AppStats) => void,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    setStats(structuredClone(appStats))
  }, pollIntervalMs)
  return () => clearInterval(timer)
}
