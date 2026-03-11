# SubAgent Types (Task Specialization)

> Source code: `src/agents/subagents/`, `subagents/*/SUBAGENT.md`

## Core Idea

Not every background task needs the same tools or instructions. A web search should not have write_file. A planning task should not be calling web_search. AITask Types let the MainAgent spawn **specialized tasks** with per-type tool sets and system prompts.

AITask types are defined as **files** (SUBAGENT.md), not hardcoded. Users can add custom task types by creating files in `~/.pegasus/subagents/`.

## File Format

Each task type is a directory containing `SUBAGENT.md` with YAML frontmatter + markdown body:

```
subagents/
  general/SUBAGENT.md    # builtin, git tracked
  explore/SUBAGENT.md
  plan/SUBAGENT.md
~/.pegasus/subagents/           # user-created, runtime (overrides builtin)
  deepresearch/SUBAGENT.md
```

```yaml
---
name: explore
description: "Fast, read-only research agent. Use when you need to search, read, or gather information."
tools: "read_file, list_files, web_search, notify, ..."
model: fast              # optional: tier name or "provider/model"
---

## Your Role
You are a research assistant...

## Rules
1. READ ONLY: ...
```

Frontmatter fields:
- `name`: task type name (must match directory name)
- `description`: injected into MainAgent system prompt to help LLM choose the right type
- `tools`: comma-separated tool names, or `"*"` for all task tools
- `model`: _(optional)_ tier name (`fast`, `balanced`, `powerful`) or direct model spec (`openai/gpt-4o`). Resolved via `ModelRegistry.resolve()`. If omitted, the subagent uses the Agent's default model.

Body: the system prompt appended to the base persona prompt when this task type runs.

## Why

Today, every spawned task gets the full `allTaskTools` array (26+ tools) and a generic "background task worker" system prompt. This causes problems:

1. **Tool overload**: LLM sees 26 tools and sometimes picks wrong ones (e.g., writing files when asked to "explore" a topic)
2. **No specialization**: The system prompt says "you are a background task worker" for every task, no matter the intent
3. **Safety gap**: An "explore" task has write_file — unnecessary risk
4. **Skill integration gap**: `SkillDefinition.agent` field exists but is unused — designed for routing skills to specific task types

## Task Types

| Type | Purpose | Tools | System Prompt Focus |
|------|---------|-------|---------------------|
| `general` | Default, full capabilities | All task tools | Current "background task worker" prompt |
| `explore` | Read-only research, web search, information gathering | Read-only subset | "Gather information, summarize findings, do NOT modify anything" |
| `plan` | Analyze and produce a written plan | Read-only + write to memory | "Analyze the problem, produce a structured plan" |

### Tool Sets

**general** (default — all task tools, unchanged):
- system: current_time, sleep
- file: read_file, write_file, list_files, edit_file, grep_files, glob_files
- network: web_search
- data: base64_encode, base64_decode
- memory: memory_list, memory_read, memory_write, memory_patch, memory_append
- task: task_list, task_replay
- notify

**explore** (read-only — no write, no mutation):
- system: current_time
- file: read_file, list_files, glob_files, grep_files
- network: web_search
- data: base64_decode
- memory: memory_list, memory_read
- task: task_list, task_replay
- notify

**plan** (read-only + write to memory):
- system: current_time
- file: read_file, list_files, glob_files, grep_files
- network: web_search
- data: base64_decode
- memory: memory_list, memory_read, memory_write, memory_append
- task: task_list, task_replay
- notify

> **Note on http_request**: Excluded from explore and plan because it supports arbitrary HTTP methods (POST, PUT, DELETE), which violates the read-only contract. Only `web_search` is included.

### System Prompts

Each subagent type gets a specialized system prompt from its SUBAGENT.md body. The prompt is source code — see `subagents/*/SUBAGENT.md` for the actual content of each type (general, explore, plan).

## Design Decisions

### 1. `spawn_subagent` gets a `type` parameter

MainAgent's LLM uses `spawn_subagent(type, description, input)` to specify the subagent type. The type defaults to `"general"` for backward compatibility.

The MainAgent system prompt explains when to use each type:
```
- spawn_subagent(type: "explore"): research, web search, code reading, information gathering (read-only)
- spawn_subagent(type: "plan"): analyze a problem, produce a structured plan (read + write plans)
- spawn_subagent(type: "general"): full capabilities — file I/O, code changes, multi-step work
```

### 2. Type flows through agent creation

The subagent type determines which tools and system prompt the agent receives.
Agent reads the type to select tools and system prompt at each cognitive iteration.

### 3. Tool restriction is two-layer defense

**LLM visibility layer** (primary): The per-type ToolRegistry determines which tools the LLM sees in its function calling schema. If the LLM never sees `write_file`, it cannot generate a `write_file` tool call.

**Execution layer** (safety net): Before executing a tool call in `_runAct`, Agent validates the tool name against the task's type-specific allowed tool list. A disallowed tool call returns an error result (not an exception) — this guards against prompt injection or LLM hallucination.

### 4. Prompt and tool registry selection

The subagent type determines both the system prompt (from SUBAGENT.md body) and the tool registry. Agent selects the appropriate tool set at creation time based on the type.

Thinker's `run()` method accepts an optional `toolRegistry` parameter that overrides the instance default. This keeps Thinker stateless — the same instance serves all task types.

### 6. Skill system integration

`SkillDefinition.agent` maps to `TaskType`. When a fork skill is spawned, its `agent` field determines the task type (defaulting to `"general"`). This connects the existing skill metadata to the new type system.

### 7. Persistence and backward compatibility

`taskType` is stored in the `TASK_CREATED` event data alongside `inputText`, `source`, and `inputMetadata`. On replay, `taskType` is restored. Old JSONL files without `taskType` default to `"general"`.

## Data Flow

```
User: "search for the latest AI papers"
  ↓
MainAgent LLM decides: spawn_subagent(type="explore", input="...")
  ↓
MainAgent creates a new Agent with type="explore"
  ↓
Agent configured with:
  → explore-specific ToolRegistry (read-only tools)
  → explore-specific system prompt from SUBAGENT.md
  → LLM sees explore-specific tools + explore-specific prompt
  ↓
Agent executes with restricted tools and specialized instructions
  → validates tool calls against explore allowed list
  → executes approved tools, rejects disallowed ones
```

## Future Extensions

- **deepresearch**: Higher iteration limit, larger response budget, multi-source synthesis
- **code**: Code generation/modification specialist, potentially with LSP integration
- **Custom types**: User-defined task types via configuration (tool list + prompt template)
