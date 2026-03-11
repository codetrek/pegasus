# Pegasus — Technical Documentation

Developer guide for building, configuring, and understanding Pegasus internals.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- **Choose one LLM provider**:
  - **OpenAI API Key** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  - **Anthropic API Key** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
  - **GitHub Copilot** — device code OAuth (no API key needed)
  - **OpenAI Codex** — device code OAuth (no API key needed)
  - **Local model** — [Ollama](https://ollama.com/) or [LM Studio](https://lmstudio.ai/) (no API key needed)

### Install & Run

```bash
bun install
cp .env.example .env   # edit .env with your API key
bun run dev
```

### Configure

Layered config: `config.yml` (base) → `config.local.yml` (override) → env vars → Zod validation.

```yaml
# config.local.yml
llm:
  providers:
    openai:
      apiKey: sk-proj-your-key

  tiers:
    fast: openai/gpt-4o-mini
    balanced: openai/gpt-4o
    # Extended form with per-tier options:
    # powerful:
    #   model: myhost/claude-sonnet-4
    #   contextWindow: 200000
    #   apiType: anthropic
```

See [Configuration](./llm/configuration.md) for full reference.

## Architecture

```
┌─────────────────────────────────────┐
│  Channel Adapters (CLI / Telegram)  │
├─────────────────────────────────────┤
│  Main Agent (inner monologue +      │
│              reply tool)            │
├─────────────────────────────────────┤
│  EventBus → Agent → AgentState     │
│  Reason → Act (+ async Reflection) │
├─────────────────────────────────────┤
│  Tools │ Memory │ Identity │ LLM   │
└─────────────────────────────────────┘
```

## Project Structure

```
pegasus/
├── src/
│   ├── agents/          # MainAgent, Agent, SubAgent
│   │   ├── base/        # AgentState, ExecutionState
│   │   ├── cognitive/   # Reason → Act + PostTaskReflector
│   │   ├── events/      # EventType, EventBus
│   │   ├── prompts/     # System prompt builders
│   │   ├── subagents/   # SubAgent type registry + loader
│   │   └── tools/       # Tool registry, executor, builtins, browser
│   ├── channels/        # Channel adapter types
│   ├── context/         # Context window budget + model limits
│   ├── identity/        # Persona + system prompt builder
│   ├── infra/           # Config, Logger, LLM clients, ModelRegistry
│   ├── mcp/             # MCP server integration + OAuth
│   ├── media/           # Image handling (resize, store, prune)
│   ├── models/          # ToolCall, ToolDefinition types
│   ├── projects/        # Project system (Worker threads)
│   ├── security/        # Trust-based routing, owner identity
│   ├── session/         # Session persistence + compaction
│   ├── skills/          # Skill loader + registry
│   ├── stats/           # AppStats (runtime statistics for TUI)
│   ├── storage/         # Storage utilities
│   ├── tui/             # Terminal UI dashboard
│   ├── workers/         # Worker transport (WorkerAdapter)
│   └── cli.ts           # CLI entry point
├── subagents/           # Built-in SubAgent type definitions (SUBAGENT.md)
├── tests/
│   ├── unit/
│   └── integration/
├── docs/                # Design documents (this directory)
├── skills/              # Built-in skill definitions
└── config.yml           # Default configuration
```

## Design Documents

### `core/` — Core Architecture
- [Architecture](./core/architecture.md) — layered design, core abstractions, data flow
- [Main Agent](./core/main-agent.md) — inner monologue, session, system prompt
- [Agent Core](./core/agent.md) — event processing, agent state, concurrency
- [Cognitive Processors](./core/cognitive.md) — Reason → Act (2-stage) + async PostTaskReflector
- [Event System](./core/events.md) — EventType, EventBus, priority queue
- [Task FSM](./core/task-fsm.md) — agent states, transitions (IDLE/BUSY/WAITING)
- [Execution Model](./core/execution-model.md) — four execution tiers: MainAgent, SubAgent, Task, Project

### `llm/` — LLM & Model
- [Configuration](./llm/configuration.md) — YAML config, env var interpolation, tier options
- [Multi-Model](./llm/multi-model.md) — per-tier model config, ModelRegistry
- [Model Input Limits](./llm/model-input-limits.md) — context window budgets, token limits
- [Codex API](./llm/codex-api.md) — OpenAI Codex integration, Responses API, OAuth

### `features/` — Features
- [Tool System](./features/tools.md) — registration, execution, timeout, LLM function calling
- [Memory System](./features/memory-system.md) — long-term memory (facts + episodes)
- [Session Compact](./features/session-compact.md) — auto-compact with context window awareness
- [Skill System](./features/skill-system.md) — SKILL.md format, loader, registry, triggering
- [Vision Support](./features/vision.md) — image input, storage, hydration, pruning
- [Browser Tools](./features/browser-tools.md) — browser automation tools
- [Security](./features/security.md) — trust-based channel routing, owner identity, prompt injection resistance
- [MCP Auth](./features/mcp-auth.md) — MCP server authentication
- [Project System](./features/project-system.md) — long-lived task spaces, Worker threads
- [SubAgent Types](./features/subagent-types.md) — sub-agent type specialization (SUBAGENT.md)
- [Task Persistence](./features/task-persistence.md) — JSONL event logs, replay

### `ops/` — Operations & Observability
- [Running Guide](./ops/running.md) — setup, usage, deployment
- [Logging](./ops/logging.md) — log format, output, rotation
- [AppStats](./ops/app-stats.md) — runtime statistics for TUI dashboard (counters, snapshots, polling)

### Root
- [Project Structure](./project-structure.md) — source tree overview
- [TODOs](./todos.md) — completed and planned features

## Development

```bash
make check     # typecheck + tests
make coverage  # tests + coverage report (95% per file threshold)
bun test       # run tests only
```

### Workflow

All changes go through Pull Request:

1. Create feature branch (use `.worktrees/` for isolation)
2. Implement + test (≥ 95% coverage per file)
3. Push (pre-push hook checks coverage)
4. Create PR → CI runs typecheck + tests + coverage
5. Merge to main when CI passes

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Language | TypeScript 5.x |
| Schema | Zod |
| Logger | pino (lazy init, file-only) |
| Test | bun:test |
| Token counting | tiktoken (OpenAI) / Anthropic API |
| LLM | OpenAI / Anthropic / Codex / Copilot SDKs |
