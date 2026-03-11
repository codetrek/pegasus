# Cognitive Pipeline

> Source code: `src/agents/cognitive/`

## Overview

The cognitive pipeline defines how an Agent processes information: understand the input, reason about it, decide on actions, execute them, and optionally learn from the experience.

## Two-Stage Model: Reason → Act

```
Reason ──▶ Act
  ▲          │
  └── tool_call results: back to Reason
             │
             └── no more tool calls: → Done
```

**Reason**: The LLM receives the conversation history and decides what to do. It produces either a text response (done) or tool calls (continue to Act).

**Act**: Tools are executed and results fed back to the LLM. The loop continues until the LLM produces no more tool calls.

This is implemented as Agent's `processStep()` loop — a single unified execution cycle, not separate processor classes.

### Why Two Stages Instead of Five

The original design had five stages (Perceive → Think → Plan → Act → Reflect). This was merged to two because:

- **Perceive** wasted an LLM call on metadata extraction that was never used downstream
- **Plan** was purely mechanical format conversion (toolCalls → PlanSteps), not actual planning
- **Reflect** was moved out of the loop as an async post-task process

Result: one LLM call per iteration instead of two, with no loss of capability.

## Async Post-Task Reflection

After an agent completes its work, an optional **PostTaskReflector** runs asynchronously to learn from the experience.

```
Agent completes → shouldReflect()?
  → No: done
  → Yes: PostTaskReflector runs in background
           ├── Pre-loads existing facts and episode index
           ├── LLM decides what to remember using memory tools
           │   (memory_read / memory_write / memory_patch / memory_append)
           └── Emits REFLECTION_COMPLETE (observability)
```

Key properties:
- Runs **after** the result has been delivered — never delays the response
- Uses a **tool-use loop**: the LLM calls memory tools directly (max 5 rounds)
- Errors never affect the task result
- `shouldReflect()` filters out trivial tasks to avoid unnecessary LLM calls

## Memory Index Injection

On the first iteration, the memory index is fetched and injected as a user message. This keeps the system prompt stable for LLM prefix caching — subsequent iterations already have the index in conversation history.

## Related

- [Agent Core](./agent.md) — the execution engine that implements this pipeline
- [Memory System](../features/memory-system.md) — what reflection writes to
