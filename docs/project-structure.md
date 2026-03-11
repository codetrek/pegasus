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
│   │       ├── system-tools.ts     # current_time, sleep
│   │       ├── file-tools.ts       # read_file, write_file, edit_file, grep_files, list_files, etc.
│   │       ├── network-tools.ts    # web_search, web_fetch
│   │       ├── data-tools.ts       # base64_encode/decode
│   │       ├── memory-tools.ts     # memory_list, memory_read, memory_write, memory_patch, memory_append
│   │       ├── task-tools.ts       # task_list, task_replay
│   │       ├── reply-tool.ts       # reply (Main Agent only)
│   │       └── spawn-task-tool.ts      # spawn_task (Main Agent only)
│   │
│   ├── subagents/                  # SubAgent type system
│   │   ├── types.ts               # SubAgentTypeDefinition, SubAgentTypeFrontmatter
│   │   ├── loader.ts              # Parse SUBAGENT.md files, scan directories
│   │   ├── registry.ts            # SubAgentTypeRegistry (priority resolution, metadata)
│   │   └── index.ts               # Re-exports
│   │
│   ├── identity/                   # Identity layer
│   │   ├── persona.ts              # Persona type + validation
│   │   └── prompt.ts               # System prompt builder
│   │
│   ├── models/                     # Data models
│   │   └── tool.ts                 # ToolDefinition, ToolCall types
│   │
│   ├── context/                    # Context window management
│   │   ├── budget.ts               # computeTokenBudget (input budget, compact trigger)
│   │   ├── constants.ts            # Tuning parameters (thresholds, limits)
│   │   ├── context-windows.ts      # Model → context window size mapping
│   │   ├── model-limits.ts         # Static model limits registry
│   │   ├── model-limits-cache.ts   # Cached provider-fetched model limits
│   │   ├── overflow.ts             # Context overflow error detection
│   │   ├── summarizer.ts           # Chunked message summarization
│   │   ├── tool-result-guard.ts    # Tool result truncation
│   │   └── providers/              # Provider-specific model limit fetchers
│   │
│   ├── stats/                      # Runtime statistics
│   │   ├── app-stats.ts            # AppStats type + create/record helpers
│   │   ├── stats-persistence.ts    # Save/load cumulative stats to disk
│   │   └── index.ts                # Re-exports
│   │
│   ├── storage/                    # Storage path management
│   │   └── paths.ts                # AgentStorePaths builders (main, subagent, project)
│   │
│   ├── tui/                        # Terminal UI (Solid.js + @opentui/solid)
│   │   ├── app.tsx                 # Root component (responsive layout)
│   │   ├── main.tsx                # Render entry point
│   │   ├── bridge.ts              # AppStats → Solid store polling bridge
│   │   ├── store.ts                # Reactive store (chat messages, stats)
│   │   ├── theme.tsx               # Color theme constants
│   │   ├── components/             # Shared components (TopBar, InputBar, TabBar)
│   │   ├── panels/                 # Panel components (ChatPanel, OpsPanel, MetricsPanel)
│   │   └── hooks/                  # Custom hooks (terminal size)
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
    └── personas/                   # Persona config files
```

### Home Directory (`~/.pegasus/`)

Runtime data stored under `system.homeDir` (default `~/.pegasus/`):

```
~/.pegasus/
├── agents/
│   ├── main/
│   │   ├── session/                # MainAgent session (current.jsonl + archives)
│   │   ├── memory/                 # Long-term memory (facts/, episodes/)
│   │   └── subagents/              # Subagent task logs
│   └── projects/                   # Project workspaces (one dir per project)
├── logs/                           # Application logs (daily rotation)
├── media/                          # Image/media storage
├── auth/                           # Auth credentials (OAuth tokens, MCP auth)
├── model-limits/                   # Cached model limits from providers
├── browser/                        # Browser user data (Playwright profile)
├── skills/                         # User-defined global skills
├── subagents/                      # User-defined subagent types
└── stats.json                      # Persisted cumulative statistics
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
