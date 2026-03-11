# Pegasus — System Architecture

## Positioning

Pegasus is not a request-response service. It is a **continuously running autonomous worker**. Think of a real employee at their desk — juggling multiple concerns in their head, working on one thing at a time, ready to hear new instructions or receive new messages at any moment, and deciding on their own how to prioritize.

## Core Design Principles

| Principle | Meaning |
|-----------|---------|
| **Everything is an Event** | User messages, tool returns, scheduled triggers, state changes — all are Events, dispatched through the EventBus |
| **Task = State Machine** | Each agent has a 3-state lifecycle (IDLE/BUSY/WAITING) with explicit transition rules |
| **Agent is an Event Processor** | No `while True` loop, no `await task.run()` blocking. Only: receive event → drive state machine → produce new events |
| **Non-blocking, Fully Async, Concurrent** | Agent event handlers never block; multiple tasks interleave, sharing compute |
| **Stateless Cognitive Processors** | Cognitive stage processors (PostTaskReflector) hold no state and can be reused by any task |
| **Identity Consistency** | Regardless of concurrent task count or session boundaries, personality and behavioral style remain consistent |
| **Persistent Memory** | Experience is never lost; the system learns and improves from history |
| **Model Agnostic** | Core logic is not bound to a specific LLM; supports dynamic switching and routing |

## Three Core Layers

```
┌──────────────────────────────────────────────────────────────┐
│  The system has three core layers:                           │
│                                                              │
│  1. Main Agent — Conversation brain (decides what to do)     │
│  2. Event + AgentState — Execution engine (how to do it)        │
│  3. Channel Adapters — I/O adaptation (where it comes from   │
│     and where it goes back)                                  │
│                                                              │
│  Main Agent receives messages and decides whether to reply   │
│  directly, spawn a Task, or launch a SubAgent.               │
│  Tasks and SubAgents execute asynchronously via EventBus +    │
│  FSM, and results flow back to Main Agent.                    │
└──────────────────────────────────────────────────────────────┘
```

## Layered Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│        Channel Adapters                              │
│   CLI │ Slack │ SMS │ Web │ REST API                 │
│       ↓ All input unified as InboundMessage ↓        │
├─────────────────────────────────────────────────────┤
│        Main Agent (Global LLM Persona / Conv. Brain) │
│   Session Mgmt │ Conversation Decisions │ Simple     │
│   Tools │ Task Dispatch via spawn_subagent │              │
│   SubAgent Dispatch via spawn_subagent               │
│       ↓ Spawns task or SubAgent when needed ↓        │
├─────────────────────────────────────────────────────┤
│             EventBus (Nervous System)                │
│   Priority Queue │ Pub/Sub │ Event Routing           │
├─────────────────────────────────────────────────────┤
│         Agent (Thin Orchestrator / Event Processor)   │
│   Event Dispatch │ State Transitions │ Cognitive      │
│   Stage Dispatch │ Concurrency Control                │
├─────────────────────────────────────────────────────┤
│        AgentState (Agent Lifecycle)                    │
│   IDLE ←→ BUSY ←→ WAITING                            │
│                                                       │
├─────────────────────────────────────────────────────┤
│       Cognitive Processors (Stateless)                │
│   PostTaskReflector (async memory learning)           │
├─────────────────────────────────────────────────────┤
│          Identity Layer                               │
│   Persona │ Preferences │ Evolution                   │
├─────────────────────────────────────────────────────┤
│          Memory System                                │
│   Facts │ Episodes │ Long-term Memory                 │
├─────────────────────────────────────────────────────┤
│          LLM Adapter                                  │
│   Claude │ OpenAI │ Gemini │ Local (Ollama)           │
├─────────────────────────────────────────────────────┤
│        Capability Layer                               │
│   MCP Tools │ Skills │ A2A │ Multimodal IO            │
├─────────────────────────────────────────────────────┤
│         Infrastructure                                │
│   Storage │ Persistence │ Logging │ Config            │
└─────────────────────────────────────────────────────┘
```

## System Runtime Overview

```
                     ┌──────────────┐
  CLI ──────────────▶│              │
  Slack ────────────▶│   Channel    │
  SMS ──────────────▶│  Adapters    │
  Web ──────────────▶│              │
                     └──────┬───────┘
                            │ InboundMessage
                            ▼
                     ┌──────────────┐
                     │  Main Agent  │──── Session History (~/.pegasus/agents/main/session/)
                     │  (LLM brain) │
                     └──────┬───────┘
                            │ spawn_task / spawn_subagent
                            ▼
                     ┌──────────────┐
  Tool results ──────▶│              │
  Cognitive done ─────▶│  EventBus   │
  Task state change ──▶│ (pri queue) │
                     └──────┬───────┘
                            │ Dispatch events
                            ▼
                     ┌──────────────┐
                     │    Agent     │
                     │ (event proc) │
                     └──────┬───────┘
                            │ Lookup / drive
                            ▼
                ┌──────────────────────────────┐
                │        Agent Pool            │
                │  ┌──────┐ ┌──────┐ ┌──────┐  │
                │  │Sub A │ │Sub B │ │Sub C │  │
                │  │ BUSY │ │ IDLE │ │WAIT  │  │
                │  └──────┘ └──────┘ └──────┘  │
                └──────────────────────────────┘
                            │ Invokes
                 ┌──────────┼──────────┐
                 ▼          ▼          ▼
           ┌─────────┐ ┌────────┐ ┌────────┐
           │ Identity│ │ Memory │ │  LLM   │
           └─────────┘ └────────┘ └────────┘
```

## Cognitive Pipeline: 2-Stage (Reason → Act)

The cognitive pipeline has two active stages. There is no REFLECTING state in the FSM.

**AgentState has 3 states: IDLE, BUSY, WAITING**

The Reason → Act cycle can loop: after acting (tool calls), the FSM transitions back to REASONING for the next iteration, enabling multi-turn tool use without a dedicated reflection state.

**PostTaskReflector** runs asynchronously after a task reaches COMPLETED (fire-and-forget). It is not part of the cognitive loop and does not affect task state. It uses memory tools to decide what experiences are worth persisting to long-term memory.

**Memory index injection:** On the first cognitive iteration, the memory index is fetched and injected as the first user message in the conversation, not into the system prompt. This is cache-friendly — the system prompt remains stable across iterations.

## Comparison with Traditional Approaches

| Dimension | Traditional while-loop | Event-driven + State Machine |
|-----------|----------------------|------------------------------|
| **Concurrency** | One task at a time, serial | Multiple tasks interleave, true concurrency |
| **Blocking** | Entire Agent blocks while waiting for tool/LLM | Processes other tasks during waits |
| **Recoverability** | Process crash = task lost | State persisted, recover from checkpoint after crash |
| **Suspendable** | Not supported (or complex hacks) | Native SUSPENDED state |
| **Observability** | Requires additional logging | Event stream = natural audit log |
| **Testability** | Must mock the entire loop | Test each state transition individually |

```typescript
// ❌ Old approach: blocking while-loop
class CognitiveLoop {
    async run(task: Task): Promise<TaskResult> {
        const context = await this.perceive(task)
        while (!context.isComplete) {          // Agent is locked here
            const thinking = await this.think(context)
            const plan = await this.plan(thinking)
            const results = await this.act(plan)
            context = await this.reflect(context, results)
        }
        return context.finalResult
    }
}

// ✅ New approach: event-driven, Agent is a processor
class Agent {
    async _onTaskEvent(event: Event) {
        const task = this.registry.get(event.agentId)
        const newState = task.transition(event)       // Pure state transition
        this._dispatch(task, newState)                // Non-blocking, spawns next stage
        // Returns immediately, processes next event
    }
}
```

## Detailed Design Documents

Each subsystem's detailed design is split into its own document:

| Document | Content |
|----------|---------|
| [main-agent.md](./main-agent.md) | Main Agent: global LLM persona, conversation management, multi-channel adapters, Session persistence |
| [events.md](./events.md) | Event system: Event, EventType, EventBus, priority queue |
| [task-fsm.md](./task-fsm.md) | Task state machine: AgentState (3 states), AgentStateManager, ExecutionState |
| [agent.md](./agent.md) | Agent core: event processing, cognitive stage dispatch, concurrency control, lifecycle |
| [cognitive.md](./cognitive.md) | Cognitive pipeline: Reason → Act (2-stage), PostTaskReflector (async memory learning) |
| [task-persistence.md](./task-persistence.md) | Task persistence: incremental JSONL event logs, replay, index |
| [memory-system.md](./memory-system.md) | Long-term memory: facts + episodes, Markdown file storage |
| [tools.md](./tools.md) | Tool system: registration, execution, timeout, LLM function calling |
| [project-structure.md](./project-structure.md) | Code directory structure and module dependency graph |
