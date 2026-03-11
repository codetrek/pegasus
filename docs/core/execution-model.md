# Execution Model: MainAgent, SubAgent, AITask, Project

> **Status**: Implemented
> **Supersedes**: Parts of [SubAgent Types](../features/subagent-types.md) (renames "subagent" → "AITask") and extends [Project System](../features/project-system.md)

## Problem Statement

The current architecture has three execution tiers: MainAgent (conversation brain), SubAgent (one-off task executor), and Project (long-lived workspace). There is a gap in the middle:

- **SubAgent is too weak**: it cannot spawn sub-tasks, coordinate multi-step work, or self-organize. It is fire-and-forget — essentially a Task with LLM capabilities.
- **Project is too heavy**: it requires persistent storage, lifecycle management, and a dedicated working directory. Overkill for complex-but-temporary work.
- **MainAgent becomes a micro-manager**: for complex temporary tasks, MainAgent must sequentially spawn → wait → spawn → wait, consuming its own context window on execution details.

### The Missing Layer

```
MainAgent  ──── Conversation layer (lightweight, decisions + communication)
    ???    ──── Execution orchestration (decompose, delegate, coordinate)
SubAgent   ──── Atomic execution (single task, fire-and-forget)
Project    ──── Long-term workspace (persistent, independent)
```

## Solution: Rename + Introduce

1. **Rename** current "SubAgent" to **AITask** — it was always a Task with LLM, not an Agent
2. **Introduce** a true **SubAgent** — a temporary Agent with orchestration capabilities

## Four Execution Tiers

```
MainAgent (conversation brain, always running)
│
├── spawn_subagent ──→ SubAgent (temporary orchestrator)
│                      │ Bun Worker thread
│                      │ Independent Agent instance
│                      │ Can spawn AITasks
│                      │ No persistent memory, no workspace
│                      │ Destroyed when done, session persisted for debugging
│                      │
│                      ├── spawn_task → AITask (explore)
│                      ├── spawn_task → AITask (plan)
│                      └── spawn_task → AITask (general)
│
├── spawn_task ──→ AITask (simple tasks, direct execution)
│                  Runs in MainAgent's Agent instance
│                  Fire-and-forget, no sub-tasks
│                  Same as current "subagent" behavior
│
└── Project (long-lived workspace, Worker thread)
    │ Independent Agent instance + persistent session + memory
    │ Can spawn AITasks
    │
    ├── spawn_task → AITask
    └── spawn_task → AITask
```

### Comparison

| Dimension | MainAgent | SubAgent | AITask | Project |
|-----------|-----------|----------|--------|---------|
| **What it is** | Conversation brain | Temporary orchestrator | Atomic executor | Long-lived workspace |
| **Lifetime** | Always running | Minutes (task duration) | Seconds to minutes | Days to weeks |
| **Thread** | Main thread | Worker thread | Caller's thread | Worker thread |
| **Agent instance** | Own | Own (independent) | Shared with caller | Own (independent) |
| **Can spawn AITask** | Yes | Yes | No | Yes |
| **Can spawn SubAgent** | Yes | No (no nesting) | No | No |
| **Persistent memory** | Yes (global) | No | No | Yes (project-scoped) |
| **Session persistence** | Yes | Yes (for debugging + resume) | No (task logs only) | Yes |
| **User communication** | `reply()` tool | Via `notify` → MainAgent | Via `notify` → caller | Via `notify` → MainAgent |
| **Data directory** | `~/.pegasus/agents/main/` | `~/.pegasus/agents/subagents/<id>/` | `~/.pegasus/agents/main/tasks/` | `~/.pegasus/agents/projects/<name>/` |

### When to Use What

These guidelines are injected into MainAgent's system prompt to help the LLM choose:

| Scenario | Use | Rationale |
|----------|-----|-----------|
| Simple question, quick lookup | `reply()` directly | No delegation needed |
| Single atomic task (search, read, write) | `spawn_task` (AITask) | One step, no coordination |
| Complex task requiring multiple steps | `spawn_subagent` (SubAgent) | Needs orchestration, multiple AITasks |
| Ongoing multi-day effort | `create_project` (Project) | Needs persistence, accumulation, initiative |

**Decision rule**: If the task can be described in one sentence and done in one pass, use AITask. If it needs breakdown, coordination, or multi-step execution, use SubAgent. If it spans days/weeks and needs its own context, use Project.

### System Prompt

The delegation guide and tool descriptions are part of MainAgent's system prompt. The prompt is source code — see `src/agents/prompts/main-agent.ts` for the actual content.

SubAgents receive their own system prompt via SUBAGENT.md definitions (see [SubAgent Types](../features/subagent-types.md)).

## SubAgent Architecture

### Runtime Model: Worker Thread

SubAgent runs in a Bun Worker thread, identical to Project. This was a deliberate choice:

**Why not main thread?**
- Two Agent instances in one thread = two EventBus consume loops competing for execution time
- Independent Semaphores bypass global concurrency control
- Crash in SubAgent affects MainAgent

**Why Worker thread is acceptable:**
- Bun Worker startup: ~4ms (measured)
- Memory overhead: ~2-3 MB per Worker (measured, amortized)
- A SubAgent's LLM calls take 2-30 seconds each — Worker overhead is <0.1% of total execution time
- Clean crash isolation, parallel execution, no shared state concerns

### Unified Worker Bootstrap

SubAgent and Project share the same Worker bootstrap script (`agent-worker.ts`). The only difference is initialization:

```typescript
// agent-worker.ts
self.onmessage = async (event) => {
  if (event.data.type === "init") {
    const { mode, config } = event.data;

    // Mode determines config source
    let persona: Persona;
    let settings: AgentSettings;
    let sessionStore: SessionStore | null;

    if (mode === "project") {
      // Load from PROJECT.md on disk
      const projectDef = parseProjectFile(config.projectPath);
      persona = buildProjectPersona(projectDef);
      settings = buildProjectSettings(config.projectPath);
      sessionStore = new SessionStore(path.join(config.projectPath, "session"));
    } else if (mode === "subagent") {
      // Load from init message (no disk)
      persona = buildSubagentPersona(config.input, config.systemPrompt);
      settings = buildSubagentSettings();
      sessionStore = new SessionStore(config.subagentDir);  // for debugging + resume
    }

    // Everything below is identical for both modes
    const proxyModel = new ProxyLanguageModel(modelId, (msg) => self.postMessage(msg));
    const agent = new Agent({ model: proxyModel, persona, settings });
    agent.onNotify(notification => {
      self.postMessage({ type: "notify", notification });
    });
    await agent.start();
    self.postMessage({ type: "ready" });
  }
  // ... message, llm_response, shutdown handlers identical
};
```

### Init Message

```typescript
// For SubAgent
{
  type: "init",
  mode: "subagent",
  config: {
    input: string;           // the task description from MainAgent
    systemPrompt?: string;   // optional custom system prompt
    subagentDir: string;      // e.g. "~/.pegasus/agents/subagents/abc123"
    memorySnapshot?: string; // MainAgent memory index (read-only, injected once)
    contextWindow?: number;  // optional override
  }
}

// For Project
{
  type: "init",
  mode: "project",
  config: {
    projectPath: string;     // e.g. "~/.pegasus/agents/projects/frontend-redesign"
    contextWindow?: number;
  }
}
```

### SubAgent Tool Set

SubAgent is an orchestrator that can also execute directly:

**Orchestration tools** (SubAgent-specific):
- `spawn_task` — create AITask within its own Agent instance
- `task_list` — query status of its AITasks
- `task_replay` — view AITask execution history
- `notify` — report to MainAgent (progress, results, questions)

**Execution tools** (same as `general` AITask):
- File I/O: read_file, write_file, list_files, edit_file, grep_files, glob_files
- Network: web_search
- Data: base64_encode, base64_decode
- System: current_time, sleep

**Memory tools** (read-only access to MainAgent memory):
- `memory_list`, `memory_read` — read from snapshot injected at init

**Not available**:
- `reply` — SubAgent doesn't talk to users; communicates through MainAgent via `notify`
- `spawn_subagent` — no nesting; SubAgent can only spawn AITasks
- Project management tools — not a project manager

### No SubAgent Nesting

```
MainAgent → SubAgent → AITask     ✅ allowed
MainAgent → SubAgent → SubAgent   ❌ forbidden
```

Rationale:
- Unbounded recursion is an architecture nightmare (resource explosion, debugging hell)
- Two levels of delegation covers virtually all use cases
- If the work truly needs deeper orchestration, it should be a Project

### Session Persistence

SubAgent persists its session to disk for two purposes:

1. **Debugging**: review SubAgent's reasoning after the fact
2. **Resume**: MainAgent can resume a completed SubAgent with new input

```
~/.pegasus/agents/subagents/
├── abc123/
│   ├── session/
│   │   └── current.jsonl    ← SubAgent conversation history
│   └── tasks/
│       └── index.jsonl      ← SubAgent's own task logs
├── def456/
│   ├── session/
│   │   └── current.jsonl
│   └── tasks/
│       └── index.jsonl
```

No memory persistence, no skills directory. SubAgent is temporary — session and task logs survive for debugging and resume.

### Lifecycle

```
spawn_subagent()
     │
     ▼
  ┌────────┐     Worker started, Agent initialized
  │ active │     Processing input, spawning AITasks
  └───┬────┘
      │ all work done / error / MainAgent cancels
      ▼
  ┌───────────┐   Worker terminated
  │ completed │   Session persisted to disk
  └───────────┘
```

No suspend/resume state machine. SubAgent either completes or fails. If MainAgent needs to interact with a completed SubAgent, it uses `resume_subagent` which:
1. Spawns a new Worker
2. Loads persisted session from disk
3. Injects new input as continuation

### Memory Access

SubAgent receives a **read-only snapshot** of MainAgent's memory index at init time. This is injected as a user message on the first cognitive iteration (same pattern as MainAgent's memory injection).

Why snapshot, not live proxy:
- SubAgent lifetime is minutes — memory doesn't change in that window
- Avoids postMessage round-trips for every memory read
- Keeps Worker self-contained

## Unified WorkerAdapter

### Transport Layer Unification

ProjectAdapter and SubAgentAdapter share ~90% of their logic: Worker lifecycle, LLM proxying, message routing. Rather than duplicating code, we extract a unified `WorkerAdapter`:

```
WorkerAdapter (transport layer — Worker lifecycle, LLM proxy, message routing)
    ├── ProjectManager (semantic layer — PROJECT.md, lifecycle FSM, disk persistence)
    └── SubAgentManager (semantic layer — spawn on-demand, auto-destroy, session cleanup)
```

### Channel Types

Different `channelType` values distinguish the source semantics:

```typescript
// Project message
{ type: "project", channelId: "frontend-redesign" }

// SubAgent message
{ type: "subagent", channelId: "abc123" }
```

MainAgent's LLM sees the channel type and understands the context:
- `type: "project"` → long-running project reporting status
- `type: "subagent"` → temporary task delivering results

### WorkerAdapter Interface

```typescript
class WorkerAdapter {
  private workers = new Map<string, WorkerEntry>();

  // Generic Worker lifecycle
  startWorker(id: string, channelType: string, initMessage: WorkerInit): Promise<void>;
  stopWorker(id: string): Promise<void>;

  // ChannelAdapter interface
  async deliver(message: OutboundMessage): Promise<void> {
    const entry = this.findWorker(message.channel);
    entry?.worker.postMessage({ type: "message", message });
  }

  // LLM proxy (shared across all Workers)
  private handleLLMRequest(workerId: string, request: LLMProxyRequest): Promise<void>;
}

interface WorkerEntry {
  worker: Worker;
  channelType: string;  // "project" | "subagent"
  channelId: string;
}
```

### Manager Responsibilities

**ProjectManager** (unchanged from current design):
- Scan `~/.pegasus/agents/projects/*/PROJECT.md` on startup
- CRUD operations (create, disable, enable, archive)
- Status transitions and PROJECT.md updates
- Calls `WorkerAdapter.startWorker()` / `stopWorker()` for lifecycle

**SubAgentManager** (new):
- Spawn SubAgent Workers on demand (from `spawn_subagent` tool)
- Track active SubAgents
- Auto-destroy Worker when SubAgent completes
- Manage session persistence path (`~/.pegasus/agents/subagents/<id>/`)
- Handle `resume_subagent` (load session, spawn new Worker)

## Communication Model

### MainAgent ↔ SubAgent

SubAgent communicates with MainAgent through the same Channel Adapter pattern as Project:

```
MainAgent spawns SubAgent:
  spawn_subagent(input="research X and write report")
    → SubAgentManager.spawn(input)
    → WorkerAdapter.startWorker(id, "subagent", initMessage)
    → Worker starts, Agent initialized
    → Worker sends { type: "ready" }

SubAgent reports to MainAgent:
  SubAgent LLM calls notify("progress: found 3 papers")
    → Agent.onNotify → Worker postMessage({ type: "notify", notification })
    → WorkerAdapter receives → MainAgent.send({ channel: { type: "subagent", channelId: id } })
    → MainAgent LLM thinks: "SubAgent is making progress, I'll wait"

SubAgent completes:
  SubAgent LLM decides work is done → final result returned
    → Agent.onNotify({ type: "completed", result })
    → Worker postMessage({ type: "notify", notification })
    → WorkerAdapter receives → MainAgent.send(...)
    → SubAgentManager auto-destroys Worker
    → MainAgent LLM thinks: "SubAgent finished, let me tell the user"
    → reply(channelType="cli", text="Here's the report...")
```

### SubAgent ↔ AITask (internal)

Inside the SubAgent Worker, AITask communication uses the standard Agent notification mechanism:

```
SubAgent's Agent instance:
  agent.onNotify(callback)  ← SubAgent's own callback
    → receives AITask completions/failures/notifications
    → SubAgent LLM sees results, decides next step

SubAgent LLM spawns AITask:
  spawn_task(type="explore", input="search for papers on X")
    → agent.submit(input, "subagent", "explore")
    → AITask executes in SubAgent's Agent instance
    → AITask completes → onNotify → SubAgent LLM sees result
```

**Key principle**: AITask results go to SubAgent, not to MainAgent. SubAgent decides what to report upstream. No level-skipping.

### MainAgent ↔ AITask (direct, unchanged)

MainAgent can still spawn AITasks directly for simple tasks:

```
MainAgent:
  spawn_task(type="explore", input="what time is it in Tokyo?")
    → agent.submit(input, "main-agent", "explore")
    → AITask executes in MainAgent's Agent instance
    → AITask completes → onNotify → MainAgent LLM sees result
```

This is the existing behavior, just renamed from `spawn_subagent` to `spawn_task`.

## MainAgent Tool Changes

### Before (current)

```
spawn_subagent(type, description, input)  → creates AITask in MainAgent's Agent
```

### After

```
spawn_task(type, description, input)      → creates AITask in MainAgent's Agent (renamed)
spawn_subagent(description, input)        → creates SubAgent in Worker thread (new)
resume_subagent(subagent_id, input)       → resumes completed SubAgent (new)
```

`spawn_task` replaces the old `spawn_subagent` for simple tasks. The new `spawn_subagent` creates a true SubAgent with orchestration capabilities.

## End-to-End Example

User: "Research the top 5 AI frameworks, compare their performance, and write a summary report."

```
MainAgent thinks:
  "This is a complex multi-step task — research + comparison + writing.
   I should spawn a SubAgent to orchestrate this."

MainAgent:
  → reply("I'll research and compare AI frameworks for you.")
  → spawn_subagent(input="Research top 5 AI frameworks, compare performance, write summary")

SubAgent (Worker thread) starts:
  SubAgent thinks: "I need to research each framework, then compare, then write."

  → spawn_task(type="explore", input="Research TensorFlow performance benchmarks")
  → spawn_task(type="explore", input="Research PyTorch performance benchmarks")
  → spawn_task(type="explore", input="Research JAX performance benchmarks")
  → spawn_task(type="explore", input="Research Keras performance benchmarks")
  → spawn_task(type="explore", input="Research MXNet performance benchmarks")
  → notify("Started research on 5 frameworks")

  [5 AITasks execute concurrently in SubAgent's Agent instance]
  [Results arrive via onNotify as each completes]

  SubAgent thinks: "All 5 research tasks done. Now I'll write the comparison."
  → notify("Research complete, writing comparison report")

  SubAgent writes the comparison directly (using its own file/data tools)
  or spawns another AITask:
  → spawn_task(type="general", input="Write comparison report based on: [results]")

  [Report AITask completes]

  SubAgent thinks: "Report is done. I'll return the final result."
  → Task completes with final result

MainAgent receives SubAgent completion:
  → Sees final report in notification
  → reply("Here's the comparison report: ...")
  → SubAgentManager auto-destroys Worker
```

## Migration Path

### Implementation Order

**Phase 1 and Phase 2 MUST be executed sequentially.** Phase 1 (rename) must be fully completed, tested, and merged before Phase 2 (new SubAgent) begins. Rationale: if both happen concurrently, "subagent" in the codebase is ambiguous — does it mean the old concept (AITask) or the new concept (true SubAgent)? This will cause confusion in code review, testing, and debugging.

#### Phase 1: Rename SubAgent → AITask (pure rename, no behavior change)

All existing "subagent" references that mean "one-off task executor" are renamed to "AITask" / "task". This is a mechanical rename — no logic changes, no new features.

**Source files** (15 files, ~129 occurrences):

| File | Changes |
|------|---------|
| `src/subagents/` → `src/agents/subagents/` | Rename directory |
| `src/subagents/types.ts` → `src/agents/subagents/types.ts` | `SubagentDefinition` → `SubAgentTypeDefinition` |
| `src/subagents/registry.ts` → `src/agents/subagents/registry.ts` | `SubagentRegistry` → `SubAgentTypeRegistry` |
| `src/subagents/loader.ts` → `src/agents/subagents/loader.ts` | `loadSubagentDefinitions` → `loadSubAgentTypeDefinitions`, `SUBAGENT.md` → `SUBAGENT.md` |
| `src/subagents/index.ts` → `src/agents/subagents/index.ts` | Re-export updated names |
| `src/tools/builtins/spawn-subagent-tool.ts` → `src/tools/builtins/spawn-task-tool.ts` | Tool name `spawn_subagent` → `spawn_task` |
| `src/tools/builtins/index.ts` | Import path + export name updates |
| `src/agents/agent.ts` | `SubagentRegistry` → `SubAgentTypeRegistry`, `subagentRegistry` → `subAgentTypeRegistry` |
| `src/agents/main-agent.ts` | `_handleSpawnSubagent` → `_handleSpawnTask`, tool name matching |
| `src/prompts/main-agent.ts` | `subagentMetadata` → `subAgentMetadata`, `subagentPrompt` → `subAgentPrompt`, prompt text |
| `src/cognitive/think.ts` | `subagentPrompt` parameter rename |
| `src/task/context.ts` | Comment updates only |
| `src/task/task-type.ts` | Comment updates only |
| `src/infra/config-schema.ts` | `subAgent` role name unchanged (this is an LLM role, not a concept name) |
| `src/infra/model-registry.ts` | Same — `subAgent` role stays |
| `src/projects/project-adapter.ts` | `"subAgent"` model role reference unchanged |

**Type definition files**:

| File | Changes |
|------|---------|
| `subagents/` → `subagents/` | Rename top-level directory |
| `subagents/*/SUBAGENT.md` → `subagents/*/SUBAGENT.md` | Rename definition files (3 files) |

**Test files** (4 files):

| File | Changes |
|------|---------|
| `tests/unit/tools/spawn-subagent-tool.test.ts` → `spawn-task-tool.test.ts` | Rename + update tool name references |
| `tests/unit/task-type.test.ts` | `SubagentRegistry` → `SubAgentTypeRegistry` |
| `tests/unit/main-agent.test.ts` | `spawn_subagent` → `spawn_task` in tool call mocks |
| `tests/unit/identity.test.ts` | `subagentMetadata` → `subAgentMetadata` |

**Documentation** (11 files — excluding this document):

| File | Changes |
|------|---------|
| `docs/README.md` | Update references |
| `docs/architecture.md` | Update diagram + text |
| `docs/main-agent.md` | `spawn_subagent` → `spawn_task` throughout |
| `docs/task-types.md` | Rename to `subagent-types.md`; update all "subagent" → "AITask" |
| `docs/project-system.md` | Update references |
| `docs/tools.md` | Update tool name |
| `docs/project-structure.md` | Update directory references |
| `docs/skill-system.md` | Update references |
| `docs/multi-model.md` | Update references |
| `docs/codex-api.md` | Minor reference updates |
| `docs/todos.md` | Update references |

**Config**: `config.yml` `roles.subAgent` — **DO NOT rename**. This is the LLM model role for lightweight tasks. It predates and is independent of the "subagent" concept being renamed. Renaming it would break user configs.

**What does NOT change in Phase 1**:
- No new features, no new files, no new tools
- `taskType` field in TaskContext — unchanged
- Runtime behavior — identical
- Task JSONL format — unchanged (backward compatible)
- Config file — `roles.subAgent` stays

**Verification**: `make check` passes, `make coverage` meets 95% threshold, all tests green.

#### Phase 2: Introduce True SubAgent (new feature)

Only starts after Phase 1 is merged to main.

**New components**:

| Component | Description |
|-----------|-------------|
| `src/workers/worker-adapter.ts` | Unified Worker transport (extracted from ProjectAdapter) |
| `src/workers/agent-worker.ts` | Unified Worker bootstrap (replaces project-worker.ts) |
| `src/agents/subagents/manager.ts` | SubAgentManager — spawn, track, destroy Workers |
| `src/agents/subagents/types.ts` | SubAgent type definitions |
| `src/tools/builtins/spawn-subagent-tool.ts` | New `spawn_subagent` tool for MainAgent |
| `src/tools/builtins/resume-subagent-tool.ts` | New `resume_subagent` tool for MainAgent |

**Modified components**:

| Component | Changes |
|-----------|---------|
| `src/projects/project-adapter.ts` | Extract Worker management → `WorkerAdapter`; ProjectAdapter becomes thin wrapper |
| `src/projects/project-worker.ts` | Replace with `agent-worker.ts` (unified bootstrap) |
| `src/agents/main-agent.ts` | Register WorkerAdapter, handle SubAgent spawn/completion |
| `src/prompts/main-agent.ts` | New system prompt sections (Tools, Delegation Guide) |
| `src/tools/builtins/index.ts` | Add `spawn_subagent`, `resume_subagent` to MainAgent tools |

**New directories**:

```
src/workers/          ← unified Worker management
src/agents/subagents/         ← SubAgent lifecycle (NOT src/subagents/ — that's gone in Phase 1)
~/.pegasus/agents/subagents/       ← runtime SubAgent sessions (created at runtime)
```

**Documentation updates**:

| File | Changes |
|------|---------|
| `docs/execution-model.md` | This document — status updated to "implemented" |
| `docs/architecture.md` | Updated to show four execution tiers |
| `docs/main-agent.md` | Updated tool set + delegation guide |
| `docs/project-system.md` | Worker threading model references WorkerAdapter |
| `docs/README.md` | Updated project structure + document list |

### Backward Compatibility

- AITask behavior is identical to current "subagent" behavior — only renamed
- ProjectAdapter code moves into WorkerAdapter but behavior unchanged
- MainAgent's LLM sees new tool names; system prompt updated accordingly
- Existing task JSONL files remain compatible (taskType field unchanged)
- Config `roles.subAgent` unchanged — no user config breakage

## Relationship to Other Documents

| Document | Relationship |
|----------|-------------|
| [Architecture](./architecture.md) | Updated to show four execution tiers |
| [Main Agent](./main-agent.md) | Updated tool set (spawn_task + spawn_subagent) |
| [SubAgent Types](../features/subagent-types.md) | Renamed to "AITask Types"; content mostly unchanged |
| [Project System](../features/project-system.md) | Worker threading model shared; ProjectAdapter → WorkerAdapter |
| [Agent Core](./agent.md) | Unchanged — Agent class used by MainAgent, SubAgent, and Project |
| [Cognitive Processors](./cognitive.md) | Unchanged — same pipeline for all tiers |
