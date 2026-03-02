# Tier-Based Model Selection

## Why

Users shouldn't need to understand Pegasus's internal roles (compact, reflection, AITask). Those are implementation details. Instead, the config exposes **tiers** — semantic capability levels that map to how powerful a model you want for each class of work:

| Tier | Intent | Typical use |
|------|--------|-------------|
| `fast` | Cheapest/fastest | Compaction, reflection, extract, explore task |
| `balanced` | Good all-rounder | General/plan tasks, default task model |
| `powerful` | Strongest available | Complex reasoning, future use |

A single `default` model covers the MainAgent and acts as the fallback for any tier that isn't explicitly configured. This means a minimal config only needs one line.

## Config Structure

```yaml
llm:
  # ── Default model (required) ──
  # Used for MainAgent conversation and as fallback for all tiers.
  default: anthropic/claude-sonnet-4

  # ── Tier overrides (all optional) ──
  tiers:
    fast: openai/gpt-4o-mini        # compact, reflection, extract, explore
    balanced: openai/gpt-4o         # general/plan tasks
    powerful: anthropic/claude-opus-4 # complex reasoning

  # ── Provider credentials ──
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
```

Each tier value can be a shorthand string (`"provider/model"`) or an object for advanced overrides:

```yaml
tiers:
  fast:
    model: openai/gpt-4o-mini
    contextWindow: 128000       # override auto-detection
    apiType: openai             # force SDK type (rare)
```

## Tier Resolution

When the system needs a model, resolution follows this chain:

```
AITASK.md `model` field   (e.g. "fast" or "openai/gpt-4o")
        ↓ (if set)
  contains "/"? → direct model spec → create/cache
  no "/"?       → treat as tier name
        ↓
  tiers[tierName]  (e.g. tiers.fast = "openai/gpt-4o-mini")
        ↓ (if not set)
  default          (e.g. "anthropic/claude-sonnet-4")
        ↓
  providers[providerName]  → credentials + baseURL
        ↓
  create LanguageModel instance (cached by spec)
```

Same `provider/model` string always returns the same cached instance.

## Internal Tier Mapping

Internal tasks map to tiers automatically — users don't configure these individually:

| Internal task | Tier used | Rationale |
|--------------|-----------|-----------|
| MainAgent (`_think`) | `default` | Primary conversation model |
| Compact (`_generateSummary`) | `fast` | Summarization is simple, cost-sensitive |
| Reflection (post-task) | `fast` | Fire-and-forget memory extraction |
| Extract (memory index) | `fast` | Cheap factual extraction |
| AITask (explore) | AITASK.md `model` field → `fast` | Read-only research |
| AITask (general) | AITASK.md `model` field → `balanced` | Full-capability worker |
| AITask (plan) | AITASK.md `model` field → `balanced` | Analysis and planning |

## ModelRegistry API

```typescript
type ModelTier = "fast" | "balanced" | "powerful";

class ModelRegistry {
  /** MainAgent model (from llm.default). */
  getDefault(): LanguageModel;

  /** Model for a tier. Falls back to default if not configured. */
  getForTier(tier: ModelTier): LanguageModel;

  /**
   * Resolve a model spec or tier name.
   * Contains "/" → direct model spec; otherwise → tier lookup.
   */
  resolve(modelOrTier: string): LanguageModel;

  /** Model ID string for the default model. */
  getDefaultModelId(): string;

  /** Model ID string for a tier. */
  getModelIdForTier(tier: ModelTier): string;

  /** Context window override for the default model. */
  getDefaultContextWindow(): number | undefined;

  /** Context window override for a tier. */
  getContextWindowForTier(tier: ModelTier): number | undefined;
}
```

## AITASK.md Model Field

Each AI task type can declare its preferred tier or model in the frontmatter:

```yaml
---
name: explore
description: "Fast, read-only research agent..."
tools: "read_file, list_files, ..."
model: fast                        # tier name → resolved via tiers.fast
---
```

The `model` field accepts:
- **Tier name** (`fast`, `balanced`, `powerful`) — resolved via `ModelRegistry.resolve()`, falls back to `default`
- **Direct model spec** (`openai/gpt-4o`) — used as-is, bypassing tier lookup

If `model` is omitted, the AI task type uses the Agent's default model (the one passed at construction, typically `tiers.balanced` or `default`).

## Config Examples

### Minimal (single model for everything)

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
  default: openai/gpt-4o
```

### Cost-optimized (cheap tiers, strong default)

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
  default: anthropic/claude-sonnet-4
  tiers:
    fast: openai/gpt-4o-mini
    balanced: openai/gpt-4o
```

### Local dev (Ollama for tasks, cloud for MainAgent)

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    ollama:
      type: openai
      apiKey: dummy
      baseURL: http://localhost:11434/v1
  default: openai/gpt-4o
  tiers:
    fast: ollama/llama3.2:latest
    balanced: ollama/llama3.2:latest
```
