# TUI Improvement Design

> Comprehensive TUI improvement: real-time data, responsive layout, keyboard navigation.

## Context

The TUI dashboard (`src/tui/`) uses `@opentui/solid` (Solid.js-based TUI framework) with a three-column layout: Chat, Ops, and Metrics. Currently functional for chat messaging but Ops and Metrics panels display only mock data. No keyboard navigation beyond basic input.

## Goals

1. **AppStats data layer** — replace all mock data with real runtime statistics
2. **Responsive layout with Tab switching** — adapt to terminal width, Tab mode for narrow terminals
3. **Keyboard shortcuts** — panel switching, scrolling, search
4. **TUI Bridge integration** — connect AppStats to Solid reactive store via polling

## Approach: Layered Parallel Development

Three independent workstreams, two parallelizable:

```
Workstream ①: AppStats Data Layer ──────────┐
                                             ├──→ Workstream ③: Integration
Workstream ②: Layout & Interaction ─────────┘
```

- ① and ② have zero dependencies on each other
- ③ depends on both ① and ② completing

## Workstream ①: AppStats Data Layer

### Interface

Uses the design from `docs/app-stats.md`. Key sections:

- **Identity**: persona, status, startedAt
- **Model**: provider, modelId, contextWindow
- **LLM Usage**: lastCall (per-call) + byModel (cumulative) + compacts count
- **Budget**: used/total/compactThreshold
- **Subagents**: active/completed/failed
- **Tools**: total/builtin/mcp/calls/success/fail
- **Memory**: factCount/episodeCount
- **Channels**: type/name/connected array

### Data Write Points

| Field | Writer | Trigger |
|-------|--------|---------|
| `llm.*` + `budget.used` | `Agent.onLLMUsage` callback | Every LLM call return |
| `status` | Agent state manager | IDLE/BUSY transitions |
| `tasks.*` | EventBus handler | Subagent state changes |
| `tools.*` | EventBus handler | Tool execution results |
| `memory.*` | Periodic scan (30s) | Timer |
| `channels` | `PegasusApp.registerAdapter()` | Startup + adapter registration |
| `budget.total`, `tools.total/builtin/mcp` | `PegasusApp.start()` | Once at startup |

### Files

- New: `src/stats/app-stats.ts` — type definitions + `createAppStats()` factory
- New: `src/stats/index.ts` — exports
- Modify: `src/pegasus-app.ts` — create instance + inject callbacks

## Workstream ②: Layout & Interaction

### Responsive Layout

**Wide terminal (>=120 col):** Three-column layout (current design, unchanged)

```
┌────────────────────────────┬──────────────┬─────────────────┐
│                            │              │                 │
│   Chat (dynamic width)     │  Ops (30col) │ Metrics (28col) │
│                            │              │                 │
├────────────────────────────┴──────────────┴─────────────────┤
│  Input                                                      │
└─────────────────────────────────────────────────────────────┘
```

**Narrow terminal (<120 col):** Tab-based single panel

```
┌─────────────────────────────────────────────┐
│  [Chat]  [Ops]  [Metrics]   ← Tab bar      │
├─────────────────────────────────────────────┤
│                                             │
│   Currently selected panel (full width)     │
│                                             │
├─────────────────────────────────────────────┤
│  Input                                      │
└─────────────────────────────────────────────┘
```

### Switching Logic

- Auto-detect terminal width at startup and on `SIGWINCH`
- Threshold: >=120 col = three-column, <120 col = Tab mode
- Tab mode default panel: Chat

### Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+1` | Switch to Chat | Tab mode |
| `Ctrl+2` | Switch to Ops | Tab mode |
| `Ctrl+3` | Switch to Metrics | Tab mode |
| `Ctrl+Up` / `Ctrl+Down` | Scroll chat messages | Chat panel |
| `Ctrl+/` | Search messages | Chat panel |
| `Ctrl+C` x2 | Quit | Global (existing) |
| `Enter` | Send message | Input bar |
| `Shift+Enter` | Newline in input | Input bar |

### Files

- Modify: `src/tui/app.tsx` — responsive layout logic + Tab bar
- New: `src/tui/components/tab-bar.tsx` — Tab switching UI
- New: `src/tui/hooks/use-keyboard.ts` — keyboard shortcut manager
- New: `src/tui/hooks/use-terminal-size.ts` — terminal size listener

## Workstream ③: TUI Bridge & Data Integration

### Bridge Implementation

```typescript
// src/tui/bridge.ts
import { reconcile } from "solid-js/store"

export function startStatsBridge(appStats: AppStats, setStats: SetStoreFunction<AppStats>) {
  const timer = setInterval(() => {
    setStats(reconcile(structuredClone(appStats)))
  }, 500)
  return () => clearInterval(timer)
}
```

Key decisions:
- `structuredClone()` for snapshot isolation (no read-write races)
- `reconcile()` for structural diff (only changed Solid nodes re-render)
- Returns cleanup function for graceful shutdown

### Panel Data Wiring

**OpsPanel** — read from `stats.tasks`, `stats.memory`, `stats.tools`
**MetricsPanel** — read from `stats.model`, `stats.llm`, `stats.budget`, `stats.channels`
**TopBar** — compute uptime from `stats.startedAt`, read `stats.status`, sum LLM calls

### Files

- New: `src/tui/bridge.ts` — polling + reconcile
- Modify: `src/tui/store.ts` — extend store with stats field
- Modify: `src/tui/panels/ops-panel.tsx` — wire to live data
- Modify: `src/tui/panels/metrics-panel.tsx` — wire to live data
- Modify: `src/tui/components/top-bar.tsx` — wire to live data
- Modify: `src/tui/main.tsx` — start bridge on mount
- Keep: `src/tui/mock-data.tsx` — retained for `tui:dev` mode

## Testing Strategy

- Unit tests for `createAppStats()` factory and counter increments
- Unit tests for keyboard shortcut handler
- Unit tests for terminal size threshold logic
- Integration test for bridge: verify `reconcile()` only triggers on changes
- Manual verification of layout switching at 120-col boundary

## Future Iterations (Out of Scope)

- Markdown rendering in Chat panel
- Tool call real-time progress display
- Message search implementation (Ctrl+/ registered but search UI deferred)
