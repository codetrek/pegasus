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
│
├── src/
│   ├── cli.ts                      # CLI entry point
│   ├── tui.ts                      # TUI entry point
│   ├── pegasus.ts                  # PegasusApp (application orchestrator)
│   ├── index.ts                    # Module exports
│   │
│   ├── agents/                     # Agent layer
│   │   ├── agent.ts                # Agent (event processor, LLM loop)
│   │   ├── main-agent.ts           # MainAgent (inner monologue + delegation)
│   │   ├── auth-manager.ts         # OAuth/auth management
│   │   ├── reflection.ts           # Reflection utilities
│   │   ├── base/                   # Base abstractions
│   │   │   ├── agent-state.ts      # AgentState (3 states: IDLE/BUSY/WAITING)
│   │   │   ├── execution-state.ts  # Per-agent execution tracking
│   │   │   └── tool-call-collector.ts  # Concurrent tool call collection
│   │   ├── cognitive/              # Cognitive processors
│   │   │   └── reflect.ts          # PostTaskReflector (async memory learning)
│   │   ├── events/                 # Event system
│   │   │   ├── types.ts            # Event, EventType definitions
│   │   │   └── bus.ts              # EventBus (priority queue + dispatch)
│   │   ├── prompts/                # System prompt builders
│   │   │   ├── main-agent.ts       # MainAgent prompt sections
│   │   │   ├── shared.ts           # Identity, runtime, safety sections
│   │   │   ├── subagent.ts         # SubAgent prompt builder
│   │   │   ├── internal.ts         # Reflection/compact/extract prompts
│   │   │   └── skills.ts           # Skill section builder
│   │   ├── subagents/              # SubAgent type system
│   │   │   ├── types.ts            # SubAgentTypeDefinition
│   │   │   ├── loader.ts           # Parse SUBAGENT.md files
│   │   │   ├── registry.ts         # SubAgentTypeRegistry
│   │   │   └── index.ts            # Re-exports
│   │   └── tools/                  # Tool system
│   │       ├── registry.ts         # ToolRegistry (registration + LLM format)
│   │       ├── executor.ts         # ToolExecutor (validation + timeout + events)
│   │       ├── builtins/           # Built-in tools
│   │       │   ├── index.ts        # Tool collections
│   │       │   └── *.ts            # Individual tool implementations
│   │       └── browser/            # Browser automation (Playwright)
│   │           ├── browser-manager.ts  # Persistent browser context
│   │           ├── tools.ts        # Browser tool definitions
│   │           └── types.ts        # Browser types
│   │
│   ├── channels/                   # Channel adapter types
│   │   └── types.ts                # InboundMessage, OutboundMessage, ChannelInfo
│   │
│   ├── context/                    # Context window management
│   │   ├── budget.ts               # Token budget calculation
│   │   ├── model-limits.ts         # Model limit discovery
│   │   ├── model-limits-cache.ts   # Disk cache for model limits
│   │   └── providers/              # Per-provider limit adapters
│   │
│   ├── identity/                   # Identity layer
│   │   └── persona.ts              # Persona type + validation
│   │
│   ├── infra/                      # Infrastructure
│   │   ├── config-schema.ts        # Zod schema for configuration
│   │   ├── config-loader.ts        # YAML + env var loading
│   │   ├── config.ts               # Config singleton
│   │   ├── model-registry.ts       # ModelRegistry (per-tier model resolution)
│   │   ├── logger.ts               # pino (lazy init, file-only)
│   │   ├── llm-types.ts            # LLM type definitions (Message, LanguageModel)
│   │   ├── llm-utils.ts            # LLM call utilities
│   │   ├── token-counter.ts        # Token counting
│   │   ├── errors.ts               # Error hierarchy
│   │   ├── id.ts                   # Short ID generation
│   │   ├── sanitize.ts             # Input sanitization
│   │   ├── format.ts               # Formatting utilities
│   │   └── time.ts                 # Time utilities
│   │
│   ├── mcp/                        # MCP server integration
│   │   ├── auth/                   # OAuth for MCP servers
│   │   └── *.ts                    # MCP manager + transport
│   │
│   ├── media/                      # Image/media handling
│   │   ├── image-manager.ts        # Image storage + retrieval
│   │   ├── image-resize.ts         # Image resize utilities
│   │   └── types.ts                # ImageAttachment types
│   │
│   ├── models/                     # Data models
│   │   └── tool.ts                 # ToolDefinition, ToolCall types
│   │
│   ├── projects/                   # Project system
│   │   └── *.ts                    # Project manager, discovery, lifecycle
│   │
│   ├── security/                   # Security layer
│   │   └── *.ts                    # Message classification, owner tracking
│   │
│   ├── session/                    # Session management
│   │   └── store.ts                # Session persistence (JSONL) + repair
│   │
│   ├── skills/                     # Skill system
│   │   ├── loader.ts               # Parse SKILL.md files
│   │   └── registry.ts             # SkillRegistry
│   │
│   ├── stats/                      # Runtime statistics
│   │   ├── app-stats.ts            # AppStats interface + helpers
│   │   ├── stats-persistence.ts    # Stats save/load to disk
│   │   └── index.ts                # Re-exports
│   │
│   ├── storage/                    # Storage utilities
│   │   └── *.ts                    # Paths, store helpers
│   │
│   ├── tui/                        # Terminal UI dashboard
│   │   ├── app.tsx                  # TUI application root
│   │   ├── components/             # Reusable UI components
│   │   ├── hooks/                  # Solid.js hooks
│   │   └── panels/                 # Dashboard panels
│   │
│   └── workers/                    # Worker transport
│       └── worker-adapter.ts       # WorkerAdapter for Project Workers
│
├── subagents/                      # Built-in SubAgent type definitions
│   ├── explore/SUBAGENT.md         # Read-only exploration
│   ├── general/SUBAGENT.md         # Full-access general tasks
│   └── plan/SUBAGENT.md            # Planning + memory write
│
├── skills/                         # Built-in skill definitions
│   └── */SKILL.md                  # Skill definitions
│
├── tests/
│   ├── unit/                       # Unit tests
│   └── integration/                # Integration tests
│
└── data/                           # Local data (personas, etc.)
    └── personas/                   # Persona config files
```

Runtime data (sessions, memory, logs, stats) is stored in `~/.pegasus/` (configurable via `system.homeDir`).

## Module Dependencies

```
CLI / TUI ──▶ PegasusApp ──▶ MainAgent ──▶ Agent
                  │               │            │
                  │               │            ├── base (AgentState, ExecutionState)
                  │               │            ├── events (EventBus + Event)
                  │               │            ├── cognitive (PostTaskReflector)
                  │               │            └── tools (ToolRegistry + ToolExecutor + builtins + browser)
                  │               │
                  │               ├── prompts (system prompt builders)
                  │               └── session (SessionStore)
                  │
                  ├── stats (AppStats)
                  ├── context (budget, model limits)
                  └── channels (adapters)

All modules ──▶ infra (config, logger, errors, ModelRegistry)
```

**Key constraints:**
- `cognitive` contains only PostTaskReflector — the LLM loop is in Agent itself
- `events` is pure infrastructure — no business logic dependencies
- `Agent` drives the LLM tool-use loop directly via `processStep()`
- `MainAgent` sits above Agent, managing user-facing conversation
