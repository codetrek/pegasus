# AppStats: Agent-Owned Design

**Date**: 2026-03-12
**Status**: Implementing

## Problem

AppStats tracking is centralized in PegasusApp via callbacks and EventBus subscriptions:

1. `setLLMUsageCallback()` — manual callback wiring after MainAgent creation
2. `eventBus.subscribe(TOOL_CALL_COMPLETED/FAILED)` — only monitors MainAgent's bus
3. Subagent LLM usage and tool calls are logged but never bubble up to AppStats

This means subagent statistics are completely invisible to the TUI and persistence layer.

## Solution

Move AppStats ownership into Agent via dependency injection. Each Agent optionally
holds a reference to the shared AppStats object and records its own LLM usage,
tool calls, and subagent lifecycle directly — no callbacks or EventBus subscriptions.

### Data Flow (After)

```
PegasusApp.start()
  → createAppStats()
  → new MainAgent({ ..., appStats })        // injected via AgentDeps
    → Agent records LLM usage directly       // onLLMUsage()
    → Agent records tool calls directly      // _executeToolAsync()
    → Agent tracks subagent lifecycle        // _runSubagent()
    → Subagents inherit appStats reference   // spawn/resume
```

## Changes

### `src/agents/agent.ts`

| What | Action |
|------|--------|
| `AgentDeps.appStats?: AppStats` | ADD field |
| `Agent._appStats: AppStats \| null` | ADD protected field, set from deps |
| `Agent.onLLMUsage()` | UPDATE — call `recordLLMUsage()` if `_appStats` set |
| `Agent._executeToolAsync()` | UPDATE — call `recordToolCall()` if `_appStats` set |
| `Agent._runSubagent()` | UPDATE — track `subagents.active/completed/failed` |
| Spawn methods (`new Agent({...})`) | UPDATE — pass `appStats` to child agents |
| `Agent._llmUsageCallback` field | DELETE |
| `Agent.setLLMUsageCallback()` method | DELETE |
| `this._llmUsageCallback?.(result)` call | DELETE |

### `src/pegasus.ts`

| What | Action |
|------|--------|
| `createAppStats()` block | KEEP (moved before MainAgent creation) |
| `setLLMUsageCallback(...)` block (L462-473) | DELETE |
| `EventBus subscriptions` (L476-481) | DELETE |
| `MainAgent` creation | UPDATE — pass `appStats` via `InjectedSubsystems` |

### `src/agents/main-agent.ts`

| What | Action |
|------|--------|
| `InjectedSubsystems.appStats?: AppStats` | ADD field |
| `super()` call | UPDATE — pass `appStats` from injected |

## Deletions

- `Agent._llmUsageCallback` field and `setLLMUsageCallback()` method
- `PegasusApp` callback wiring block (L462-473)
- `PegasusApp` EventBus subscriptions for TOOL_CALL_COMPLETED/FAILED (L476-481)

## Out of Scope

- AppStats type changes (persistence layer unchanged)
- TUI display changes (still polls appStats every 500ms)
- EventBus protocol changes (no new event types)
- Merging child agent byModel stats into parent (subagents share the same AppStats object)
