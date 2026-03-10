export interface LLMCallSnapshot {
  model: string
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  latencyMs: number
}

export interface ModelStats {
  calls: number
  totalPromptTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalLatencyMs: number
}

export interface AppStats {
  persona: string
  status: "idle" | "busy"
  startedAt: number

  model: {
    provider: string
    modelId: string
    contextWindow: number
  }

  llm: {
    lastCall: LLMCallSnapshot | null
    byModel: Record<string, ModelStats>
    compacts: number
  }

  budget: {
    used: number
    total: number
    compactThreshold: number
  }

  subagents: {
    active: number
    completed: number
    failed: number
  }

  tools: {
    total: number
    builtin: number
    mcp: number
    calls: number
    success: number
    fail: number
  }

  memory: {
    factCount: number
    episodeCount: number
  }

  channels: Array<{
    type: string
    name: string
    connected: boolean
  }>
}

export interface CreateAppStatsOpts {
  persona: string
  provider: string
  modelId: string
  contextWindow: number
  compactThreshold?: number
}

export function createAppStats(opts: CreateAppStatsOpts): AppStats {
  return {
    persona: opts.persona,
    status: "idle",
    startedAt: Date.now(),

    model: {
      provider: opts.provider,
      modelId: opts.modelId,
      contextWindow: opts.contextWindow,
    },

    llm: {
      lastCall: null,
      byModel: {},
      compacts: 0,
    },

    budget: {
      used: 0,
      total: opts.contextWindow,
      compactThreshold: opts.compactThreshold ?? 0.75,
    },

    subagents: { active: 0, completed: 0, failed: 0 },
    tools: { total: 0, builtin: 0, mcp: 0, calls: 0, success: 0, fail: 0 },
    memory: { factCount: 0, episodeCount: 0 },
    channels: [],
  }
}
