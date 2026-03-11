# Agent State Model

> Source code: `src/agents/base/agent-state.ts`, `src/agents/base/execution-state.ts`

## Overview

Each agent tracks its lifecycle with a 3-state model. This replaced the original 6-state TaskFSM (IDLE/REASONING/ACTING/SUSPENDED/COMPLETED/FAILED) with states that reflect the agent's actual availability.

## AgentState

3 states:

```
     ┌──────┐
     │ IDLE │ ← free, can accept work
     └──┬───┘
        │ new work
   ┌────▼───┐
   │  BUSY  │ ← in LLM call or tool execution
   └────┬───┘
        │ dispatched background work
  ┌─────▼────┐
  │ WAITING  │ ← background work pending, can accept new requests
  └──────────┘
```

| State | Meaning | Can accept work? |
|-------|---------|-----------------|
| IDLE | Free | Yes |
| BUSY | Active LLM/tool work | No |
| WAITING | Background work dispatched | Yes |

### Why 3 States Instead of 6

The old REASONING/ACTING cycle modeled the LLM's internal tool-use loop. But LLMs naturally do: generate → tool_calls → results → generate. We don't need to track which "cognitive stage" we're in — the LLM handles that internally. We only need to know: **can this agent accept new work?**

## Execution State

Each running agent has an `AgentExecutionState` that tracks:

- Message history for LLM calls
- Iteration count (number of LLM calls made)
- Maximum iterations before forced pause
- Active tool call collector
- Abort flag (for suspension)

## Transition Rules

| From | To | Trigger |
|------|----|---------|
| IDLE | BUSY | New work begins |
| BUSY | IDLE | Work completes, no pending items |
| BUSY | WAITING | Background work dispatched |
| WAITING | BUSY | New work arrives |
| WAITING | IDLE | All pending work completes |

Invalid: IDLE → WAITING (can't wait without doing something first)

## Related

- [Agent Core](./agent.md) — uses AgentState for lifecycle management
- [Event System](./events.md) — events that trigger state transitions
