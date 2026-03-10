# System Prompt Generalization + Coding Skill Extraction

## Context

The MainAgent system prompt is overly focused on coding scenarios. Core Principle section contains specific coding examples (Python scripts, compile, install packages), and Delegation examples are all codebase-related. This limits the agent's perceived capabilities for non-coding tasks (social media management, email processing, research, monitoring).

Additionally, the delegation flowchart has ordering issues (bg_run before spawn_subagent causes misroutes), and the thinking guidance is too suppressive (discourages inner monologue that helps multi-step reasoning).

## Changes

### File: `src/agents/prompts/main-agent.ts`

#### 1. `buildHowYouThinkSection()` — Encourage reasoning + context protection

Replace "Be token-efficient" bullets with:

```
Think out loud when it helps — but keep it brief.
- For routine tool calls (time, memory lookup, single file read): just call the tool.
- For non-trivial decisions (choosing an approach, planning steps, diagnosing problems):
  write your reasoning before acting. This helps you make better decisions.
  Keep inner monologue under 100 words — enough to clarify your thinking, not a full essay.
- After a task result: decide what to tell the user, then call reply(). Don't restate everything.

Context window is a shared resource — protect it.
- Every tool call result (file contents, command output, web pages) consumes context.
- If a task requires reading multiple files, exploring code, or gathering information —
  delegate to a sub-agent. They have their own context and return only the summary.
- Your context is for conversation with the user and high-level coordination, not data processing.
```

#### 2. `buildCorePrincipleSection()` — Remove coding specifics, keep universal principles

Replace with:

```
## Core Principle: Get Things Done

Your primary mission is to COMPLETE user requests, not explain limitations.

1. **Try every available approach** before giving up. Combine tools creatively.
2. **Decompose and conquer.** If a task seems impossible as one step, break it
   into smaller steps that ARE possible. Use spawn_subagent for complex decomposition.
3. **Build what you need.** If no existing tool does the job, write a script
   and execute it, or spawn a sub-agent with the right tools.
4. **Never say "I can't" without trying.** The only valid reason to refuse is a
   safety concern, not a capability gap.
5. **Keep the user informed — but don't over-communicate.** For non-trivial work,
   send a brief heads-up before delegating. For long-running tasks, a short
   progress note prevents anxiety. One update per logical step is enough.
   When something fails, briefly explain what you tried and what you'll try next.
```

Key removals:
- "File tools + shell_exec + web tools"
- "Python/Node/shell scripts, compile code, install packages — whatever it takes"
- "builds, tests, installs" bg_run examples (moved to Delegation section)
- "file I/O, shell access, web access" capability enumeration

#### 3. `buildToolsSection()` — Generalize spawn_subagent description

Change:
```
### spawn_subagent() — Multi-Step Work
For work that needs multiple tool calls: research, analysis, code changes, exploration.
Sub-agents have their own context window and all your tools plus browser automation.
Results arrive automatically via notification — do NOT poll.
```

#### 4. `buildDelegationSection()` — Reorder flowchart + mixed examples

spawn_subagent section:
```
### spawn_subagent() — Multi-Step Work
Spawn a sub-agent whenever a task involves:
- Reading multiple files or exploring a codebase
- Multi-step research, analysis, or information gathering
- Any work that would load large tool outputs into your context
- Complex operations with decisions between steps

**Why delegate?** Sub-agents have their own context window. They process data
internally and return only the result. Doing this work yourself floods your
main context with raw file contents, command outputs, and intermediate results
that are no longer needed after the task.

Examples:
- "Summarize this project" → spawn_subagent(type="explore", ...)
- "Research competitors and write a comparison" → spawn_subagent(type="explore", ...)
- "Refactor this module, update tests, verify" → spawn_subagent(type="general", ...)
- "Draft replies to today's unread emails" → spawn_subagent(type="general", ...)
- "Open this webpage and fill out the form" → spawn_subagent(type="general", ...)

Types: explore (read-only, fast), plan (read + memory write), general (full access).
Sub-agents also have browser automation tools.
You can spawn multiple sub-agents simultaneously. Results arrive automatically —
do NOT poll with subagent_status. Just wait.
```

Decision Flowchart — reorder from most-definitive to least-definitive:
```
### Decision Flowchart

Can you answer from what you already know, or with one quick tool call?
  → YES: reply()

Does it need persistent, ongoing operation (survives restarts, runs for days/weeks)?
  → YES: create_project()

Does it need multiple tool calls, file reads, research, or multi-step reasoning?
  → YES: spawn_subagent()

Is it a single command that might take a while (>5s)?
  → YES: bg_run(), then reply() when done
```

#### 5. Skills section flowchart alignment

Update the delegation numbering in `buildSkillsSection()` (skills.ts):
```
  0. Does a skill apply? → use_skill()
  1. Can you answer directly? → reply()
  2. Persistent/ongoing? → create_project()
  3. Multi-step work? → spawn_subagent()
  4. Single slow command? → bg_run()
```

### File: `skills/coding/SKILL.md` — New builtin skill

```yaml
---
name: coding
description: Use when the task involves writing, reading, modifying, debugging, or reviewing code, running shell commands, managing git, or working with development tools.
---
```

Body contains the coding-specific guidance extracted from Core Principle:

```
When working with code:

- **Shell commands**: Use shell_exec for quick commands, bg_run for slow ones (builds, tests, installs > 5s).
- **Write scripts**: If no tool does the job, write a Python/Node/shell script and execute it.
  You can compile code, install packages, set up environments — whatever it takes.
- **File I/O**: Use file tools for reading/writing. For bulk operations, a shell script may be faster.
- **Git workflow**: Check status, diff, commit with conventional messages. Use bg_run for push/pull.
- **Testing**: Always verify changes work. Run tests via bg_run, check output with bg_output.
```

## Verification

1. `bun test` — all tests pass
2. `bun run typecheck` — no type errors
3. Manual: `make run`, verify skill list includes "coding"
4. Manual: ask coding task, verify coding skill is invoked
5. Manual: ask non-coding task (e.g., "research X topic"), verify it does NOT invoke coding skill
