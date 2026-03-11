# AppStats — Runtime Statistics for TUI & Observability

> Source code: `src/stats/`

## Why

The TUI dashboard needs real-time system statistics (token usage, task counts, tool call
rates, etc.). These data points are scattered across Agent, EventBus, ToolRegistry, and
the file system. Without a central stats container, TUI would need to reach into every
subsystem — creating tight coupling and making future observability (Prometheus, web
dashboard) harder.

## Design Decisions

### AppStats, not AppState

Named `AppStats` because it is a **passive, read-only statistics container**. It does not
drive system behavior — it only reflects it. `State` implies it influences control flow;
`Stats` makes the intent clear: pure observation.

### No actual data — counts and snapshots only

AppStats stores **counters and latest-value snapshots**. It does NOT store:

- Message content (ChatPanel gets messages directly from `ChannelAdapter.deliver()`)
- Memory file contents (memory tools read the file system)
- Task details or logs

Why: storing actual data would create a second source of truth, leading to sync bugs and
unbounded memory growth.

### No averages — only summable quantities

Fields like `avgLatencyMs` are intentionally excluded. An average cannot be incrementally
updated without storing either the total sum or the full history. Latency tracking belongs
in a proper metrics backend (Prometheus + Grafana), not in an in-process stats struct.

### Polling over events

TUI reads AppStats via a **500ms polling interval**, not an event/callback system.

Why:

- **Zero coupling**: AppStats is a plain mutable object. It doesn't know who reads it,
  doesn't emit events, doesn't depend on any UI framework.
- **No batching complexity**: A single LLM call updates 4-5 fields (lastCall, byModel,
  budget). An event-based approach would need batching or emit multiple events — basically
  reinventing a reactive system.
- **Sufficient for TUI**: Terminal dashboards refresh at ~2 fps. 500ms polling is
  imperceptible to human eyes. Metrics that need sub-second precision belong in a
  time-series database, not a terminal UI.

Writers (Agent, EventBus handlers) mutate fields directly (`stats.llm.byModel[model].calls++`).
The TUI reader snapshots the object periodically and feeds it to Solid's `reconcile()` for
fine-grained incremental UI updates.

### LLM stats flow through Agent, not LLM module

The `LanguageModel` interface (`pi-ai-adapter.ts`) is stateless and pure — it takes input,
returns output. Injecting stats collection into it would break that simplicity.

Instead, `Agent.processStep()` already calls `onLLMUsage(result)` after every LLM call
and knows both the model identity (`this.model.modelId`) and the usage data
(`result.usage`). PegasusApp injects a callback that updates AppStats — no new EventType
needed, no changes to the LLM module.

## AppStats Interface

```typescript
interface AppStats {
  // ── Identity & Status ──
  persona: string
  status: "idle" | "busy"
  startedAt: number                      // Unix ms — display layer computes uptime

  // ── Model ──
  model: {
    provider: string
    modelId: string
    contextWindow: number
  }

  // ── LLM Usage ──
  llm: {
    lastCall: {
      model: string
      promptTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      outputTokens: number
      latencyMs: number
    } | null
    byModel: Record<string, {
      calls: number
      totalPromptTokens: number
      totalOutputTokens: number
      totalCacheReadTokens: number
      totalCacheWriteTokens: number
      totalLatencyMs: number
    }>
    compacts: number
  }

  // ── Context Budget ──
  budget: {
    used: number                         // last known prompt token count
    total: number                        // context window size
    compactThreshold: number             // 0-1, e.g. 0.75
  }

  // ── Subagents ──
  subagents: {
    active: number
    completed: number
    failed: number
  }

  // ── Tools ──
  tools: {
    total: number
    builtin: number
    mcp: number
    calls: number
    success: number
    fail: number
  }

  // ── Memory (counts only) ──
  memory: {
    factCount: number
    episodeCount: number
  }

  // ── Channels ──
  channels: Array<{
    type: string
    name: string
    connected: boolean
  }>
}
```

## Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                        PegasusApp                            │
│                                                              │
│  ┌─────────┐    direct mutation    ┌──────────┐              │
│  │  Agent   │ ──────────────────── │ AppStats │              │
│  │ onLLM() │  stats.llm.X++       │ (mutable │              │
│  └─────────┘                      │  struct) │              │
│                                    │          │              │
│  ┌─────────┐    direct mutation    │          │              │
│  │EventBus │ ──────────────────── │          │              │
│  │handlers │  stats.tasks.X++     │          │              │
│  └─────────┘  stats.tools.X++     └────┬─────┘              │
│                                        │                     │
└────────────────────────────────────────│─────────────────────┘
                                         │
                              500ms poll │  read-only
                                         ▼
                                  ┌─────────────┐
                                  │ TUI Bridge  │
                                  │ reconcile() │
                                  └──────┬──────┘
                                         │ fine-grained
                                         │ Solid reactivity
                                         ▼
                              ┌─────────────────────┐
                              │   TUI Panels        │
                              │  (only changed      │
                              │   cells re-render)  │
                              └─────────────────────┘
```

### Message Flow (separate path)

Chat messages do NOT flow through AppStats. The TUI acts as a `ChannelAdapter`:

```
User input  →  TuiAdapter.start()  →  agent.send(InboundMessage)
Agent reply  →  TuiAdapter.deliver(OutboundMessage)  →  ChatPanel directly
```

Two independent paths: **stats flow** (polling) and **message flow** (ChannelAdapter).

## Update Points

| Field | Writer | Trigger |
|-------|--------|---------|
| `status` | Agent state manager | State transitions (IDLE/BUSY/WAITING) |
| `llm.lastCall` | Agent.onLLMUsage callback | Every LLM call return |
| `llm.byModel[x].*` | Agent.onLLMUsage callback | Every LLM call return |
| `llm.compacts` | Agent._compactState | After successful compaction |
| `budget.used` | Agent.onLLMUsage callback | lastPromptTokens from result |
| `budget.total` | PegasusApp.start() | Once at startup (from model config) |
| `subagents.active/completed/failed` | EventBus TASK_* handlers | Task state changes |
| `tools.total/builtin/mcp` | PegasusApp.start() | Once at startup + MCP reload |
| `tools.calls/success/fail` | EventBus TOOL_CALL_* handlers | Tool execution results |
| `memory.factCount/episodeCount` | Periodic scan (30s) | Timer reads directory |
| `channels` | PegasusApp.registerAdapter() | Adapter registration |

## TUI Integration

The TUI bridge converts the plain AppStats object into Solid reactive state:

```typescript
const [stats, setStats] = createStore<AppStats>(initialSnapshot)

setInterval(() => {
  setStats(reconcile(appStats))   // Solid diffs, triggers only changed nodes
}, 500)
```

Solid's `reconcile()` performs structural diff — if only `llm.byModel["gpt-4"].calls`
changed from 47 to 48, only that single `<text>` node re-renders. All other panels
remain untouched.

## Future: Prometheus / Grafana

AppStats is designed as a stepping stone. When proper observability is added:

- Latency histograms, percentiles → Prometheus
- Time-series trends → Grafana
- AppStats remains for the TUI (lightweight, in-process, no external deps)

AppStats and Prometheus are complementary, not competing.
