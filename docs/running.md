# Running Pegasus

This document explains how to set up, configure, and run the Pegasus CLI.

## Prerequisites

1. **Bun runtime** — [bun.sh](https://bun.sh)
2. **An LLM provider** — choose one:
   - **Cloud API** — OpenAI or Anthropic API key
     - OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
     - Anthropic: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   - **Local model** — Ollama, LM Studio, or any OpenAI-compatible server (no API key required)
     - [Ollama](https://ollama.com/) — recommended, easy to use
     - [LM Studio](https://lmstudio.ai/) — GUI-based

## Quick Start

### Option 1: OpenAI (default)

```bash
# 1. Install dependencies
bun install

# 2. Set your API key
cp .env.example .env
# Edit .env — set OPENAI_API_KEY=sk-proj-...

# 3. Start the CLI
bun run dev
```

The default model is `openai/gpt-4o` as defined in `config.yml`. Override it with:

```bash
LLM_DEFAULT_MODEL=openai/gpt-4o-mini
```

### Option 2: Anthropic Claude

```bash
# In .env:
ANTHROPIC_API_KEY=sk-ant-api03-...
LLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-20250514

bun run dev
```

### Option 3: Ollama (free, local, no API key)

```bash
# 1. Install and start Ollama
# macOS/Linux: brew install ollama && ollama serve
# Or visit https://ollama.com/download

# 2. Pull a model
ollama pull llama3.2

# 3. In .env:
LLM_DEFAULT_MODEL=ollama/llama3.2:latest

# 4. Start
bun run dev
```

The `ollama` provider is pre-configured in `config.yml` to point at `http://localhost:11434/v1`.

### Welcome Screen

After launching, you will see:

```
╔══════════════════════════════════════╗
║          🚀 Pegasus CLI              ║
╚══════════════════════════════════════╝
  Persona: Pegasus (intelligent digital employee)
  Type /help for commands, /exit to quit

>
```

### Example Conversation

```bash
> Hello
  Pegasus: Hello! I'm Pegasus. How can I help you today?

> Help me brainstorm a project name
  Pegasus: [generates a reply based on persona style...]

> /exit
👋 Goodbye!
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/exit` or `/quit` | Exit the CLI |

## Configuration

### How Configuration Works

Pegasus uses a layered configuration system with the following priority (highest to lowest):

```
Environment Variables > config.local.yml > config.yml > Schema Defaults
```

- **`config.yml`** — Base configuration, checked into version control.
- **`config.local.yml`** — Local overrides, gitignored. Create this for personal settings.
- **`.env`** — Environment variables, gitignored. Used by `config.yml` via `${VAR}` interpolation.

`config.yml` supports bash-style env var interpolation:

| Syntax | Behavior |
|--------|----------|
| `${VAR}` | Use env var (empty string if unset) |
| `${VAR:-default}` | Use `default` if VAR is unset or empty |
| `${VAR:=default}` | Use and assign `default` if VAR is unset or empty |
| `${VAR:?error}` | Error if VAR is unset or empty |
| `${VAR:+alternate}` | Use `alternate` only if VAR is set |

### Multi-Model Architecture (Providers & Roles)

Pegasus supports multiple LLM providers simultaneously. The configuration uses two concepts:

**Providers** — Named connections to LLM services, defined in `llm.providers`:

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      baseURL: ${OPENAI_BASE_URL:-}

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      baseURL: ${ANTHROPIC_BASE_URL:-}

    ollama:
      type: openai          # OpenAI-compatible protocol
      apiKey: dummy
      baseURL: ${OLLAMA_BASE_URL:-http://localhost:11434/v1}
```

Each provider has:
- `type` — SDK type: `openai` or `anthropic`. Auto-detected from the provider name if the name is `openai` or `anthropic`; otherwise required.
- `apiKey` — API key (use `dummy` for local models).
- `baseURL` — Optional custom endpoint.

**Roles** — Map agent responsibilities to specific models, using `"provider/model"` format:

```yaml
llm:
  roles:
    default: openai/gpt-4o         # Main model for all tasks
    subAgent: anthropic/claude-sonnet-4-20250514  # Sub-agent tasks
    compact:                         # Context compaction (falls back to default)
    reflection:                      # Self-reflection (falls back to default)
```

Roles without a value fall back to `default`. Override via environment variables:

```bash
LLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-20250514
LLM_SUB_AGENT_MODEL=openai/gpt-4o-mini
LLM_COMPACT_MODEL=openai/gpt-4o-mini
LLM_REFLECTION_MODEL=openai/gpt-4o-mini
```

### Adding a Custom Provider

To add a new OpenAI-compatible provider (e.g., Together AI), add it to `config.yml` or `config.local.yml`:

```yaml
llm:
  providers:
    together:
      type: openai
      apiKey: ${TOGETHER_API_KEY}
      baseURL: https://api.together.xyz/v1

  roles:
    default: together/meta-llama/Llama-3-70b-chat-hf
```

### Full Configuration Reference

#### LLM Settings (`llm.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `llm.roles.default` | `openai/gpt-4o` | Default model in `provider/model` format |
| `llm.maxConcurrentCalls` | `3` | Max parallel LLM requests |
| `llm.timeout` | `120` | LLM call timeout in seconds |
| `llm.contextWindow` | Auto-detected | Override context window size (tokens) |

#### Identity (`identity.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `identity.personaPath` | `data/personas/default.json` | Path to persona JSON file |

#### Agent (`agent.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `agent.maxActiveTasks` | `5` | Max concurrent tasks |
| `agent.maxConcurrentTools` | `3` | Max parallel tool executions |
| `agent.maxCognitiveIterations` | `100` | Max cognitive loop iterations per task |
| `agent.heartbeatInterval` | `60` | Heartbeat interval in seconds |
| `agent.taskTimeout` | `300` | Max wait time for task completion (seconds) |

#### Tools (`tools.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `tools.timeout` | `60` | Tool execution timeout in seconds |
| `tools.allowedPaths` | `[]` | Allowed paths for file operations (empty = no restriction) |
| `tools.webSearch.provider` | `tavily` | Web search provider (`tavily`, `google`, `bing`, `duckduckgo`) |
| `tools.webSearch.apiKey` | — | Web search API key |
| `tools.mcpServers` | `[]` | MCP server configurations |

#### Session (`session.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `session.compactThreshold` | `0.8` | Fraction of context window that triggers compaction (0.1–1.0) |

#### System (`system.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `system.logLevel` | `info` | Log level: `debug`, `info`, `warn`, `error`, `silent` |
| `system.homeDir` | `~/.pegasus` | Home directory for auth, logs, browser profile, etc. |
| `system.logFormat` | `json` | Log format: `json` (structured) or `line` (human-readable) |

### Custom Persona

Create a persona file:

```json
{
  "name": "Alice",
  "role": "helpful assistant",
  "personality": ["friendly", "patient", "detail-oriented"],
  "style": "Professional yet warm. Uses clear examples.",
  "values": ["accuracy", "clarity", "empathy"],
  "background": "Alice is designed to help users with technical questions."
}
```

Then reference it in `.env`:

```bash
IDENTITY_PERSONA_PATH=data/personas/my-assistant.json
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start the CLI |
| `bun test` | Run all tests |
| `bun run coverage` | Run tests with coverage |
| `bun run typecheck` | Type-check without emitting |
| `bun run check` | Typecheck + test |
| `bun run logs` | Tail live logs with pretty formatting |
| `bun run logs:all` | View all rotated log files |
| `make test` | Run tests (via Makefile) |
| `make coverage` | Run tests with coverage (via Makefile) |
| `make check` | Typecheck + test (via Makefile) |

## Troubleshooting

### CLI hangs with no response

**Cause**: May be waiting for the LLM or a network issue.

**Solution**:
1. Check your network connection
2. Verify the API key is valid
3. Enable debug logging: `PEGASUS_LOG_LEVEL=debug bun run dev`
4. Press `Ctrl+C` to interrupt, then restart

### API key not set

**Error**:
```
Provider "openai" not found in llm.providers
```

**Solution**: Ensure `.env` contains the API key for the provider you're using:

```bash
# For OpenAI
OPENAI_API_KEY=sk-proj-...

# For Anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...
```

To use a local model (no API key needed):
```bash
LLM_DEFAULT_MODEL=ollama/llama3.2:latest
```

### Persona file not found

**Error**:
```
Error: ENOENT: no such file or directory
```

**Solution**: The default persona file should exist at `data/personas/default.json`. Verify:

```bash
ls data/personas/default.json
```

### API rate limit exceeded

**Error**:
```
Error: Rate limit exceeded
```

**Solution**:
1. Check your usage limits on the provider's dashboard
2. Upgrade your plan or wait for the quota to reset
3. Switch to a different provider/model temporarily

## Architecture Overview

The CLI execution flow:

```
startCLI()
  ↓
1. Load configuration     (getSettings())
2. Initialize logger      (initLogger())
3. Load persona           (loadPersona())
4. Create ModelRegistry   (new ModelRegistry(settings.llm))
5. Create MainAgent       (new MainAgent({ models, persona, settings }))
6. Start agent            (mainAgent.start())
  ↓
User input → mainAgent.send(text) → TaskFSM cognitive loop
  ↓
REASONING → ACTING → COMPLETED (or loop back to REASONING)
  ↓
mainAgent.onReply(callback) → display response to user
```

## Related Documentation

- [Architecture](./architecture.md) — System architecture overview
- [Configuration](./configuration.md) — YAML config and env var interpolation
- [Cognitive Processors](./cognitive.md) — Cognitive pipeline: Reason → Act (2-stage)
- [Memory System](./memory-system.md) — Long-term memory design
- [Logging](./logging.md) — Log format, output, and rotation
