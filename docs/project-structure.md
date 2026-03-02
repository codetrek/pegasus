# Project Structure

```
pegasus/
│
├── package.json                    # Project config, dependencies
├── tsconfig.json                   # TypeScript compiler config
├── Makefile                        # Dev commands (check, coverage, etc.)
├── CLAUDE.md                       # Development guidelines
├── config.yml                      # Default configuration
│
├── docs/                           # System design documents
│   ├── architecture.md             # Layered architecture overview
│   ├── main-agent.md               # Main Agent: inner monologue, reply tool
│   ├── cognitive.md                # Cognitive pipeline: Reason → Act (2-stage)
│   ├── task-fsm.md                 # Task state machine (6 states)
│   ├── events.md                   # Event system (EventType, EventBus)
│   ├── agent.md                    # Agent (Task System): event processing
│   ├── tools.md                    # Tool system: registration, execution
│   ├── memory-system.md            # Long-term memory: facts + episodes
│   ├── task-persistence.md         # JSONL event logs, replay
│   ├── multi-model.md              # Per-role model config with ModelRegistry
│   ├── session-compact.md          # Auto-compact with context window awareness
│   ├── configuration.md            # YAML config + env var interpolation
│   ├── logging.md                  # Log format, output, rotation
│   ├── running.md                  # Setup and usage guide
│   └── progress.md                 # Milestones, test coverage
│
├── src/
│   ├── cli.ts                      # CLI channel adapter (entry point)
│   │
│   ├── agents/                     # Agent layer
│   │   ├── agent.ts                # Task execution engine (event processor)
│   │   └── main-agent.ts           # Main Agent (inner monologue + task dispatch)
│   │
│   ├── channels/                   # Channel adapter types
│   │   └── types.ts                # InboundMessage, OutboundMessage, ChannelInfo
│   │
│   ├── session/                    # Session management
│   │   ├── store.ts                # Session persistence (JSONL) + repair
│   │   └── context-windows.ts      # Model → context window size mapping
│   │
│   ├── events/                     # Event system
│   │   ├── types.ts                # Event, EventType definitions
│   │   └── bus.ts                  # EventBus (priority queue + dispatch)
│   │
│   ├── task/                       # Task state machine
│   │   ├── states.ts               # TaskState (6 states) + terminal/suspendable sets
│   │   ├── fsm.ts                  # TaskFSM (transitions + dynamic resolution)
│   │   ├── context.ts              # TaskContext, Plan, PlanStep, ActionResult, PostTaskReflection
│   │   ├── registry.ts             # TaskRegistry (active task management)
│   │   └── persister.ts            # TaskPersister (JSONL event logs, replay, recovery)
│   │
│   ├── cognitive/                  # Cognitive processors (stateless)
│   │   ├── think.ts                # Thinker — reasoning (LLM call)
│   │   ├── plan.ts                 # Planner — task planning (pure code)
│   │   ├── act.ts                  # Actor — action execution
│   │   └── reflect.ts              # PostTaskReflector — async memory learning (tool-use loop)
│   │
│   ├── tools/                      # Tool system
│   │   ├── types.ts                # Tool, ToolResult, ToolContext, ToolCategory
│   │   ├── registry.ts             # ToolRegistry (registration + LLM format)
│   │   ├── executor.ts             # ToolExecutor (validation + timeout + events)
│   │   └── builtins/               # Built-in tools
│   │       ├── index.ts            # Tool collections (allTaskTools, mainAgentTools, reflectionTools)
│   │       ├── system-tools.ts     # current_time, sleep, get_env, set_env
│   │       ├── file-tools.ts       # read_file, write_file, edit_file, grep_files, list_files, etc.
│   │       ├── network-tools.ts    # http_get, http_post, http_request, web_search
│   │       ├── data-tools.ts       # json_parse, json_stringify, base64_encode/decode
│   │       ├── memory-tools.ts     # memory_list, memory_read, memory_write, memory_patch, memory_append
│   │       ├── task-tools.ts       # task_list, task_replay
│   │       ├── reply-tool.ts       # reply (Main Agent only)
│   │       └── spawn-task-tool.ts      # spawn_task (Main Agent only)
│   │
│   ├── aitask-types/                  # AITask type system
│   │   ├── types.ts               # AITaskTypeDefinition, AITaskTypeFrontmatter
│   │   ├── loader.ts              # Parse AITASK.md files, scan directories
│   │   ├── registry.ts            # AITaskTypeRegistry (priority resolution, metadata)
│   │   └── index.ts               # Re-exports
│   │
│   ├── identity/                   # Identity layer
│   │   ├── persona.ts              # Persona type + validation
│   │   └── prompt.ts               # System prompt builder
│   │
│   ├── models/                     # Data models
│   │   └── tool.ts                 # ToolDefinition, ToolCall types
│   │
│   └── infra/                      # Infrastructure
│       ├── config-schema.ts        # Zod schema for configuration
│       ├── config-loader.ts        # YAML + env var loading
│       ├── model-registry.ts       # ModelRegistry (per-role model resolution)
│       ├── logger.ts               # pino (lazy init, file-only)
│       ├── errors.ts               # Error hierarchy (PegasusError → ...)
│       ├── id.ts                   # Short ID generation
│       ├── llm-types.ts            # LLM type definitions (Message, LanguageModel)
│       ├── llm-utils.ts            # LLM call utilities
│       ├── openai-client.ts        # OpenAI-compatible model client
│       ├── anthropic-client.ts     # Anthropic model client
│       └── token-counter.ts        # Token counting (tiktoken / Anthropic API / estimate)
│
├── tests/
│   ├── unit/                       # Unit tests
│   └── integration/                # Integration tests
│
└── data/                           # Runtime data (.gitignored)
    ├── main/                       # Main Agent session (current.jsonl)
    ├── tasks/                      # Task execution logs (JSONL per task)
    ├── memory/                     # Long-term memory (facts/, episodes/)
    ├── personas/                   # Persona config files
    └── logs/                       # Application logs
```

## Module Dependencies

```
CLI ──▶ MainAgent ──▶ Agent ──▶ cognitive (Thinker, Planner, Actor, PostTaskReflector)
           │            │          │
           │            ├──▶ task  │  (TaskFSM + TaskContext + TaskPersister)
           │            │          │
           │            ├──▶ events│  (EventBus + Event)
           │            │
           │            ├──▶ tools (ToolRegistry + ToolExecutor + builtins)
           │            │
           │            └──▶ identity (Persona + prompt)
           │
           └──▶ session (SessionStore + context-windows)

All modules ──▶ infra (config, logger, errors, ModelRegistry)
```

**Key constraints:**
- `cognitive` processors are pure functions — receive TaskContext, return results
- `task` FSM does not know about cognitive implementation details
- `events` is pure infrastructure — no business logic dependencies
- `Agent` is the thin orchestrator that connects everything
- `MainAgent` sits above Agent, managing user-facing conversation
