# Agent Core

> Source code: `src/agents/agent.ts`

## Overview

Agent is the execution engine — it processes events and drives the LLM tool-use loop. Each Agent instance manages one conversation: it receives messages, calls the LLM, collects tool calls, executes tools, and repeats until the LLM produces no more tool calls.

## Agent State Model

Agent uses a 3-state model (replacing the old 6-state TaskFSM):

```
IDLE ←→ BUSY ←→ WAITING
```

| State | Meaning |
|-------|---------|
| IDLE | Free, can accept new work |
| BUSY | In an LLM call or tool execution |
| WAITING | Dispatched background work (child agents), can accept new requests |

Transition rules:
- IDLE → BUSY: new work begins
- BUSY → IDLE: work completes with no pending items
- BUSY → WAITING: background work dispatched
- WAITING → BUSY: new work arrives while waiting
- WAITING → IDLE: all pending work completes

## Execution Loop

Agent uses a `processStep()` loop that drives the LLM naturally:

```
receive message → LLM call → tool calls?
  → yes: execute tools, feed results back, repeat
  → no: done (agent goes IDLE)
```

Each iteration:
1. Call LLM with current message history
2. If LLM returns tool calls → execute them concurrently
3. Append tool results to messages
4. Repeat from step 1

This replaces the old separate Thinker/Planner/Actor processor model with a single unified loop that mirrors how LLMs naturally work.

## Event System

Agent subscribes to events via the EventBus. All events use `agentId` (not taskId) for routing.

Key events consumed:
- `MESSAGE_RECEIVED` — external input
- `TASK_COMPLETED` / `TASK_FAILED` — child agent results
- `TASK_NOTIFY` — interim messages from child agents

Key events emitted:
- `TOOL_CALL_COMPLETED` / `TOOL_CALL_FAILED` — tool execution results
- `TASK_COMPLETED` — when agent finishes

See [Event System](./events.md) for the full event catalog.

## API

```typescript
// Run agent with initial messages, returns when complete
const result = await agent.run(messages)

// Send a message asynchronously (for MainAgent)
agent.send(message)

// Register reply callback
agent.onReply(callback)
```

## Concurrency

Multiple agents can run concurrently, each with their own message history and execution state. They share the EventBus for communication but don't block each other.

The `maxIterations` setting prevents runaway loops — when reached, the agent pauses and notifies the parent that it can be resumed with `resume_subagent`.

## Related

- [Agent State](../src/agents/base/agent-state.ts) — 3-state model implementation
- [Execution State](../src/agents/base/execution-state.ts) — per-agent execution tracking
- [Event System](./events.md) — EventType, EventBus
- [Cognitive Pipeline](./cognitive.md) — Reason → Act pattern
