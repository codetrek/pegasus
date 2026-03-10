/**
 * StatsPersistence — save/load AppStats to ~/.pegasus/stats.json.
 *
 * Saves cumulative LLM stats (byModel totals) and tool call counts so they
 * survive restarts. Per-session fields (startedAt, lastCall, status) are NOT
 * persisted — they reset each session.
 *
 * File format: { version: 1, updatedAt: ISO, llm: { byModel, compacts }, tools: { calls, success, fail } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { getLogger } from "../infra/logger.ts"
import type { AppStats, ModelStats } from "./app-stats.ts"

const log = getLogger("stats-persistence")

interface PersistedStats {
  version: number
  updatedAt: string
  llm: {
    byModel: Record<string, ModelStats>
    compacts: number
  }
  tools: {
    calls: number
    success: number
    fail: number
  }
}

const PEGASUS_DIR = join(homedir(), ".pegasus")
const STATS_FILE = join(PEGASUS_DIR, "stats.json")

/** Load persisted stats into an existing AppStats object. Merges cumulative fields. */
export function loadPersistedStats(stats: AppStats): void {
  try {
    if (!existsSync(STATS_FILE)) return

    const raw = readFileSync(STATS_FILE, "utf-8")
    const data = JSON.parse(raw) as Partial<PersistedStats>

    if (!data.version || data.version !== 1) {
      log.warn({ version: data.version }, "Unknown stats file version, skipping")
      return
    }

    // Restore LLM byModel cumulative stats
    if (data.llm?.byModel && typeof data.llm.byModel === "object") {
      for (const [model, saved] of Object.entries(data.llm.byModel)) {
        if (
          saved &&
          typeof saved.calls === "number" &&
          typeof saved.totalPromptTokens === "number" &&
          typeof saved.totalOutputTokens === "number"
        ) {
          stats.llm.byModel[model] = {
            calls: saved.calls,
            totalPromptTokens: saved.totalPromptTokens,
            totalOutputTokens: saved.totalOutputTokens,
            totalCacheReadTokens: saved.totalCacheReadTokens ?? 0,
            totalCacheWriteTokens: saved.totalCacheWriteTokens ?? 0,
            totalLatencyMs: saved.totalLatencyMs ?? 0,
          }
        }
      }
    }

    if (typeof data.llm?.compacts === "number") {
      stats.llm.compacts = data.llm.compacts
    }

    // Restore tool call counts
    if (data.tools && typeof data.tools.calls === "number") {
      stats.tools.calls = data.tools.calls
      stats.tools.success = data.tools.success ?? 0
      stats.tools.fail = data.tools.fail ?? 0
    }

    log.debug("Loaded persisted stats from disk")
  } catch (err) {
    log.warn({ err }, "Failed to load persisted stats, starting fresh")
  }
}

/** Save current AppStats cumulative fields to disk. */
export function savePersistedStats(stats: AppStats): void {
  try {
    if (!existsSync(PEGASUS_DIR)) {
      mkdirSync(PEGASUS_DIR, { recursive: true })
    }

    const data: PersistedStats = {
      version: 1,
      updatedAt: new Date().toISOString(),
      llm: {
        byModel: stats.llm.byModel,
        compacts: stats.llm.compacts,
      },
      tools: {
        calls: stats.tools.calls,
        success: stats.tools.success,
        fail: stats.tools.fail,
      },
    }

    writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), "utf-8")
  } catch (err) {
    log.warn({ err }, "Failed to save persisted stats to disk")
  }
}

/** Get the stats file path (for testing). */
export function getStatsFilePath(): string {
  return STATS_FILE
}
