import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createAppStats, recordLLMUsage } from "@pegasus/stats/app-stats.ts"
import { loadPersistedStats, savePersistedStats, getStatsFilePath } from "@pegasus/stats/stats-persistence.ts"

// Use a temporary directory to avoid touching real ~/.pegasus/
// We test the actual functions but verify behavior through the real file path.
// Since tests run in isolation, we backup and restore.

describe("StatsPersistence", () => {
  const statsFile = getStatsFilePath()
  let backupContent: string | null = null

  beforeEach(() => {
    // Backup existing file if present
    if (existsSync(statsFile)) {
      const fs = require("node:fs")
      backupContent = fs.readFileSync(statsFile, "utf-8")
    }
  })

  afterEach(() => {
    // Restore backup or clean up
    if (backupContent !== null) {
      writeFileSync(statsFile, backupContent, "utf-8")
      backupContent = null
    } else if (existsSync(statsFile)) {
      unlinkSync(statsFile)
    }
  })

  it("saves and loads cumulative LLM stats", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    recordLLMUsage(stats, {
      model: "gpt-4o", promptTokens: 1000, cacheReadTokens: 500,
      cacheWriteTokens: 200, outputTokens: 100, latencyMs: 1500,
    })
    stats.tools.calls = 5
    stats.tools.success = 4
    stats.tools.fail = 1
    stats.llm.compacts = 2

    savePersistedStats(stats)
    expect(existsSync(statsFile)).toBe(true)

    // Load into fresh stats
    const fresh = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    loadPersistedStats(fresh)

    expect(fresh.llm.byModel["gpt-4o"]!.calls).toBe(1)
    expect(fresh.llm.byModel["gpt-4o"]!.totalPromptTokens).toBe(1000)
    expect(fresh.llm.byModel["gpt-4o"]!.totalOutputTokens).toBe(100)
    expect(fresh.llm.byModel["gpt-4o"]!.totalCacheReadTokens).toBe(500)
    expect(fresh.llm.byModel["gpt-4o"]!.totalCacheWriteTokens).toBe(200)
    expect(fresh.llm.compacts).toBe(2)
    expect(fresh.tools.calls).toBe(5)
    expect(fresh.tools.success).toBe(4)
    expect(fresh.tools.fail).toBe(1)
  })

  it("handles missing file gracefully", () => {
    if (existsSync(statsFile)) unlinkSync(statsFile)
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    // Should not throw
    loadPersistedStats(stats)
    expect(stats.llm.byModel).toEqual({})
    expect(stats.tools.calls).toBe(0)
  })

  it("handles corrupt file gracefully", () => {
    writeFileSync(statsFile, "not valid json", "utf-8")
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    // Should not throw
    loadPersistedStats(stats)
    expect(stats.llm.byModel).toEqual({})
  })

  it("does not persist session-specific fields", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    stats.status = "busy"
    recordLLMUsage(stats, {
      model: "gpt-4o", promptTokens: 500, cacheReadTokens: 0,
      cacheWriteTokens: 0, outputTokens: 50, latencyMs: 300,
    })

    savePersistedStats(stats)

    const fresh = createAppStats({ persona: "Fresh", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 })
    loadPersistedStats(fresh)

    // Session fields should NOT be overwritten
    expect(fresh.persona).toBe("Fresh") // not "Atlas"
    expect(fresh.status).toBe("idle") // not "busy"
    expect(fresh.llm.lastCall).toBeNull() // not persisted
    // But cumulative fields SHOULD be restored
    expect(fresh.llm.byModel["gpt-4o"]!.calls).toBe(1)
  })
})
