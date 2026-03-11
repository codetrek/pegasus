# Pegasus Configuration Guide

Pegasus uses a **layered YAML configuration** system with environment variable interpolation.

## Quick Start

### Option 1: Config File (Recommended)

```bash
# 1. Edit the default config file
vim config.yml

# 2. (Recommended) Create a local override file
cp config.yml config.local.yml
# Edit config.local.yml — keep only the fields you want to override

# 3. Run
bun run dev
```

> **Tip**: `config.yml` is the shared base configuration (committed to git). `config.local.yml` is for personal local overrides (gitignored).

### Option 2: Environment Variables Only

```bash
cp .env.example .env
# Edit .env with your API keys
bun run dev
```

Even in this mode, a `config.yml` file provides the structure; env vars are injected via `${VAR}` placeholders.

## Config File Structure

### Full `config.yml` Reference

```yaml
llm:
  # Provider configurations — each key becomes a provider name.
  # Referenced in default/tiers as "providerName/modelName".
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      baseURL: ${OPENAI_BASE_URL:-}

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      baseURL: ${ANTHROPIC_BASE_URL:-}

    # OpenAI-compatible providers (Ollama, LM Studio, ZAI, etc.)
    ollama:
      type: openai          # treat as OpenAI-compatible
      apiKey: dummy
      baseURL: ${OLLAMA_BASE_URL:-http://localhost:11434/v1}

  # Default model — used for MainAgent and as fallback for all tiers.
  # Format: "provider/model" string or object { model, contextWindow?, apiType? }
  default: openai/gpt-4o-mini

  # Tier overrides (all optional — fall back to default)
  # Tiers are capability levels: fast (cheap), balanced (general), powerful (complex).
  tiers:
    fast:                           # compact, reflection, extract, explore subagent
    balanced:                       # general/plan subagents
    powerful:                       # complex reasoning (future use)

  maxConcurrentCalls: 3   # max parallel LLM requests
  timeout: 120            # per-request timeout in seconds

  # Context window size (tokens). Auto-detected from model if omitted.
  # Override when using providers with different context limits.
  contextWindow:

agent:
  maxActiveTasks: 5
  maxConcurrentTools: 3
  maxCognitiveIterations: 100
  heartbeatInterval: 60   # seconds
  taskTimeout: 300        # seconds — max wait for task completion

identity:
  personaPath: data/personas/default.json

tools:
  timeout: 60                     # tool execution timeout in seconds
  allowedPaths: []                # restrict file operations (empty = no restriction)
  webSearch:
    provider: tavily              # tavily | google | bing | duckduckgo
    apiKey: ${WEB_SEARCH_API_KEY}
    maxResults: 10
  mcpServers: []                  # MCP server configurations

session:
  compactThreshold: 0.8  # fraction of context window that triggers compaction (0.1–1.0)

system:
  logLevel: info          # debug | info | warn | error | silent
  homeDir: ~/.pegasus     # root directory for all runtime data
  logFormat: json         # json | line
```

## Config File Resolution

Pegasus uses a **layered config** strategy:

1. **`PEGASUS_CONFIG` env var** — if set, loads that file exclusively.
2. **`config.yml`** (base) → deep-merged with **`config.local.yml`** (local override).
3. **`config.yaml`** → **`config.local.yaml`** (alternate extensions, same behavior).
4. If no config file is found, hardcoded defaults are used.

> **Recommended**: Use the `.yml` extension (the project default).

**Conflict detection**: You cannot have both `config.yml` and `config.yaml` (or both `config.local.yml` and `config.local.yaml`). If both exist, the loader throws an error.

```bash
# ERROR — conflicting files
$ ls config*
config.yaml  config.yml    # conflict!

# OK — recommended
$ ls config*
config.yml  config.local.yml

# OK — alternate extension
$ ls config*
config.yaml  config.local.yaml
```

### Loading Flow

```
Hardcoded Defaults (DEFAULT_CONFIG)
        │
        ▼
   Deep-merge with config.yml  (env var interpolation applied)
        │
        ▼
   Deep-merge with config.local.yml  (env var interpolation applied)
        │
        ▼
   Map YAML shape → flat Settings shape
        │
        ▼
   Zod schema validation
        │
        ▼
   Settings object
```

### Deep Merge Example

**config.yml** (base):
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
  default: openai/gpt-4o-mini
  timeout: 120
```

**config.local.yml** (local override):
```yaml
llm:
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
  default: anthropic/claude-sonnet-4-20250514
  tiers:
    fast: openai/gpt-4o-mini
  timeout: 180
```

**Effective config**:
```yaml
llm:
  providers:
    openai:                                    # ← from base (preserved)
      apiKey: ${OPENAI_API_KEY}
    anthropic:                                 # ← from local (added)
      apiKey: ${ANTHROPIC_API_KEY}
  default: anthropic/claude-sonnet-4-20250514  # ← from local (overridden)
  tiers:
    fast: openai/gpt-4o-mini                   # ← from local (added)
  timeout: 180                                 # ← from local (overridden)
```

## Environment Variable Interpolation

Config files support `${VAR_NAME}` placeholders with bash-style default value syntax:

### Syntax Reference

| Syntax | Behavior |
|--------|----------|
| `${VAR}` | Substitute the value of `VAR` (empty string if unset) |
| `${VAR:-default}` | Use `default` if `VAR` is unset or empty |
| `${VAR:=default}` | Use `default` and assign it to `VAR` if unset or empty |
| `${VAR:?error msg}` | Throw an error with `error msg` if `VAR` is unset or empty |
| `${VAR:+alternate}` | Use `alternate` only if `VAR` is set; empty otherwise |

### Examples

```yaml
llm:
  providers:
    openai:
      # Required — error if not set
      apiKey: ${OPENAI_API_KEY:?OpenAI API key is required}
      # Optional with default
      model: ${OPENAI_MODEL:-gpt-4o-mini}
      # Conditional proxy — only set when USE_PROXY env var exists
      baseURL: ${USE_PROXY:+https://proxy.example.com/v1}

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}

  default: ${LLM_DEFAULT_MODEL:-openai/gpt-4o-mini}

system:
  logLevel: ${PEGASUS_LOG_LEVEL:-info}
```

### Benefits

- Config files can be committed to git (no secrets hardcoded).
- Sensitive values are injected via environment variables or `.env` files.
- Reasonable defaults for development; required checks for production.

## Configuration Priority

From highest to lowest:

1. **`config.local.yml`** — local overrides (not committed to git)
2. **`config.yml`** — base configuration (committed to git)
3. **Hardcoded defaults** — safe fallback values defined in the schema

> **Note**: Environment variables are not a separate priority layer. They are resolved _during_ YAML interpolation via `${VAR}` placeholders. The final YAML values (after interpolation) are what get validated by Zod. There are no hardcoded env var names in the loader — all env var names are user-defined in the YAML files. The sole exception is `PEGASUS_CONFIG` (custom config path).

## Complete Settings Reference

### LLM (`llm`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `llm.providers` | map | `{}` | Map of provider name → provider config |
| `llm.providers.<name>.type` | `"openai"` \| `"anthropic"` | auto-detected from key | SDK to use for this provider |
| `llm.providers.<name>.apiKey` | string | — | API key (supports interpolation) |
| `llm.providers.<name>.baseURL` | string | — | Custom API endpoint |
| `llm.default` | string \| object | `"openai/gpt-4o-mini"` | **Required.** Default model for MainAgent and fallback for all tiers. String `"provider/model"` or object `{ model, contextWindow?, apiType? }` |
| `llm.tiers` | object | `{}` | Maps tier names to model specs |
| `llm.tiers.fast` | string \| object | — | Model for cheap/fast tasks: compact, reflection, extract, explore (falls back to default) |
| `llm.tiers.balanced` | string \| object | — | Model for general subagent tasks (falls back to default) |
| `llm.tiers.powerful` | string \| object | — | Model for complex reasoning tasks (falls back to default) |
| `llm.maxConcurrentCalls` | number | `3` | Max parallel LLM requests |
| `llm.timeout` | number | `120` | Per-request timeout in seconds |
| `llm.contextWindow` | number | — | Context window size in tokens (auto-detected if omitted) |

#### Provider Type Detection

The `type` field tells Pegasus which SDK to use. If omitted, the provider name itself is used:

- Key `openai` → OpenAI SDK
- Key `anthropic` → Anthropic SDK
- Any other key → must set `type: openai` or `type: anthropic` explicitly

This allows you to define multiple OpenAI-compatible providers:

```yaml
llm:
  providers:
    ollama:
      type: openai
      apiKey: dummy
      baseURL: http://localhost:11434/v1
    zai:
      type: openai
      apiKey: ${ZAI_API_KEY}
      baseURL: https://api.z.ai/api/coding/paas/v4
```

#### Tier-Based Model Selection

Tiers decouple _what capability level_ a task needs from _which model_ provides it. Each tier can point to a different provider/model combination:

```yaml
llm:
  default: anthropic/claude-sonnet-4-20250514   # MainAgent + fallback for all tiers
  tiers:
    fast: openai/gpt-4o-mini                    # compact, reflection, extract, explore
    balanced: openai/gpt-4o                     # general/plan subagents
    powerful: anthropic/claude-opus-4            # complex reasoning
```

If a tier is not set, it falls back to `default`. Subagents declare their preferred tier in their SUBAGENT.md `model` field (see [Task Types](./task-types.md)).

For the full design, see [Tier-Based Model Selection](./multi-model.md).

### Agent (`agent`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent.maxActiveTasks` | number | `5` | Maximum concurrent active tasks |
| `agent.maxConcurrentTools` | number | `3` | Maximum parallel tool executions |
| `agent.maxCognitiveIterations` | number | `100` | Max cognitive loop iterations per cycle |
| `agent.heartbeatInterval` | number | `60` | Heartbeat interval in seconds |
| `agent.taskTimeout` | number | `120` | Max wait time for task completion in seconds |

### Identity (`identity`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `identity.personaPath` | string | `"data/personas/default.json"` | Path to the persona definition file |

### Tools (`tools`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tools.timeout` | number | `30` | Tool execution timeout in seconds |
| `tools.allowedPaths` | string[] | `[]` | Allowed paths for file operations (empty = unrestricted) |
| `tools.webSearch.provider` | string | — | Search provider: `tavily`, `google`, `bing`, `duckduckgo` |
| `tools.webSearch.apiKey` | string | — | API key for the search provider |
| `tools.webSearch.maxResults` | number | `10` | Max search results to return |
| `tools.mcpServers` | array | `[]` | MCP server configurations (`name`, `url`, `enabled`) |

### Session (`session`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `session.compactThreshold` | number | `0.8` | Fraction of context window usage that triggers compaction (0.1–1.0) |

### System (`system`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `system.logLevel` | string | `"info"` | Log level: `debug`, `info`, `warn`, `error`, `silent` |
| `system.homeDir` | string | `"~/.pegasus"` | Root directory for all runtime data (logs, memory, sessions, etc.) |
| `system.logFormat` | string | `"json"` | Log output format: `json` (structured) or `line` (human-readable) |

> **Note on `homeDir`**: Memory storage is derived from `homeDir` (at `{homeDir}/agents/main/memory/`). There is no separate `memory.dataDir` setting.

## Logging

Pegasus writes logs exclusively to files — there is no console output.

- **Log file**: `{homeDir}/logs/pegasus.log`
- **Daily rotation**: new file each day (`pegasus.log.YYYY-MM-DD`)
- **Size rotation**: rotated when file exceeds 10 MB
- **Auto-cleanup**: logs older than 30 days are deleted
- **Auto-create**: log directory is created automatically if missing

### Log Formats

| Format | Description |
|--------|-------------|
| `json` (default) | Structured JSON lines — machine-parseable, suitable for log aggregation |
| `line` | Human-readable single lines: `2026-02-24T10:00:00.000Z INFO  [module] message key=value` |

### Viewing Logs

```bash
# Follow log output in real time
tail -f ~/.pegasus/logs/pegasus.log

# For human-readable output, set logFormat: line in config.yml
```

For more details, see the [Logging documentation](./logging.md).

## Configuration Examples

### Example 1: Multi-Provider Development

**config.yml** (shared, committed to git):
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    ollama:
      type: openai
      apiKey: dummy
      baseURL: http://localhost:11434/v1

  default: openai/gpt-4o-mini
  tiers:
    fast: openai/gpt-4o-mini

system:
  logLevel: info
  homeDir: ~/.pegasus
```

**config.local.yml** (personal, not committed):
```yaml
llm:
  default: ollama/llama3.2:latest
```

### Example 2: Production

```yaml
llm:
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
  default: anthropic/claude-sonnet-4-20250514
  maxConcurrentCalls: 10
  timeout: 180

agent:
  maxActiveTasks: 20
  maxConcurrentTools: 5
  taskTimeout: 600

system:
  logLevel: warn
  homeDir: /var/lib/pegasus
  logFormat: json
```

### Example 3: Local Ollama Development

**config.local.yml**:
```yaml
llm:
  providers:
    ollama:
      type: openai
      apiKey: dummy
      baseURL: http://localhost:11434/v1
  default: ollama/qwen2.5:latest

system:
  logLevel: debug
  homeDir: ~/.pegasus
  logFormat: line
```

### Example 4: Tier-Based Model Split

```yaml
llm:
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    openai:
      apiKey: ${OPENAI_API_KEY}

  default: anthropic/claude-sonnet-4-20250514   # strong model for MainAgent
  tiers:
    fast: openai/gpt-4o-mini                    # cheap model for compact/reflection
    balanced: openai/gpt-4o                     # mid-tier for subagents
    powerful: anthropic/claude-sonnet-4-20250514 # strong model for complex tasks

  contextWindow: 200000  # explicit override

system:
  homeDir: ~/.pegasus
```

## Security Best Practices

### Recommended

Separate secrets from structure using env var interpolation:

**config.yml** (committed to git — no secrets):
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}  # reference, not a value
  default: openai/gpt-4o-mini

system:
  homeDir: ~/.pegasus
```

**.env** (gitignored — contains secrets):
```bash
OPENAI_API_KEY=sk-proj-actual-key-here
```

### Not Recommended

```yaml
# Do NOT hardcode API keys in config files
llm:
  providers:
    openai:
      apiKey: sk-proj-hardcoded-key  # AVOID — will leak if committed
```

## Advanced Usage

### Custom Config Path

```bash
export PEGASUS_CONFIG=/etc/pegasus/config.yml
bun run dev
```

### Team Collaboration

1. Commit `config.yml` to git (shared base configuration).
2. Each member creates their own `config.local.yml` (personal overrides).
3. Keep `config.local.yml` and `.env` out of git.

**.gitignore**:
```
config.local.yml
config.local.yaml
.env
.env.local
```

### Debugging Configuration

```bash
# Set log level to debug to see config loading details
# In config.yml or config.local.yml:
#   system:
#     logLevel: debug

# The log will show:
# INFO: loading_base_config path=config.yml
# INFO: loading_local_config_override path=config.local.yml
# INFO: merging_base_and_local_configs
```

## References

- [Default config file](../config.yml)
- [Config schema definition](../src/infra/config-schema.ts)
- [Config loader implementation](../src/infra/config-loader.ts)
