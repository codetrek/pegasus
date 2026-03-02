# Project System

> **Status**: Design — not yet implemented

## What Is a Project?

A Project is a **long-lived task space** that MainAgent creates to manage an ongoing effort — frontend redesign, email management, social media operations, API migration, etc.

The key mental model: **one person, many projects**. MainAgent is the single brain; Projects are separate notebooks on different desks. Each notebook has its own notes, skills, and conversation history, but the same person is thinking across all of them.

| Concept | What It Is | Lifecycle | Context |
|---------|-----------|-----------|---------|
| **AITask** | One-off task executor | Created → done → discarded | Inherits from MainAgent |
| **Project** | Persistent task space | active ⇄ suspended → completed → archived | Own session, memory, skills |
| **MainAgent** | The brain | Always running | Global persona + memory |

### Why Not Just AITasks?

AITasks are fire-and-forget: MainAgent describes a task, an AITask executes it, returns a result, and disappears. This works for atomic tasks ("search for X", "write function Y") but falls apart for ongoing work that spans days or weeks:

- **No continuity**: each AITask starts from scratch. Previous context is lost.
- **No accumulation**: an AITask cannot learn and remember across multiple interactions.
- **No initiative**: an AITask cannot proactively report status or ask for help.

Projects solve all three problems.

### How It Differs from OpenClaw's Workspace

OpenClaw's Workspace is an **identity container** — each Workspace is a separate persona with its own personality, memory, and skills. Multiple Workspaces = multiple independent agents that don't know about each other.

Pegasus Projects are different: they are **work contexts owned by a single agent**. MainAgent knows all Projects, can coordinate across them, and can transfer knowledge between them. A Project is not another person — it's another desk.

## Architecture

```
MainAgent (brain, main thread)
├── CLIAdapter              ← user terminal
├── TelegramAdapter         ← Telegram messages
├── ProjectAdapter          ← single adapter, manages all Project Workers
│   ├── Worker "frontend-redesign"
│   │   └── ProjectAgent instance
│   │       ├── Proxy LanguageModel (LLM calls → main thread)
│   │       ├── Local ToolRegistry + ToolExecutor
│   │       ├── Local EventBus + TaskFSM
│   │       ├── Local SessionStore + Memory
│   │       └── spawn_task (can delegate sub-tasks)
│   ├── Worker "social-media"
│   │   └── ProjectAgent instance
│   └── ... (one Worker per active Project)
└── spawn_task (one-off, existing mechanism unchanged)
```

### Key Design Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Naming | **Project** | Distinct from OpenClaw's Workspace; intuitive |
| 2 | Core directory | `data/agents/projects/<name>/` | Unified plain directory for session, memory, skills, tasks |
| 3 | Working data | Separate from core directory | Code/work files live in independent git repos; Project directory stores only the agent's brain |
| 4 | Agent instance | **Independent Agent per Project** | Own EventBus, TaskFSM, cognitive pipeline in Worker thread |
| 5 | Lifecycle | **Four states**: active ⇄ suspended → completed → archived | Simple, no transient states |
| 6 | Concurrency | **Multiple Projects can be active in parallel** | MainAgent is a project manager overseeing many efforts |
| 7 | Communication | **Channel Adapter pattern** | Single ProjectAdapter manages all Workers, routes by channelId |
| 8 | Initial context | **PROJECT.md definition file** | MainAgent generates it at creation time; injected as system prompt |
| 9 | LLM model | **Per-Project configurable** | In PROJECT.md frontmatter; Worker reads and overrides global config |
| 10 | Tools | **Base tools + project-specific skills + spawn_task** | Projects can delegate sub-tasks just like MainAgent |
| 11 | Runtime isolation | **Bun Worker thread per active Project** | Crash isolation, parallel execution, memory separation |
| 12 | LLM calls | **Main thread only** | Worker uses proxy LanguageModel; unified credentials, concurrency, cost tracking |
| 13 | Tool execution | **Worker-local** | File I/O, HTTP, etc. run in Worker thread; parallel, isolated |
| 14 | PROJECT.md writes | **MainAgent only** | Worker reads PROJECT.md but never modifies it; avoids concurrency issues |
| 15 | Config loading | **Worker self-loads** | Worker reads config.yml (env vars inherited) + PROJECT.md overrides; init message only passes `projectPath` |

## Project Directory Structure

```
data/agents/projects/
├── frontend-redesign/
│   ├── PROJECT.md              ← definition file (system prompt + metadata)
│   ├── session/
│   │   └── current.jsonl       ← conversation history
│   ├── tasks/
│   │   ├── index.jsonl         ← task index
│   │   └── 2026-02-28/
│   │       └── abc123.jsonl    ← task event log
│   ├── memory/
│   │   ├── facts/
│   │   │   └── context.md      ← project-specific facts
│   │   └── episodes/
│   │       └── 2026-02.md      ← project-specific episodes
│   └── skills/
│       └── deploy/SKILL.md     ← project-specific skills
├── social-media/
│   ├── PROJECT.md
│   ├── session/
│   ├── tasks/
│   ├── memory/
│   └── skills/
└── api-migration/              ← status: archived
    ├── PROJECT.md
    ├── session/
    ├── tasks/
    └── memory/
```

**Important**: the Project directory stores the agent's **brain** (memory, conversation, skills, task logs), not work data. If the Project involves coding, the actual code lives in a separate git repo. The `workdir` field in PROJECT.md points to it.

## PROJECT.md Format

Follows the same frontmatter + markdown body pattern as AITASK.md and SKILL.md.

```yaml
---
name: frontend-redesign
status: active                          # active | suspended | completed | archived
model: "anthropic/claude-sonnet-4-20250514"  # optional, falls back to config default
workdir: /home/user/code/my-app         # optional, for code projects
created: 2026-02-28T10:00:00Z
suspended: null                         # timestamp of last suspension
completed: null                         # timestamp of completion
---

## Goal

Migrate the frontend component library from class components to React hooks.

## Background

- Current code is in src/components/ (~50 components)
- Using React 17, needs upgrade to React 18
- Must maintain backward compatibility during migration

## Constraints

- Migrate in batches, not all at once
- All tests must pass after each batch
- Keep backward compatibility
```

**Frontmatter fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project identifier (must match directory name) |
| `status` | Yes | Current lifecycle state |
| `model` | No | LLM model override (e.g. `"anthropic/claude-sonnet-4-20250514"`) |
| `workdir` | No | External working directory for code/data |
| `created` | Yes | Creation timestamp |
| `suspended` | No | Last suspension timestamp |
| `completed` | No | Completion timestamp |

**Body**: injected into Project Agent's system prompt. Contains goal, background, constraints — everything the agent needs to know about this project. Written by MainAgent at creation time; only MainAgent may update it.

## Lifecycle State Machine

```
    create_project()
                 │
                 ▼
            ┌─────────┐
     ┌─────►│  active  │
     │      └────┬─────┘
     │           │ suspend / idle timeout
     │           ▼
     │      ┌───────────┐
     │      │ suspended  │
     │      └────┬───────┘
     │           │ resume
     └───────────┘
                 │ complete
                 ▼
            ┌───────────┐
            │ completed  │
            └────┬───────┘
                 │ archive
                 ▼
            ┌───────────┐
            │  archived  │
            └────────────┘
```

**State descriptions**:

| State | Worker Thread | Agent Instance | Session | Description |
|-------|--------------|----------------|---------|-------------|
| **active** | Running | Running | Accumulating | Worker thread alive, processing messages |
| **suspended** | Stopped | Stopped | Preserved | Worker terminated, session/memory persisted on disk |
| **completed** | Stopped | Stopped | Preserved | Task done, results available |
| **archived** | Stopped | Stopped | Preserved | Historical record, no longer relevant |

**Transitions**:

| From | To | Trigger | What Happens |
|------|-----|---------|-------------|
| — | active | `create_project()` tool call | MainAgent generates PROJECT.md, creates directory structure, spawns Worker |
| active | suspended | `suspend_project()` / idle timeout | Graceful shutdown (see below), update PROJECT.md status |
| suspended | active | `resume_project()` / MainAgent decision | Spawn Worker, load persisted session, continue |
| active | completed | `complete_project()` / Project Agent notifies MainAgent | Graceful shutdown, update PROJECT.md status |
| completed | archived | `archive_project()` / auto-archive policy | Update status field, no data deleted |

## Communication: Channel Adapter Pattern

Project ↔ MainAgent communication reuses the existing Channel Adapter architecture. A single ProjectAdapter manages all Project Workers and routes messages by `channelId`.

### ProjectAdapter

Unlike CLIAdapter or TelegramAdapter (one adapter = one external service), ProjectAdapter is a **multiplexer**: one adapter instance manages multiple Workers, routing by `channelId` (= project name).

```typescript
class ProjectAdapter implements ChannelAdapter {
  readonly type = "project";
  private workers = new Map<string, Worker>();  // projectId → Worker

  // MainAgent → Project (route by channelId)
  async deliver(message: OutboundMessage): Promise<void> {
    const worker = this.workers.get(message.channel.channelId);
    worker?.postMessage({
      type: "message",
      text: message.text,
    });
  }

  // Start a specific Project Worker
  async startProject(projectId: string, projectPath: string,
                     agent: { send(msg: InboundMessage): void }): Promise<void> {
    const worker = new Worker("./project-agent-worker.ts", { smol: true });

    worker.onmessage = (event) => {
      if (event.data.type === "notify") {
        agent.send({
          text: event.data.text,
          channel: { type: "project", channelId: projectId },
        });
      }
    };

    // Crash detection
    worker.addEventListener("close", (event) => {
      this.workers.delete(projectId);
      agent.send({
        text: `[Project Worker crashed with exit code ${event.code}]`,
        channel: { type: "project", channelId: projectId },
      });
    });

    worker.postMessage({ type: "init", projectPath });
    this.workers.set(projectId, worker);
  }

  // Stop a specific Project Worker (graceful + timeout)
  async stopProject(projectId: string): Promise<void> {
    const worker = this.workers.get(projectId);
    if (!worker) return;

    worker.postMessage({ type: "shutdown" });

    // Wait for graceful shutdown, force terminate after timeout
    const timeout = setTimeout(() => worker.terminate(), 30_000);
    worker.addEventListener("close", () => clearTimeout(timeout));
  }

  // ChannelAdapter interface
  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    // No-op: individual projects started via startProject()
  }

  async stop(): Promise<void> {
    // Stop all Workers
    const stops = [...this.workers.keys()].map(id => this.stopProject(id));
    await Promise.all(stops);
  }
}
```

### Message Flow

```
User (CLI): "check on the frontend project"
  → CLIAdapter → MainAgent.send()
  → MainAgent LLM thinks: "I should ask the frontend-redesign project for status"
  → reply(channelType="project", channelId="frontend-redesign", text="what's your current status?")
  → ProjectAdapter.deliver() → workers.get("frontend-redesign").postMessage()
  → ProjectAgent receives message, processes it
  → ProjectAgent responds via postMessage()
  → ProjectAdapter.onmessage → MainAgent.send(channel={type:"project", channelId:"frontend-redesign"})
  → MainAgent LLM thinks: "Project says X, I should tell the user"
  → reply(channelType="cli", text="Frontend project status: ...")
  → CLIAdapter.deliver() → stdout
```

### Cross-Project Coordination

Because all Project messages flow through MainAgent, cross-project coordination is natural:

```
ProjectAdapter Worker "api-migration" → MainAgent:
  "I found a breaking API change that affects the frontend"

MainAgent thinks:
  "This is relevant to the frontend-redesign project"

MainAgent → ProjectAdapter Worker "frontend-redesign":
  "The API migration project found a breaking change in /api/users.
   Please adjust the frontend components."
```

## Worker Thread Model

Each active Project runs in a **Bun Worker thread** — a separate JavaScript runtime on its own thread.

### Why Worker Threads?

| Concern | Solution |
|---------|----------|
| **Crash isolation** | Worker crash doesn't take down MainAgent |
| **Memory isolation** | Each Project has its own heap; no cross-contamination |
| **Parallel execution** | Multiple Projects work simultaneously on different threads |
| **Clean lifecycle** | `worker.terminate()` for instant cleanup |

### Main Thread vs Worker Thread Responsibilities

| Responsibility | Where | Why |
|---------------|-------|-----|
| **LLM API calls** | Main thread | Unified credentials, single semaphore for concurrency control, centralized cost tracking |
| **Tool execution** | Worker thread | Parallel I/O, crash isolation, no main thread blocking |
| **EventBus + TaskFSM** | Worker thread | Independent state management per Project |
| **Session persistence** | Worker thread | Scoped to project directory |
| **Memory read/write** | Worker thread | Scoped to project directory |
| **PROJECT.md updates** | Main thread | Only MainAgent modifies status; avoids concurrency |

### LLM Proxy Model

Worker threads do NOT hold LLM credentials or call LLM APIs directly. Instead, the Worker's `LanguageModel` is a **proxy** that forwards requests to the main thread via `postMessage`.

```
Worker Thread                              Main Thread
┌─────────────────────┐                   ┌─────────────────────┐
│ Thinker calls       │                   │                     │
│ model.generate()    │                   │                     │
│   ↓                 │                   │                     │
│ ProxyLanguageModel  │  postMessage      │ LLM Request Handler │
│   .generate()  ─────┼──────────────────►│   ↓                 │
│                     │                   │ ModelRegistry        │
│                     │                   │   .generate()        │
│                     │  postMessage      │   ↓                 │
│   ← result    ◄─────┼──────────────────│ return result        │
│   ↓                 │                   │                     │
│ Thinker continues   │                   │                     │
└─────────────────────┘                   └─────────────────────┘
```

The proxy implements the same `LanguageModel` interface, so Thinker/PostTaskReflector are unaware they're running in a Worker. The main thread's existing `llmSemaphore` naturally limits concurrency across MainAgent + all Projects.

### Worker Architecture

```
Main Thread (MainAgent)
│
├── LLM Request Handler (receives proxy requests from all Workers)
│   └── ModelRegistry + Semaphore (shared across all Projects)
│
├── ProjectAdapter (single instance, manages all Workers)
│   ├── Worker Thread 1 (Project "frontend-redesign")
│   │   ├── Own EventBus
│   │   ├── Own Agent (TaskRegistry, TaskFSM, cognitive pipeline)
│   │   ├── Proxy LanguageModel (→ main thread)
│   │   ├── Own ToolRegistry + ToolExecutor
│   │   ├── Own SessionStore (data/agents/projects/frontend-redesign/session/)
│   │   └── Own memory tools (data/agents/projects/frontend-redesign/memory/)
│   │
│   └── Worker Thread 2 (Project "social-media")
│       └── ... (same structure)
│
└── Main thread Agent (for MainAgent's own tasks, unchanged)
```

### Worker Bootstrap

When a Project Worker starts, it self-initializes from `projectPath`:

```typescript
// project-agent-worker.ts
declare var self: Worker;

self.onmessage = async (event) => {
  if (event.data.type === "init") {
    const { projectPath } = event.data;

    // 1. Load global config (Worker reads config.yml; env vars inherited from parent)
    // 2. Load PROJECT.md → parse frontmatter for per-project overrides (model, workdir)
    // 3. Create ProxyLanguageModel (forwards LLM calls to main thread via postMessage)
    // 4. Initialize Agent with:
    //    - ProxyLanguageModel (not real LLM client)
    //    - ToolRegistry + ToolExecutor (local)
    //    - EventBus (local)
    //    - SessionStore (projectPath/session/)
    //    - Memory tools scoped to projectPath/memory/
    //    - TaskPersister writing to projectPath/tasks/
    // 5. Build system prompt from PROJECT.md body
    // 6. Load session history (if resuming from suspended)
    // 7. Start EventBus
    postMessage({ type: "ready" });
  }

  if (event.data.type === "message") {
    // MainAgent sent a message → inject as user message → trigger reasoning
    agent.submit(event.data.text, "main-agent");
  }

  if (event.data.type === "llm_response") {
    // Main thread returned LLM result → resolve pending proxy promise
    proxyModel.resolveRequest(event.data.requestId, event.data.result);
  }

  if (event.data.type === "shutdown") {
    // Graceful shutdown: flush session, stop EventBus, persist pending tasks
    await agent.shutdown();
    postMessage({ type: "shutdown-complete" });
    process.exit(0);
  }
};
```

### Shutdown Protocol

Graceful shutdown with timeout:

1. Main thread sends `{ type: "shutdown" }` to Worker
2. Worker stops accepting new tasks
3. Worker waits for current cognitive stage to complete (if any)
4. Worker flushes SessionStore and TaskPersister
5. Worker sends `{ type: "shutdown-complete" }` back
6. Main thread receives confirmation and cleans up

**Timeout**: if Worker doesn't respond within 30 seconds, main thread calls `worker.terminate()`. Session may lose the last few messages, but JSONL repair on next resume handles this (same as MainAgent crash recovery).

### Resource Management

- **`smol: true`**: reduces per-Worker memory footprint (smaller JS heap)
- **`worker.unref()`**: Workers don't prevent MainAgent from exiting
- **LLM concurrency**: controlled by main thread's `llmSemaphore` (shared across all Projects + MainAgent)
- **Tool concurrency**: each Worker has its own `toolSemaphore` (independent)

## Initial Context Injection

When MainAgent creates a Project, it does NOT copy its entire memory. Instead:

1. **MainAgent generates PROJECT.md** — writes goal, background, constraints based on what it knows
2. **PROJECT.md is the only initial context** — injected as system prompt
3. **Project Agent starts with empty memory** — it accumulates its own facts/episodes over time
4. **MainAgent can send follow-up messages** — additional context via the channel

This is analogous to a manager briefing a team lead: the manager writes a project brief (PROJECT.md), hands it to the team lead, and then they communicate via messages. The team lead doesn't get a copy of the manager's entire brain.

## MainAgent Tools for Project Management

New tools added to MainAgent's tool set:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_project` | `name`, `goal`, `background?`, `constraints?`, `model?`, `workdir?` | Create new Project: generate PROJECT.md, create directory structure, spawn Worker, status = active |
| `list_projects` | `status?` | List all Projects with status summary |
| `suspend_project` | `name` | Suspend active Project (graceful shutdown Worker, preserve state) |
| `resume_project` | `name` | Resume suspended Project (spawn Worker, load persisted session) |
| `complete_project` | `name` | Mark Project as completed (graceful shutdown Worker) |
| `archive_project` | `name` | Archive completed Project |

Note: MainAgent communicates with active Projects via the existing `reply()` tool (channelType = "project"). No special "send message to project" tool is needed.

## Project Agent Tools

A Project Agent has a similar tool set to a `general` AITask, plus:

| Tool | Description |
|------|-------------|
| `spawn_task` | Delegate one-off sub-tasks (same as MainAgent) |
| `notify` | Send messages to MainAgent (via Worker postMessage) |
| `memory_*` | Read/write its own memory (scoped to project directory) |
| `read_file`, `write_file`, etc. | File operations (scoped to workdir if specified) |
| `use_skill` | Use project-specific skills |

**Not available**:
- `reply()` — Project Agent doesn't talk to users directly; it communicates through MainAgent
- `create_project` — Projects don't create sub-projects (use tasks instead)

## Project Discovery and Startup

On MainAgent startup:

1. Scan `data/agents/projects/*/PROJECT.md`
2. Parse frontmatter to get status
3. For each `active` Project → spawn Worker thread via ProjectAdapter
4. For `suspended`/`completed`/`archived` → register metadata only (no Worker)

**Crash recovery**: if Pegasus process crashes and restarts, Projects with `status: active` in their PROJECT.md are automatically resumed. The Worker is re-spawned, and SessionStore applies the same JSONL repair logic as MainAgent (inject cancellation results for incomplete tool calls). TaskPersister marks any interrupted pending tasks as FAILED.

This mirrors how tasks and skills are discovered — file scanning, no index file.

## Session Management Within Projects

Each Project has its own SessionStore (`data/agents/projects/<name>/session/`):

- **Same format as MainAgent**: JSONL files, append-only
- **Same compaction logic**: auto-compact when context window fills up
- **Same repair logic**: on resume, repair incomplete tool calls
- **Independent from MainAgent session**: Project session tracks Project-internal conversations
- **Persisted across suspend/resume**: when a Project is resumed, its session history is loaded

## Memory Isolation

```
data/agents/main/memory/                 ← MainAgent memory (global)
├── facts/user.md
├── facts/project.md
└── episodes/2026-02.md

data/agents/projects/frontend-redesign/  ← Project memory (scoped)
├── memory/facts/context.md
├── memory/facts/decisions.md
└── memory/episodes/2026-02.md
```

- MainAgent memory = global knowledge (user preferences, system facts)
- Project memory = project-specific knowledge (decisions made, patterns found, progress notes)
- Project Agent's `memory_*` tools are scoped to `data/agents/projects/<name>/memory/`
- MainAgent can read Project memory if needed (via `memory_read` with explicit path)
- Cross-pollination happens through MainAgent ↔ Project messages, not shared memory

## Relationship to Existing Systems

### AITasks (unchanged)

The existing AITask system (`spawn_task`, TaskFSM, etc.) is unchanged. Both MainAgent and Project Agents can spawn tasks for one-off work.

### Skills

- **Global skills** (`skills/`, `data/skills/`): available to MainAgent and all Projects
- **Project skills** (`data/agents/projects/<name>/skills/`): only available to that Project
- Project Agent's SkillRegistry loads both global and project-specific skills

### Channel Adapters

ProjectAdapter is a new ChannelAdapter implementation. Unlike other adapters (one instance per external service), it multiplexes multiple Workers behind a single `type: "project"` adapter. MainAgent's existing routing logic (`find adapter by type`) works without modification.

### EventBus

Each Project Worker has its own EventBus instance. Events don't cross Worker boundaries. Communication between MainAgent and Project happens via postMessage, which the ProjectAdapter translates to/from channel events.

## Future Considerations

- **Heartbeat**: active Projects could have periodic self-check cycles (ties into the planned Heartbeat system)
- **Project templates**: pre-defined PROJECT.md templates for common project types
- **Project-to-Project communication**: currently all communication goes through MainAgent; direct Project ↔ Project channels could be added later
- **Auto-suspend**: idle timeout to automatically suspend Projects that haven't been active
- **Resource limits**: per-Project token budgets, tool call limits
- **CLI commands**: direct `/projects` command for listing status without LLM call
