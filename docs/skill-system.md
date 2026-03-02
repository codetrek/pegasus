# Skill System Design

## Overview

Prompt-based skill system for Pegasus, modeled after Claude Code's skill architecture. Skills are structured prompt injections that extend agent behavior — not code plugins, but instructions the LLM follows.

## Core Concepts

### What is a Skill?

A skill is a directory containing a `SKILL.md` file with YAML frontmatter (metadata) and markdown body (instructions). When triggered, the skill's instructions are loaded into the LLM's context, and the LLM follows them.

### Skill File Format

```
skill-name/
├── SKILL.md           # Main instructions (required)
├── references/        # Reference material (loaded on demand by LLM)
├── examples/          # Example outputs
└── scripts/           # Executable scripts
```

`SKILL.md` structure:

```yaml
---
name: code-review
description: Use when reviewing code changes or PRs
disable-model-invocation: false
user-invocable: true
allowed-tools: read_file, grep_files
context: inline
agent: general
model: default
argument-hint: "[pr-number]"
---

# Code Review Instructions

Review the code changes focusing on...
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | directory name | Identifier, `/name` for manual invocation. Lowercase + hyphens, max 64 chars |
| `description` | Recommended | first paragraph | LLM uses this to decide when to load the skill |
| `disable-model-invocation` | No | `false` | `true` = only user can invoke via `/name` |
| `user-invocable` | No | `true` | `false` = hidden from `/` menu, only LLM can invoke |
| `allowed-tools` | No | all tools | Comma-separated list of tools available when skill is active |
| `context` | No | `inline` | `inline` = execute in current context; `fork` = spawn_task |
| `agent` | No | `general` | Task type when `context: fork` (future: explore, plan, deepresearch) |
| `model` | No | `default` | ModelRegistry role or `provider/model` spec |
| `argument-hint` | No | none | Autocomplete hint, e.g. `[issue-number]` |

### String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking. If absent, appended as `ARGUMENTS: <value>` |
| `$ARGUMENTS[N]` | Specific argument by 0-based index |
| `$N` | Shorthand for `$ARGUMENTS[N]` |

## Storage & Priority

```
skills/              ← builtin (git tracked, ships with project)
data/skills/         ← user-installed + LLM-created (runtime, gitignored)
```

Priority: `data/skills/` > `skills/` (user overrides builtin).

When skills share the same name, the higher-priority location wins.

## Three-Layer Progressive Disclosure

### Layer 1: Metadata (always in context)

At startup, SkillLoader scans both directories. Each skill's `name + description` is injected into the **system prompt**.

```
Available skills:
- code-review: Use when reviewing code changes or PRs
- commit: Use when committing changes to git
- deploy: Use when deploying to production (manual only)

Use the use_skill tool to invoke a skill when relevant.
```

Budget: **2% of context window** (fallback 16K chars). Skills exceeding the budget are excluded (logged as warning). Skills with `disable-model-invocation: true` are excluded from the list (not visible to LLM).

### Layer 2: SKILL.md body (loaded on trigger)

When triggered (by LLM or user), the full SKILL.md markdown body is loaded:
- `$ARGUMENTS` substitution applied
- Content delivered to LLM (via tool result or user message)

### Layer 3: Supporting files (loaded on demand)

SKILL.md references files like `[reference.md](reference.md)`. The LLM decides whether to read them using `read_file` or similar tools.

## Triggering

### Path 1: LLM Auto-Trigger

LLM sees the skill list in system prompt → decides a skill is relevant → calls `use_skill` tool.

```
use_skill({
  skill: "code-review",
  args: "PR #42"
})
```

`use_skill` tool execution:
1. SkillRegistry looks up skill by name
2. Reads SKILL.md body
3. Applies `$ARGUMENTS` substitution
4. Checks `context` field:
   - `inline` → returns skill content as **tool result** (LLM continues in same context)
   - `fork` → calls `agent.submit(skillContent)` → returns `{ taskId, status: "spawned" }`

### Path 2: User `/` Command

User types `/code-review PR #42`.

Processing flow:
```
User input "/code-review PR #42"
   ↓
CLI layer: is it /help, /exit, /clear? → No → forward to MainAgent
   ↓
MainAgent.send({ text: "/code-review PR #42", channel: ... })
   ↓
MainAgent recognizes / prefix → SkillRegistry.get("code-review")
   ↓
Found → load SKILL.md body → $ARGUMENTS substitution
   ↓
Check context:
  inline → inject as user message: "[Skill: code-review]\n\n<skill content with args>"
  fork   → agent.submit(skillContent) → queue task_notify
   ↓
Not found → treat as normal message (LLM responds "unknown command")
```

### Trigger Control Matrix

| Frontmatter | User can invoke | LLM can invoke | In system prompt |
|-------------|----------------|---------------|-----------------|
| (default) | ✅ | ✅ | ✅ description |
| `disable-model-invocation: true` | ✅ | ❌ | ❌ excluded |
| `user-invocable: false` | ❌ | ✅ | ✅ description |

## `context: fork` Execution

When a skill has `context: fork`, triggering it (by LLM or user) spawns an isolated task:

```
Trigger (LLM or user)
   ↓
Load SKILL.md body → $ARGUMENTS substitution
   ↓
agent.submit(skillContent)
   ↓
Task Agent executes skill content as task input
   - No MainAgent conversation history
   - Task type from `agent` field (future: explore, plan, etc.)
   - Task completes → onNotify → MainAgent receives result
```

This reuses the existing `spawn_task` / `onNotify` infrastructure. The only difference from a normal `spawn_task` is that the task input comes from skill content instead of user text.

## Architecture Components

### SkillLoader

Scans skill directories, parses SKILL.md files (frontmatter + body).

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools?: string[];
  context: "inline" | "fork";
  agent: string;
  model?: string;
  argumentHint?: string;
  bodyPath: string;       // path to SKILL.md for lazy loading
  source: "builtin" | "user";  // which directory it came from
}

class SkillLoader {
  /** Scan directories and return all discovered skills. */
  loadAll(builtinDir: string, userDir: string): SkillDefinition[];

  /** Parse a single SKILL.md file. */
  parse(filePath: string): SkillDefinition;
}
```

### SkillRegistry

Manages discovered skills. Provides lookup and metadata listing.

```typescript
class SkillRegistry {
  /** Register skills from SkillLoader. Handles priority (user > builtin). */
  registerMany(skills: SkillDefinition[]): void;

  /** Get skill by name. Returns null if not found. */
  get(name: string): SkillDefinition | null;

  /** Get metadata list for system prompt injection. Respects budget. */
  getMetadataForPrompt(budgetChars: number): string;

  /** Load skill body content with $ARGUMENTS substitution. */
  loadBody(name: string, args?: string): string;

  /** List all user-invocable skills (for /help or autocomplete). */
  listUserInvocable(): SkillDefinition[];
}
```

### `use_skill` Tool

Registered as a MainAgent tool. LLM calls it to trigger a skill.

```typescript
const use_skill: Tool = {
  name: "use_skill",
  description: "Invoke a skill by name. Use when a task matches an available skill.",
  parameters: z.object({
    skill: z.string().describe("Skill name"),
    args: z.string().optional().describe("Arguments to pass to the skill"),
  }),
  async execute(params, context) {
    const { skill: name, args } = params;
    const skill = skillRegistry.get(name);
    if (!skill) return { success: false, error: `Skill "${name}" not found` };

    const body = skillRegistry.loadBody(name, args);

    if (skill.context === "fork") {
      const taskId = await agent.submit(body);
      return { success: true, result: { taskId, status: "spawned" } };
    }

    // inline: return skill content for LLM to follow
    return { success: true, result: body };
  },
};
```

### Integration Points

| Component | Change |
|-----------|--------|
| `src/skills/loader.ts` | New: scan directories, parse SKILL.md |
| `src/skills/registry.ts` | New: skill management, lookup, metadata |
| `src/tools/builtins/skill-tool.ts` | New: `use_skill` tool |
| `src/tools/builtins/index.ts` | Add `use_skill` to `mainAgentTools` |
| `src/agents/main-agent.ts` | Inject skill metadata into system prompt; handle `/` commands in `send()` |
| `src/agents/agent.ts` | Minor: accept skill-spawned tasks (no change needed — spawn_task already works) |
| `src/identity/prompt.ts` | Add skill metadata section to `buildSystemPrompt` |

### What Does NOT Change

| Component | Why |
|-----------|-----|
| TaskFSM | Tasks from skills use the same FSM |
| EventBus | No new events needed |
| TaskPersister | Skill tasks are normal tasks |
| Memory system | Skills don't interact with memory directly |
| Cognitive pipeline | Reason → Act pipeline unchanged |

## Example Skills

### Builtin: commit-changes

```yaml
---
name: commit
description: Use when committing changes to git with conventional commit format
disable-model-invocation: true
---

Create a git commit following conventional commits:

1. Run `git status` to see changes
2. Run `git diff --staged` to review staged changes
3. Draft commit message: type(scope): description
4. Commit with the message
```

### Builtin: code-review (fork)

```yaml
---
name: code-review
description: Use when reviewing code changes, PRs, or asking for code feedback
context: fork
argument-hint: "[pr-number or branch]"
---

Review code changes for $ARGUMENTS:

1. Get the diff
2. Analyze for bugs, security issues, performance
3. Check test coverage
4. Summarize findings with specific file/line references
```

### LLM-Created: project-conventions

```yaml
---
name: project-conventions
description: Coding conventions for this project. Use when writing new code.
user-invocable: false
---

# Project Conventions

- Runtime: Bun (not Node)
- Test framework: bun:test
- All docs in English
- Commit messages: conventional commits
- Coverage threshold: 95% per file
```
