# TUI Improvement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock data with real-time AppStats, add responsive layout with Tab switching, and connect everything via a polling bridge.

**Architecture:** Three parallel workstreams — (1) AppStats data layer as a mutable stats container with direct mutation by Agent/EventBus, (2) responsive layout with Tab-based panel switching for narrow terminals, (3) TUI Bridge polling AppStats at 500ms and feeding Solid's `reconcile()` for incremental UI updates. Workstreams 1 and 2 are independent; workstream 3 integrates both.

**Tech Stack:** TypeScript, Solid.js (`@opentui/solid`), bun:test

---

## Chunk 1: AppStats Data Layer

### Task 1: Create AppStats type and factory

**Files:**
- Create: `src/stats/app-stats.ts`
- Create: `src/stats/index.ts`
- Test: `tests/unit/stats/app-stats.test.ts`

- [ ] **Step 1: Write failing test for createAppStats**

```typescript
// tests/unit/stats/app-stats.test.ts
import { describe, it, expect } from "bun:test";
import { createAppStats } from "@pegasus/stats/app-stats.ts";
import type { AppStats } from "@pegasus/stats/app-stats.ts";

describe("AppStats", () => {
  it("creates stats with default values", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    expect(stats.persona).toBe("Atlas");
    expect(stats.status).toBe("idle");
    expect(stats.startedAt).toBeGreaterThan(0);
    expect(stats.model.provider).toBe("openai");
    expect(stats.model.modelId).toBe("gpt-4o");
    expect(stats.model.contextWindow).toBe(128000);
    expect(stats.llm.byModel).toEqual({});
    expect(stats.llm.compacts).toBe(0);
    expect(stats.budget.used).toBe(0);
    expect(stats.budget.total).toBe(128000);
    expect(stats.budget.compactThreshold).toBe(0.75);
    expect(stats.subagents.active).toBe(0);
    expect(stats.subagents.completed).toBe(0);
    expect(stats.subagents.failed).toBe(0);
    expect(stats.tools.total).toBe(0);
    expect(stats.tools.calls).toBe(0);
    expect(stats.memory.factCount).toBe(0);
    expect(stats.memory.episodeCount).toBe(0);
    expect(stats.channels).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats/app-stats.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AppStats type and factory**

```typescript
// src/stats/app-stats.ts
/**
 * AppStats — runtime statistics container for TUI & observability.
 *
 * A passive, mutable stats object. Writers (Agent, EventBus handlers)
 * mutate fields directly. Readers (TUI Bridge) snapshot periodically.
 * See docs/app-stats.md for design rationale.
 */

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
  // Identity & Status
  persona: string
  status: "idle" | "busy"
  startedAt: number

  // Model
  model: {
    provider: string
    modelId: string
    contextWindow: number
  }

  // LLM Usage
  llm: {
    lastCall: LLMCallSnapshot | null
    byModel: Record<string, ModelStats>
    compacts: number
  }

  // Context Budget
  budget: {
    used: number
    total: number
    compactThreshold: number
  }

  // Subagents
  subagents: {
    active: number
    completed: number
    failed: number
  }

  // Tools
  tools: {
    total: number
    builtin: number
    mcp: number
    calls: number
    success: number
    fail: number
  }

  // Memory (counts only)
  memory: {
    factCount: number
    episodeCount: number
  }

  // Channels
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
```

```typescript
// src/stats/index.ts
export { createAppStats } from "./app-stats.ts"
export type { AppStats, LLMCallSnapshot, ModelStats, CreateAppStatsOpts } from "./app-stats.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stats/app-stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stats/ tests/unit/stats/
git commit -m "feat(stats): add AppStats type and createAppStats factory"
```

### Task 2: Add AppStats mutation helpers and tests

**Files:**
- Modify: `src/stats/app-stats.ts`
- Modify: `tests/unit/stats/app-stats.test.ts`

- [ ] **Step 1: Write failing tests for mutation helpers**

Add to `tests/unit/stats/app-stats.test.ts`:

```typescript
import { recordLLMUsage, recordToolCall } from "@pegasus/stats/app-stats.ts";

describe("recordLLMUsage", () => {
  it("updates lastCall, byModel, and budget.used", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordLLMUsage(stats, {
      model: "gpt-4o",
      promptTokens: 1000,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      outputTokens: 100,
      latencyMs: 1500,
    });

    expect(stats.llm.lastCall).toEqual({
      model: "gpt-4o",
      promptTokens: 1000,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      outputTokens: 100,
      latencyMs: 1500,
    });
    expect(stats.llm.byModel["gpt-4o"]!.calls).toBe(1);
    expect(stats.llm.byModel["gpt-4o"]!.totalPromptTokens).toBe(1000);
    expect(stats.llm.byModel["gpt-4o"]!.totalOutputTokens).toBe(100);
    expect(stats.budget.used).toBe(1500); // promptTokens + cacheReadTokens
  });

  it("accumulates across multiple calls", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordLLMUsage(stats, { model: "gpt-4o", promptTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, latencyMs: 500 });
    recordLLMUsage(stats, { model: "gpt-4o", promptTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 80, latencyMs: 600 });
    expect(stats.llm.byModel["gpt-4o"]!.calls).toBe(2);
    expect(stats.llm.byModel["gpt-4o"]!.totalPromptTokens).toBe(300);
    expect(stats.llm.byModel["gpt-4o"]!.totalOutputTokens).toBe(130);
    expect(stats.budget.used).toBe(300); // latest promptTokens + cacheReadTokens
  });
});

describe("recordToolCall", () => {
  it("increments success counter", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordToolCall(stats, true);
    expect(stats.tools.calls).toBe(1);
    expect(stats.tools.success).toBe(1);
    expect(stats.tools.fail).toBe(0);
  });

  it("increments fail counter", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordToolCall(stats, false);
    expect(stats.tools.calls).toBe(1);
    expect(stats.tools.success).toBe(0);
    expect(stats.tools.fail).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/stats/app-stats.test.ts`
Expected: FAIL — recordLLMUsage and recordToolCall not found

- [ ] **Step 3: Implement mutation helpers**

Add to `src/stats/app-stats.ts`:

```typescript
/** Record one LLM call into stats. Called from Agent.onLLMUsage callback. */
export function recordLLMUsage(stats: AppStats, call: LLMCallSnapshot): void {
  stats.llm.lastCall = call;

  // Per-model accumulation
  let m = stats.llm.byModel[call.model];
  if (!m) {
    m = { calls: 0, totalPromptTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalLatencyMs: 0 };
    stats.llm.byModel[call.model] = m;
  }
  m.calls++;
  m.totalPromptTokens += call.promptTokens;
  m.totalOutputTokens += call.outputTokens;
  m.totalCacheReadTokens += call.cacheReadTokens;
  m.totalCacheWriteTokens += call.cacheWriteTokens;
  m.totalLatencyMs += call.latencyMs;

  // Budget: used = latest prompt tokens (actual context size)
  stats.budget.used = call.promptTokens + call.cacheReadTokens;
}

/** Record one tool execution result. Called from EventBus TOOL_CALL_* handler. */
export function recordToolCall(stats: AppStats, success: boolean): void {
  stats.tools.calls++;
  if (success) stats.tools.success++;
  else stats.tools.fail++;
}
```

Update `src/stats/index.ts` exports:

```typescript
export { createAppStats, recordLLMUsage, recordToolCall } from "./app-stats.ts"
export type { AppStats, LLMCallSnapshot, ModelStats, CreateAppStatsOpts } from "./app-stats.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/stats/app-stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stats/ tests/unit/stats/
git commit -m "feat(stats): add recordLLMUsage and recordToolCall helpers"
```

### Task 3: Wire AppStats into PegasusApp

**Files:**
- Modify: `src/pegasus.ts` — create AppStats instance, inject into MainAgent callbacks
- Modify: `src/agents/main-agent.ts` — add onLLMUsage override that calls AppStats
- Modify: `src/agents/agent.ts` — add public `setStatsCallback` for external hook

- [ ] **Step 1: Add `onLLMUsageCallback` hook to Agent**

In `src/agents/agent.ts`, add a callback field that PegasusApp can set:

```typescript
// After line 528 (onLLMUsage method), add:
private _llmUsageCallback: ((result: GenerateTextResult) => void) | null = null;

/** Set external callback for LLM usage tracking (e.g. AppStats). */
setLLMUsageCallback(cb: (result: GenerateTextResult) => void): void {
  this._llmUsageCallback = cb;
}
```

Modify the existing `onLLMUsage` method (or processStep at line 643) to also call the callback:

In processStep, after `await this.onLLMUsage(result)` (line 643), add:
```typescript
this._llmUsageCallback?.(result);
```

- [ ] **Step 2: Wire AppStats creation in PegasusApp**

In `src/pegasus.ts`, add after MainAgent creation (after line 390):

```typescript
import { createAppStats, recordLLMUsage, recordToolCall } from "./stats/index.ts";
import type { AppStats } from "./stats/index.ts";

// In the class, add field:
private _appStats: AppStats | null = null;

// Public getter:
get appStats(): AppStats | null { return this._appStats; }
```

In `start()`, after MainAgent creation and before `await this._mainAgent.start()`:

```typescript
// Create AppStats
this._appStats = createAppStats({
  persona: this.persona.name,
  provider: this.models.getDefault().provider ?? "unknown",
  modelId: this.models.getDefault().modelId,
  contextWindow: this.models.getDefault().contextWindow ?? 128000,
  compactThreshold: this.settings.context?.compactThreshold ?? 0.75,
});

// Wire tool counts
this._appStats.tools.builtin = toolRegistry.count();
this._appStats.tools.mcp = wrappedMcpTools.length;
this._appStats.tools.total = this._appStats.tools.builtin + this._appStats.tools.mcp;

// Wire LLM usage callback
const appStats = this._appStats;
this._mainAgent.setLLMUsageCallback((result) => {
  const modelId = this.models.getDefault().modelId;
  recordLLMUsage(appStats, {
    model: modelId,
    promptTokens: result.usage.promptTokens ?? 0,
    cacheReadTokens: result.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    latencyMs: 0, // Not tracked in current GenerateTextResult
  });
});

// Wire tool call events
this._mainAgent.eventBus.subscribe(EventType.TOOL_CALL_COMPLETED, () => {
  recordToolCall(appStats, true);
});
this._mainAgent.eventBus.subscribe(EventType.TOOL_CALL_FAILED, () => {
  recordToolCall(appStats, false);
});

// Wire channel info
for (const adapter of this._adapters) {
  appStats.channels.push({ type: adapter.type, name: adapter.type, connected: true });
}
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All 2221+ tests pass (no regressions)

- [ ] **Step 4: Commit**

```bash
git add src/agents/agent.ts src/pegasus.ts src/stats/
git commit -m "feat(stats): wire AppStats into PegasusApp with LLM and tool tracking"
```

---

## Chunk 2: Responsive Layout & Keyboard Shortcuts

### Task 4: Add terminal size hook

**Files:**
- Create: `src/tui/hooks/use-terminal-size.ts`
- Test: `tests/unit/tui/use-terminal-size.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/tui/use-terminal-size.test.ts
import { describe, it, expect } from "bun:test";
import { computeLayoutMode } from "@pegasus/tui/hooks/use-terminal-size.ts";

describe("computeLayoutMode", () => {
  it("returns 'columns' for width >= 120", () => {
    expect(computeLayoutMode(120)).toBe("columns");
    expect(computeLayoutMode(200)).toBe("columns");
  });

  it("returns 'tabs' for width < 120", () => {
    expect(computeLayoutMode(119)).toBe("tabs");
    expect(computeLayoutMode(80)).toBe("tabs");
    expect(computeLayoutMode(40)).toBe("tabs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tui/use-terminal-size.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/tui/hooks/use-terminal-size.ts
/**
 * Terminal size utilities for responsive TUI layout.
 *
 * Layout modes:
 *   "columns" — wide terminal (>=120 col): three-column layout
 *   "tabs"    — narrow terminal (<120 col): tab-based single panel
 */

export type LayoutMode = "columns" | "tabs"

const COLUMNS_THRESHOLD = 120

/** Pure function: compute layout mode from terminal width. */
export function computeLayoutMode(width: number): LayoutMode {
  return width >= COLUMNS_THRESHOLD ? "columns" : "tabs"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/tui/use-terminal-size.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/ tests/unit/tui/use-terminal-size.test.ts
git commit -m "feat(tui): add computeLayoutMode for responsive layout switching"
```

### Task 5: Add Tab bar component

**Files:**
- Create: `src/tui/components/tab-bar.tsx`

- [ ] **Step 1: Implement TabBar component**

```typescript
// src/tui/components/tab-bar.tsx
/**
 * TabBar — horizontal tab switcher for narrow terminal mode.
 *
 * Shows [Chat] [Ops] [Metrics] with active tab highlighted.
 */
import { THEME } from "../theme.tsx"

export type TabId = "chat" | "ops" | "metrics"

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "ops", label: "Ops", icon: "🔄" },
  { id: "metrics", label: "Metrics", icon: "📊" },
]

export function TabBar(props: { active: TabId; onSelect: (id: TabId) => void }) {
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      paddingLeft={1}
      gap={1}
      backgroundColor={THEME.bgPanel}
      border={["bottom"]}
      borderColor={THEME.border}
    >
      {TABS.map((tab) => {
        const isActive = () => props.active === tab.id
        return (
          <text
            fg={isActive() ? THEME.accent : THEME.textMuted}
            bold={isActive()}
            onClick={() => props.onSelect(tab.id)}
          >
            {isActive() ? `[${tab.icon} ${tab.label}]` : ` ${tab.label} `}
          </text>
        )
      })}
      <text fg={THEME.textMuted} paddingLeft={1}>Ctrl+1/2/3</text>
    </box>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/components/tab-bar.tsx
git commit -m "feat(tui): add TabBar component for narrow terminal mode"
```

### Task 6: Refactor App for responsive layout

**Files:**
- Modify: `src/tui/app.tsx` — add layout mode switching, Tab bar, keyboard shortcuts

- [ ] **Step 1: Rewrite app.tsx with responsive layout**

Replace the body section in `src/tui/app.tsx` with responsive layout logic:

```typescript
// src/tui/app.tsx
/**
 * App — root component. Responsive layout:
 *   Wide (>=120 col): three-column layout
 *   Narrow (<120 col): tab-based single panel
 */
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { TopBar } from "./components/top-bar.tsx"
import { TabBar } from "./components/tab-bar.tsx"
import type { TabId } from "./components/tab-bar.tsx"
import { ChatPanel } from "./panels/chat-panel.tsx"
import { OpsPanel } from "./panels/ops-panel.tsx"
import { MetricsPanel } from "./panels/metrics-panel.tsx"
import { InputBar } from "./components/input-bar.tsx"
import { THEME } from "./theme.tsx"
import { requestShutdown, showHint } from "./store.ts"
import { copyToClipboard } from "./clipboard.ts"
import { computeLayoutMode } from "./hooks/use-terminal-size.ts"

/** Fixed column widths for three-column mode */
const OPS_WIDTH = 30
const METRICS_WIDTH = 28

export function App() {
  const dims = useTerminalDimensions()
  const layoutMode = createMemo(() => computeLayoutMode(dims().width))
  const chatWidth = createMemo(() => Math.max(30, dims().width - OPS_WIDTH - METRICS_WIDTH - 4))
  const renderer = useRenderer()
  const [activeTab, setActiveTab] = createSignal<TabId>("chat")

  // Allow process.stdout.write to bypass opentui's rendering pipeline.
  renderer.disableStdoutInterception()

  // Double Ctrl+C to exit
  let ctrlcCount = 0
  let ctrlcTimer: ReturnType<typeof setTimeout> | null = null

  useKeyboard((e: { name: string; ctrl: boolean }) => {
    if (e.ctrl && e.name === "c") {
      ctrlcCount++
      if (ctrlcCount >= 2) {
        renderer.destroy()
        requestShutdown()
        return
      }
      showHint("Press Ctrl+C again to exit")
      if (ctrlcTimer) clearTimeout(ctrlcTimer)
      ctrlcTimer = setTimeout(() => { ctrlcCount = 0 }, 2000)
      return
    }

    // Tab switching shortcuts (only in tab mode)
    if (e.ctrl && layoutMode() === "tabs") {
      if (e.name === "1") { setActiveTab("chat"); return }
      if (e.name === "2") { setActiveTab("ops"); return }
      if (e.name === "3") { setActiveTab("metrics"); return }
    }
  })

  // Copy-on-select
  const copySelection = () => {
    const selection = renderer.getSelection()
    if (!selection) return
    const text = selection.getSelectedText()
    if (!text) return
    copyToClipboard(text)
    renderer.clearSelection()
    showHint("Copied", 1000)
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={THEME.bg}
      onMouseUp={copySelection}
    >
      {/* Top bar */}
      <TopBar />

      {/* Tab bar (only in tab mode) */}
      {layoutMode() === "tabs" && (
        <TabBar active={activeTab()} onSelect={setActiveTab} />
      )}

      {/* Body — responsive */}
      {layoutMode() === "columns" ? (
        /* Three-column mode */
        <box flexGrow={1} flexDirection="row">
          <box width={chatWidth()} flexDirection="column" border={["right"]} borderColor={THEME.border}>
            <ChatPanel />
          </box>
          <box width={OPS_WIDTH} flexDirection="column" border={["right"]} borderColor={THEME.border}>
            <OpsPanel />
          </box>
          <box width={METRICS_WIDTH} flexDirection="column">
            <MetricsPanel />
          </box>
        </box>
      ) : (
        /* Tab mode — single panel */
        <box flexGrow={1} flexDirection="column">
          {activeTab() === "chat" && <ChatPanel />}
          {activeTab() === "ops" && <OpsPanel />}
          {activeTab() === "metrics" && <MetricsPanel />}
        </box>
      )}

      {/* Bottom input */}
      <InputBar />
    </box>
  )
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Manual verification**

Run: `bun run tui:dev`
Verify: At >=120 col width, three-column layout shows. Resize below 120 col, Tab bar appears.

- [ ] **Step 4: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): responsive layout with Tab switching for narrow terminals"
```

---

## Chunk 3: TUI Bridge & Data Integration

### Task 7: Create TUI Bridge

**Files:**
- Create: `src/tui/bridge.ts`
- Test: `tests/unit/tui/bridge.test.ts`

- [ ] **Step 1: Write failing test for bridge**

```typescript
// tests/unit/tui/bridge.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { createAppStats } from "@pegasus/stats/app-stats.ts";
import { startStatsBridge } from "@pegasus/tui/bridge.ts";

describe("TUI Bridge", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) { cleanup(); cleanup = null; }
  });

  it("polls stats and delivers snapshots to setter", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];

    cleanup = startStatsBridge(stats, (snap) => { snapshots.push(snap); });

    // Wait for at least one poll cycle (500ms + buffer)
    await new Promise(r => setTimeout(r, 700));

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.persona).toBe("Atlas");
    expect(snapshots[0]!.status).toBe("idle");
  }, 2000);

  it("stops polling after cleanup", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];

    const stop = startStatsBridge(stats, (snap) => { snapshots.push(snap); });

    await new Promise(r => setTimeout(r, 700));
    stop();
    const countAfterStop = snapshots.length;

    await new Promise(r => setTimeout(r, 700));
    expect(snapshots.length).toBe(countAfterStop);
  }, 3000);

  it("delivers updated values when stats mutate", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];

    cleanup = startStatsBridge(stats, (snap) => { snapshots.push(snap); });

    // Mutate stats before next poll
    stats.status = "busy";

    await new Promise(r => setTimeout(r, 700));
    cleanup(); cleanup = null;

    const lastSnap = snapshots[snapshots.length - 1];
    expect(lastSnap!.status).toBe("busy");
  }, 2000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tui/bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bridge**

```typescript
// src/tui/bridge.ts
/**
 * TUI Bridge — connects AppStats (mutable backend object) to TUI store.
 *
 * Polls AppStats every 500ms. Uses structuredClone for snapshot isolation.
 * The caller decides how to feed the snapshot into their reactive system.
 * See docs/app-stats.md for design rationale.
 */
import type { AppStats } from "../stats/app-stats.ts"

const POLL_INTERVAL_MS = 500

/** Start polling AppStats and delivering snapshots via setter. Returns cleanup function. */
export function startStatsBridge(
  appStats: AppStats,
  setStats: (snapshot: AppStats) => void,
): () => void {
  const timer = setInterval(() => {
    setStats(structuredClone(appStats))
  }, POLL_INTERVAL_MS)
  return () => clearInterval(timer)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/tui/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/bridge.ts tests/unit/tui/bridge.test.ts
git commit -m "feat(tui): add TUI Bridge for AppStats polling with reconcile"
```

### Task 8: Add stats store to TUI store

**Files:**
- Modify: `src/tui/store.ts` — add stats Solid store + setter
- Modify: `tests/unit/tui/store.test.ts` — test stats store

- [ ] **Step 1: Write failing test**

Add to `tests/unit/tui/store.test.ts`:

```typescript
import { statsStore, setStats, resetStatsStore } from "@pegasus/tui/store.ts";
import { createAppStats } from "@pegasus/stats/app-stats.ts";

describe("Stats Store", () => {
  beforeEach(() => {
    resetStatsStore();
  });

  it("has default null stats", () => {
    expect(statsStore.stats).toBeNull();
  });

  it("can set stats via setStats", () => {
    const stats = createAppStats({ persona: "Test", modelId: "m", provider: "p", contextWindow: 100 });
    setStats(stats);
    expect(statsStore.stats).not.toBeNull();
    expect(statsStore.stats!.persona).toBe("Test");
  });

  it("can reset stats", () => {
    const stats = createAppStats({ persona: "Test", modelId: "m", provider: "p", contextWindow: 100 });
    setStats(stats);
    resetStatsStore();
    expect(statsStore.stats).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tui/store.test.ts`
Expected: FAIL — statsStore not found

- [ ] **Step 3: Implement stats store**

Add to `src/tui/store.ts`:

```typescript
import { reconcile } from "solid-js/store"
import type { AppStats } from "../stats/app-stats.ts"

// ── Stats store (AppStats snapshot for TUI panels) ──

interface StatsStoreShape {
  stats: AppStats | null
}

const [_statsStore, _setStatsStore] = createStore<StatsStoreShape>({ stats: null })

/** Read-only stats store for TUI panels. */
export const statsStore = _statsStore

/** Set stats snapshot. Uses Solid reconcile() for fine-grained reactivity. */
export function setStats(snapshot: AppStats | null): void {
  if (snapshot === null) {
    _setStatsStore("stats", null)
  } else {
    _setStatsStore("stats", reconcile(snapshot))
  }
}

/** Reset stats store (used by tests). */
export function resetStatsStore(): void {
  _setStatsStore("stats", null)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/tui/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/store.ts tests/unit/tui/store.test.ts
git commit -m "feat(tui): add stats store for AppStats reactive data"
```

### Task 9: Wire panels to live data

**Files:**
- Modify: `src/tui/panels/ops-panel.tsx` — read from `statsStore` instead of `mockData`
- Modify: `src/tui/panels/metrics-panel.tsx` — read from `statsStore`
- Modify: `src/tui/components/top-bar.tsx` — read from `statsStore`

- [ ] **Step 1: Rewrite OpsPanel to use statsStore**

Replace `mockData()` references with `statsStore.stats`:

```typescript
// src/tui/panels/ops-panel.tsx
import { Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"

function SubagentsSection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <SectionHeader icon="🔄" title="Subagents" info={s() ? `${s()!.subagents.active} active` : "—"} />
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        <box flexDirection="column" paddingTop={1}>
          <text fg={THEME.text}>active:    {s()!.subagents.active}</text>
          <text fg={THEME.success}>completed: {s()!.subagents.completed}</text>
          <text fg={THEME.error}>failed:    {s()!.subagents.failed}</text>
        </box>
      </Show>
    </box>
  )
}

function MemorySection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="🧠" title="Memory" />
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        <box flexDirection="column" paddingTop={1}>
          <text fg={THEME.text}>facts:    {s()!.memory.factCount}</text>
          <text fg={THEME.text}>episodes: {s()!.memory.episodeCount}</text>
        </box>
      </Show>
    </box>
  )
}

function ToolsSection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="⚙" title="Tools" info={s() ? `${s()!.tools.total}` : "—"} />
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        <box flexDirection="column" paddingTop={1}>
          <text fg={THEME.text}>builtin: {s()!.tools.builtin}  mcp: {s()!.tools.mcp}</text>
          <text fg={THEME.text}>
            calls: {s()!.tools.calls} (<span style={{ fg: THEME.success }}>✓{s()!.tools.success}</span> <span style={{ fg: THEME.error }}>✗{s()!.tools.fail}</span>)
          </text>
        </box>
      </Show>
    </box>
  )
}

export function OpsPanel() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <SubagentsSection />
      <MemorySection />
      <ToolsSection />
    </box>
  )
}
```

- [ ] **Step 2: Rewrite MetricsPanel to use statsStore**

```typescript
// src/tui/panels/metrics-panel.tsx
import { Show, For } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"

function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return String(n)
}

function ModelSection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <SectionHeader icon="📊" title="Model & Tokens" />
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        <box flexDirection="column" paddingTop={1}>
          <text fg={THEME.text}>
            <b>{s()!.model.provider}/{s()!.model.modelId}</b>
          </text>
          <text fg={THEME.textMuted}>context: {fmtTok(s()!.model.contextWindow)}</text>

          <Show when={s()!.llm.lastCall}>
            <text fg={THEME.text} paddingTop={1}><b>Last LLM call:</b></text>
            <text fg={THEME.text}> prompt   {s()!.llm.lastCall!.promptTokens.toLocaleString()} tok</text>
            <text fg={THEME.text}> cache rd {s()!.llm.lastCall!.cacheReadTokens.toLocaleString()} tok</text>
            <text fg={THEME.text}> cache wr {s()!.llm.lastCall!.cacheWriteTokens.toLocaleString()} tok</text>
            <text fg={THEME.text}> output   {s()!.llm.lastCall!.outputTokens.toLocaleString()} tok</text>
            <text fg={THEME.text}> latency  {s()!.llm.lastCall!.latencyMs.toLocaleString()} ms</text>
          </Show>

          {/* Session totals — sum across all models */}
          {(() => {
            const byModel = s()!.llm.byModel;
            const models = Object.values(byModel);
            const totalCalls = models.reduce((sum, m) => sum + m.calls, 0);
            const totalPrompt = models.reduce((sum, m) => sum + m.totalPromptTokens, 0);
            const totalOutput = models.reduce((sum, m) => sum + m.totalOutputTokens, 0);
            return (
              <>
                <text fg={THEME.text} paddingTop={1}><b>Session totals:</b></text>
                <text fg={THEME.text}> prompt  {fmtTok(totalPrompt)} tok</text>
                <text fg={THEME.text}> output  {fmtTok(totalOutput)} tok</text>
                <text fg={THEME.text}> LLM calls: {totalCalls}</text>
                <text fg={THEME.textMuted}> compacts: {s()!.llm.compacts}</text>
              </>
            );
          })()}
        </box>
      </Show>
    </box>
  )
}

function BudgetSection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
      <text fg={THEME.text}><b>Budget:</b></text>
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        {(() => {
          const pct = Math.round((s()!.budget.used / s()!.budget.total) * 100);
          const barLen = 16;
          const filled = Math.round((pct / 100) * barLen);
          const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
          const thresholdPos = Math.round(s()!.budget.compactThreshold * barLen);
          const barWithMarker = bar.slice(0, thresholdPos) + "┃" + bar.slice(thresholdPos + 1);
          return (
            <>
              <text fg={THEME.text}> {fmtTok(s()!.budget.used)} / {fmtTok(s()!.budget.total)} ({pct}%)</text>
              <text fg={pct > s()!.budget.compactThreshold * 100 ? THEME.warning : THEME.accent}>
                {" "}{barWithMarker}
              </text>
              <text fg={THEME.textMuted}> compact at {Math.round(s()!.budget.compactThreshold * 100)}%</text>
            </>
          );
        })()}
      </Show>
    </box>
  )
}

function ChannelsSection() {
  const s = () => statsStore.stats

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="🔌" title="Channels" />
      <Show when={s()} fallback={<text fg={THEME.textMuted}>No data</text>}>
        <box flexDirection="column" paddingTop={1}>
          <For each={s()!.channels}>
            {(ch) => {
              const dot = ch.connected ? "◉" : "◎"
              const dotColor = ch.connected ? THEME.success : THEME.error
              return (
                <text fg={THEME.text}>
                  <span style={{ fg: dotColor }}>{dot}</span>
                  {" "}{ch.type}
                  {" "}<span style={{ fg: THEME.textMuted }}>{ch.name}</span>
                </text>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}

export function MetricsPanel() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <ModelSection />
      <BudgetSection />
      <ChannelsSection />
    </box>
  )
}
```

- [ ] **Step 3: Rewrite TopBar to use statsStore**

```typescript
// src/tui/components/top-bar.tsx
import { Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"

function formatUptime(startedAt: number): string {
  const ms = Date.now() - startedAt
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const hrs = Math.floor(mins / 60)
  if (hrs > 0) return `${hrs}h ${mins % 60}m`
  if (mins > 0) return `${mins}m ${secs % 60}s`
  return `${secs}s`
}

export function TopBar() {
  const s = () => statsStore.stats

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={THEME.bgPanel}
      border={["bottom"]}
      borderColor={THEME.border}
    >
      <text fg={THEME.text}>
        <span style={{ fg: THEME.accent, bold: true }}>🦄 Pegasus</span>
        <Show when={s()}>
          <span style={{ fg: THEME.textMuted }}> · </span>
          <span style={{ bold: true }}>{s()!.persona}</span>
        </Show>
      </text>
      <Show when={s()}>
        {(() => {
          const byModel = s()!.llm.byModel;
          const totalCalls = Object.values(byModel).reduce((sum, m) => sum + m.calls, 0);
          const statusDot = s()!.status === "busy" ? "◉" : "◎";
          return (
            <text fg={THEME.textMuted}>
              uptime: {formatUptime(s()!.startedAt)} · LLM: {totalCalls} · compacts: {s()!.llm.compacts}
              {"  "}
              <span style={{ fg: s()!.status === "busy" ? THEME.success : THEME.textMuted }}>{statusDot}</span>
            </text>
          );
        })()}
      </Show>
    </box>
  )
}
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/tui/panels/ src/tui/components/top-bar.tsx
git commit -m "feat(tui): wire Ops, Metrics, TopBar panels to live statsStore"
```

### Task 10: Wire bridge in tui.ts entry point

**Files:**
- Modify: `src/tui.ts` — create bridge between PegasusApp.appStats and TUI store
- Modify: `src/tui/main.tsx` — accept appStats, start bridge on mount

- [ ] **Step 1: Update tui.ts to wire bridge**

In `src/tui.ts`, add imports and bridge wiring after `app.start()` and before `renderApp()`:

```typescript
import { setStats } from "./tui/store.ts";
import { startStatsBridge } from "./tui/bridge.ts";

// After loadMessages() and before renderApp():

// Start stats bridge — polls AppStats and feeds snapshots into Solid store
let stopBridge: (() => void) | null = null;
if (app.appStats) {
  setStats(structuredClone(app.appStats)); // Initial snapshot
  stopBridge = startStatsBridge(app.appStats, setStats);
}

// Update shutdown to clean up bridge
const shutdown = async () => {
  if (stopBridge) stopBridge();
  await app.stop();
  process.exit(0);
};
```

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Manual end-to-end test**

Run: `bun run tui`
Verify:
- TopBar shows persona name, uptime counting up, LLM call count
- Ops panel shows real subagent/memory/tool counts
- Metrics panel shows real model info, token usage updates after each LLM call
- Budget bar reflects actual context usage

- [ ] **Step 4: Commit**

```bash
git add src/tui.ts src/tui/store.ts
git commit -m "feat(tui): wire AppStats bridge into TUI entry point"
```

### Task 11: Final cleanup and coverage

**Files:**
- Various test files for coverage

- [ ] **Step 1: Run coverage**

Run: `make coverage`
Check: All new files have adequate coverage

- [ ] **Step 2: Clean up mock-data usage**

Verify `mock-data.tsx` is still importable for `tui:dev` mode but not used in production panels.
If any panel still imports `mockData`, remove the import.

- [ ] **Step 3: Run full test suite one final time**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore(tui): cleanup mock-data imports, improve test coverage"
```
