# Agent (Task System)

> Source code: `src/pegasus/agents/agent.ts`

## Core Idea

Agent is a **thin orchestrator**, not a fat controller. It does only three things:
1. Receive an event
2. Find the corresponding TaskFSM and execute a state transition
3. Based on the new state, non-blockingly spawn the corresponding cognitive stage processor

Agent itself **holds no task execution state**. All state lives in TaskFSM.

## Structure

```typescript
class Agent {
    eventBus: EventBus                  // event bus
    taskRegistry: TaskRegistry          // active task registry

    // Cognitive processors (stateless)
    thinker: Thinker                    // reasoning (LLM call)
    planner: Planner                    // planning (pure code, called within Reason)
    actor: Actor                        // action execution
    postReflector: PostTaskReflector    // async post-task reflection (memory learning)

    // Tool infrastructure
    toolExecutor: ToolExecutor          // tool executor (uses global registry)
    toolRegistry: ToolRegistry          // global registry (all tools, for ToolExecutor)
    typeToolRegistries: Map<string, ToolRegistry>  // per-type registries (for LLM visibility + validation)
    reflectionToolRegistry: ToolRegistry // memory tools for PostTaskReflector (read/write/patch/append, no list)

    // Concurrency control
    llmSemaphore: Semaphore             // limits concurrent LLM calls
    toolSemaphore: Semaphore            // limits concurrent tool calls
    backgroundTasks: Set<Promise>       // tracks background tasks
}
```

## Event Subscription Table

Agent registers two categories of handlers at startup:

**External input → `_onExternalInput`** (creates new tasks):
- `MESSAGE_RECEIVED`
- `WEBHOOK_TRIGGERED`
- `SCHEDULE_FIRED`

**Task events → `_onTaskEvent`** (drives state transitions):
- `TASK_CREATED`, `TASK_SUSPENDED`, `TASK_RESUMED`
- `REASON_DONE`
- `STEP_COMPLETED`, `TOOL_CALL_COMPLETED`, `TOOL_CALL_FAILED`
- `NEED_MORE_INFO`

Note: `REFLECTION_COMPLETE` is **not** subscribed by the Agent — it is an observability-only event handled by TaskPersister.

## Event Processing Flow

### External Input Processing

```
MESSAGE_RECEIVED / WEBHOOK_TRIGGERED / SCHEDULE_FIRED
    ↓
_onExternalInput(event)
    ↓
1. TaskFSM.fromEvent(event)     ← create new task
2. taskRegistry.register(task)   ← register
3. emit(TASK_CREATED)             ← start the state machine
```

### Task Event Processing

```
Any task-related event
    ↓
_onTaskEvent(event)
    ↓
1. taskRegistry.get(event.taskId)  ← find task
2. task.transition(event)           ← execute state transition
3. _dispatchCognitiveStage(task, newState)  ← launch next stage
```

### Cognitive Stage Dispatch

`_dispatchCognitiveStage` is a switch statement that spawns the appropriate processor based on the new state:

```typescript
switch (state) {
    case REASONING   → _spawn(_runReason(task))
    case ACTING      → _spawn(_runAct(task))
    case SUSPENDED   → // do nothing, wait for external event
    case COMPLETED   → _compileResult(task)
                       emit(TASK_COMPLETED)
                       notify callback
                       if shouldReflect(context) → _spawn(_runPostReflection(task))
    case FAILED      → emit(TASK_FAILED), notify callback
}
```

**`_spawn` is key**: non-blockingly starts an async task and returns immediately. When the processor completes, it emits a new event that drives the state machine forward. All background tasks are tracked in the `backgroundTasks` set and collectively awaited during shutdown.

## Cognitive Stage Execution

### _runReason — Merged Reasoning Stage

```typescript
async _runReason(task, trigger):
    // 0. Guard: check max cognitive iterations
    task.context.iteration++
    if (iteration > maxCognitiveIterations) → emit(TASK_FAILED)

    // 1. Fetch memory index ONLY on first iteration
    memoryIndex = undefined
    if (task.context.iteration === 1)
        memoryIndex = await toolExecutor.execute("memory_list", ...)

    // 2. LLM call — understand + reason + tool selection
    //    memoryIndex (if present) is injected as a user message, not system prompt
    reasoning = await llmSemaphore.use(() =>
        thinker.run(task.context, memoryIndex)
    )
    task.context.reasoning = reasoning

    // 3. Pure code — convert toolCalls to Plan steps
    plan = await planner.run(task.context)
    task.context.plan = plan

    // 4. Emit event
    if (reasoning.needsClarification)
        emit(NEED_MORE_INFO)
    else
        emit(REASON_DONE)
```

One LLM call handles everything. Planner is called internally without an FSM state transition. Memory index is fetched once at iteration=1 and injected as a user message — subsequent iterations already have it in conversation history.

### _runAct — Action Execution

Act executes Plan steps one at a time. The key difference from Reason: there is no single "act done" event. Instead, each step completion emits its own event, and the FSM dynamically resolves the next state:

```
_runAct(task)
  ↓
plan.currentStep exists?
  ├── Yes → execute the step
  │         ↓
  │   tool_call? → toolSemaphore.use → toolExecutor.execute
  │                → context.actionsDone.push(result)
  │                → markStepDone
  │                → ToolExecutor.emitCompletion → TOOL_CALL_COMPLETED
  │   respond?  → synchronous completion
  │                → context.actionsDone.push(result)
  │                → markStepDone
  │                → emit(STEP_COMPLETED)
  │         ↓
  │   FSM dynamic resolution:
  │     more steps → ACTING (continue)
  │     all done + has tool_call steps → REASONING
  │     all done + respond only → COMPLETED
  └── No → return (already handled by last event)
```

The last `STEP_COMPLETED` or `TOOL_CALL_COMPLETED` event triggers FSM dynamic resolution, which determines whether to continue acting, loop back to reasoning, or complete.

### _runPostReflection — Async Memory Learning

```typescript
async _runPostReflection(task):
    // 1. Pre-load existing memory for context
    existingFacts = await loadAllFactFiles()      // full content
    episodeIndex = await loadEpisodeIndex()        // summaries only

    // 2. Tool-use loop — LLM calls memory tools directly
    //    reflectionToolRegistry provides: memory_read, memory_write, memory_patch, memory_append
    //    (no memory_list — index is pre-loaded above)
    reflection = await llmSemaphore.use(() =>
        postReflector.run(task.context, existingFacts, episodeIndex)
    )
    task.context.postReflection = reflection
    // reflection = { assessment: string, toolCallsCount: number }

    // 3. Emit observability event
    emit(REFLECTION_COMPLETE)
```

**Fire-and-forget**: this runs after the task is already COMPLETED. The LLM directly calls memory tools in a tool-use loop (max 5 rounds) — no JSON parsing or proxy memory writes needed. Errors are caught and logged but never affect the task result. `shouldReflect(context)` filters out trivial tasks to avoid unnecessary LLM calls.

## Concurrency Control

### Semaphores

```typescript
llmSemaphore = new Semaphore(maxConcurrentCalls)   // default 3
toolSemaphore = new Semaphore(maxConcurrentTools)   // default 3
```

- Thinker and PostTaskReflector acquire `llmSemaphore` before calling LLM
- Actor acquires `toolSemaphore` before calling tools
- Calls exceeding the limit automatically queue and wait

### Task Concurrency

TaskRegistry has a `maxActiveTasks` limit (default 5). Multiple tasks can simultaneously be in different cognitive stages, e.g.:
- Task A in ACTING (waiting for tool return)
- Task B in REASONING (waiting for LLM semaphore)

They do not block each other, naturally scheduled by the EventBus.

## External API

```typescript
// Submit a task, returns taskId
const taskId = await agent.submit("Search for papers")

// Submit with a specific task type
const taskId = await agent.submit("Search for papers", "user", "explore")

// Wait for task to complete (for testing)
const task = await agent.waitForTask(taskId, 5000)

// Register notification callback
agent.onNotify((notification) => {
    // notification.type: "completed" | "failed" | "notify"
    // notification.taskId, notification.result / notification.error / notification.message
})
```

`submit` is the primary way CLI/API calls the Agent. Internally it emits a `MESSAGE_RECEIVED` event and waits for a `TASK_CREATED` event to return the taskId. The optional `taskType` parameter (`"general"`, `"explore"`, or `"plan"`) determines which tool set and system prompt the task uses (see `docs/aitask-types.md`).

`onNotify` handles three notification types:
- `completed` — task finished with a result
- `failed` — task failed with an error
- `notify` — task sends an interim message (via the `notify()` tool)

When a task calls the `notify()` tool during execution, Agent intercepts the tool result, emits a `TASK_NOTIFY` event (persisted by TaskPersister), and calls `notifyCallback` so MainAgent receives the message immediately.

## Lifecycle

```typescript
const agent = new Agent(deps)
await agent.start()    // start EventBus + subscribe events + emit SYSTEM_STARTED
// ... running ...
await agent.stop()     // wait for background tasks + stop EventBus
```

Graceful shutdown: first waits for all background tasks (`backgroundTasks`), then stops the EventBus.

## Why This Is "Pure State-Driven"

| Property | Implementation |
|----------|---------------|
| **Non-blocking** | `_onTaskEvent` spawns async operations and returns immediately |
| **Concurrent** | EventBus does not wait for handler completion; can immediately process next event |
| **Interruptible** | Emit `TASK_SUSPENDED` at any time; task saves context and enters suspension |
| **Recoverable** | TaskFSM's complete state is serializable; recovers from checkpoint after crash |
| **Observable** | Every state transition recorded in history; every event has a causality chain |
