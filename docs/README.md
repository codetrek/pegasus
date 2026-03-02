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

  roles:
    default: openai/gpt-4o                    # shorthand string
    subAgent: openai/gpt-4o-mini
    # Extended form with per-role options:
    # subAgent:
    #   model: myhost/claude-sonnet-4
    #   contextWindow: 200000
    #   apiType: anthropic
```

See [Configuration](./configuration.md) for full reference.

## Architecture

```
┌─────────────────────────────────────┐
│  Channel Adapters (CLI / Telegram)  │
├─────────────────────────────────────┤
│  Main Agent (inner monologue +      │
│              reply tool)            │
├─────────────────────────────────────┤
│  EventBus → Agent → TaskFSM        │
│  Reason → Act (+ async Reflection) │
├─────────────────────────────────────┤
│  Tools │ Memory │ Identity │ LLM   │
└─────────────────────────────────────┘
```

## Project Structure

```
pegasus/
├── src/
│   ├── agents/          # MainAgent + Task Agent
│   ├── cognitive/       # Reason → Act + PostTaskReflector
│   ├── channels/        # Channel adapter types
│   ├── events/          # EventType, EventBus
│   ├── identity/        # Persona + system prompt builder
│   ├── infra/           # Config, Logger, LLM clients, ModelRegistry
│   ├── mcp/             # MCP server integration + OAuth
│   ├── models/          # ToolCall, ToolDefinition types
│   ├── projects/        # Project system (Worker threads)
│   ├── workers/         # Unified Worker transport (WorkerAdapter)
│   ├── subagent/        # SubAgent lifecycle (SubAgentManager)
│   ├── session/         # Session persistence + compaction
│   ├── skills/          # Skill loader + registry
│   ├── aitask-types/   # Task type specialization (AITASK.md)
│   ├── task/            # TaskFSM + TaskContext + TaskPersister
│   ├── tools/           # Tool registry, executor, builtins
│   └── cli.ts           # CLI entry point
├── tests/
│   ├── unit/
│   └── integration/
├── docs/                # Design documents (this directory)
├── skills/              # Built-in skill definitions
├── data/                # Runtime data (sessions, tasks, memory)
└── config.yml           # Default configuration
```

## Design Documents

### Core
- [Architecture](./architecture.md) — layered design, core abstractions, data flow
- [Main Agent](./main-agent.md) — inner monologue, session, system prompt
- [Agent Core](./agent.md) — event processing, cognitive dispatch, concurrency
- [Cognitive Processors](./cognitive.md) — Reason → Act (2-stage) + async PostTaskReflector

### Task & Event System
- [Event System](./events.md) — EventType, EventBus, priority queue
- [Task FSM](./task-fsm.md) — states, transitions, suspend/resume
- [Task Persistence](./task-persistence.md) — JSONL event logs, replay
- [AITask Types](./aitask-types.md) — task type specialization (AITASK.md)

### LLM & Model
- [Multi-Model](./multi-model.md) — per-role model config, ModelRegistry
- [Configuration](./configuration.md) — YAML config, env var interpolation, role options
- [Codex API](./codex-api.md) — OpenAI Codex integration, Responses API, OAuth

### Features
- [Tool System](./tools.md) — registration, execution, timeout, LLM function calling
- [Memory System](./memory-system.md) — long-term memory (facts + episodes)
- [Session Compact](./session-compact.md) — auto-compact with context window awareness
- [Skill System](./skill-system.md) — SKILL.md format, loader, registry, triggering
- [Project System](./project-system.md) — long-lived task spaces, Worker threads
- [Execution Model](./execution-model.md) — four execution tiers: MainAgent, SubAgent, AITask, Project
- [MCP Auth](./mcp-auth.md) — MCP server authentication

### Operations
- [Running Guide](./running.md) — setup, usage, deployment
- [Logging](./logging.md) — log format, output, rotation
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
