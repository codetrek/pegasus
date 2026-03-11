# Context Budget — Token Management & Compaction

> Source code: `src/context/`

## Overview

Pegasus manages the LLM context window to prevent overflow and maintain conversation quality. The `src/context/` module provides: token budget computation, compaction triggering, tool result truncation, overflow recovery, and chunked summarization.

## Token Budget

`computeTokenBudget()` resolves how many tokens are available for input and when compaction should trigger.

### Resolution Priority

1. **Config override** — `llm.contextWindow` in config.yml (highest priority)
2. **Provider cache** — limits fetched from Copilot/OpenRouter APIs at startup
3. **Static registry** — built-in table of 150+ model context window sizes
4. **Default** — 128,000 tokens context window, 16,000 max output

### Budget Fields

| Field | Description |
|-------|-------------|
| `contextWindow` | Total context window for the model |
| `maxOutputTokens` | Max tokens the model can generate |
| `maxInputTokens` | Max tokens available for input (provider limit) |
| `effectiveInputBudget` | Input budget after safety margin (÷ 1.2) |
| `compactTrigger` | Token count that triggers compaction |

### Safety Margin

Token estimation uses a `chars / 3.5` heuristic which underestimates for code, JSON, and multibyte characters. A 1.2× safety margin compensates:

```
effectiveInputBudget = floor(maxInputTokens / 1.2)
```

## Compaction

When estimated token usage exceeds `compactTrigger`, the agent summarizes the conversation history and archives the full session.

### Thresholds

| Agent Type | Threshold | Effect |
|------------|-----------|--------|
| MainAgent | 0.8 (configurable via `session.compactThreshold`) | Compact at 80% of effective budget |
| Subagent tasks | 0.7 (hardcoded) | More aggressive — tasks have shorter lifetimes |

### Compact Flow

```
Agent.checkCompaction()
    │
    │  estimatedTokens > compactTrigger?
    ▼
Agent._compactState()
    │
    ├── summarizeMessages() → LLM call to produce summary
    │
    ├── SessionStore.compact() → rename current.jsonl to timestamp.jsonl
    │                          → write new current.jsonl with summary
    │
    └── Replace session messages with compact summary message
```

The compact summary is injected as a `[Session compacted]` message, preserving key decisions and context.

## Tool Result Truncation

Large tool results (file reads, web fetches) can consume a disproportionate share of the context window. The tool result guard prevents this.

### Size Calculation

```
maxChars = floor(contextWindow × share × charsPerToken)
         = floor(contextWindow × 0.25 × 3.5)
```

Capped at 400,000 characters hard maximum. At least 2,000 characters are always preserved.

### Truncation Behavior

- Attempts to cut at a newline boundary (no partial lines)
- Appends a truncation notice suggesting more specific queries
- Applied both proactively (before LLM call) and reactively (batch truncation on message arrays)

## Overflow Recovery

If the LLM returns a context overflow error despite budget checks, the agent attempts automatic recovery:

1. **Detect** — `isContextOverflowError()` pattern-matches error messages (English + Chinese patterns)
2. **Exclude rate limits** — rate-limit errors (429, "tokens per minute") are not treated as overflow
3. **Emergency compact** — calls `_compactState()` to shrink the conversation
4. **Retry** — up to 2 compaction retries per overflow sequence

## Summarization

When conversation history exceeds the summarization model's own context window, the summarizer auto-chunks:

1. **Serialize** — convert messages to `[role]: content` plain text (max 2,000 chars per message)
2. **Single-pass** — if serialized text fits in budget, summarize directly
3. **Chunk** — split into chunks that each fit within the model's budget
4. **Summarize each chunk** independently
5. **Merge** — combine partial summaries; if combined exceeds budget, recursively batch (max depth 3)

## Session Archives

When compaction occurs, the full conversation history is preserved:

```
~/.pegasus/agents/main/session/
├── current.jsonl                    ← active session (starts with compact summary)
├── 2026-03-10T14-30-00.jsonl       ← archived session
├── 2026-03-09T09-15-22.jsonl       ← older archive
└── ...
```

Each archived session is a complete JSONL file of the pre-compaction conversation. The new `current.jsonl` starts with a compact summary entry that references the archive filename, enabling the agent to read previous context via the `session_archive_read` tool.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `CONTEXT_WINDOW_HARD_MIN_TOKENS` | 16,000 | Minimum context window — refuse to run below this |
| `DEFAULT_CONTEXT_WINDOW` | 128,000 | Fallback when model is unknown |
| `DEFAULT_MAX_OUTPUT_TOKENS` | 16,000 | Default output reserve |
| `TOKEN_ESTIMATION_SAFETY_MARGIN` | 1.2 | Compensates for estimation inaccuracy |
| `DEFAULT_COMPACT_THRESHOLD` | 0.8 | MainAgent compact trigger |
| `TASK_COMPACT_THRESHOLD` | 0.7 | Subagent task compact trigger |
| `MAX_TOOL_RESULT_CONTEXT_SHARE` | 0.25 | Max fraction of context for one tool result |
| `HARD_MAX_TOOL_RESULT_CHARS` | 400,000 | Absolute max chars for a tool result |
| `MAX_OVERFLOW_COMPACT_RETRIES` | 2 | Emergency compaction retry limit |
| `CHARS_PER_TOKEN` | 3.5 | Token estimation ratio |
