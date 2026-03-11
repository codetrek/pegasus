# M2: Memory System Design

> Status: **✅ Completed** (PR #17, #18)
> Date: 2026-02-25

## 1. Core Philosophy

**Long-term memory** — not conversation history storage, but remembering **meaningful, important things**.

Like a human: does not memorize every word verbatim, but remembers key facts and significant experiences.

### What This Is NOT

- NOT a conversation window / sliding-window manager
- NOT a vector database or embedding search
- NOT a token-counting context compressor

## 2. Memory Content: Facts + Episodes

Two complementary types of memory, combined:

| Type | What It Captures | Example |
|------|-----------------|---------|
| **Facts** | Persistent truths about the user and accumulated knowledge | "User prefers Chinese discussion", "Wife's birthday is March 15" |
| **Episodes** | Summaries of significant tasks and their outcomes | "Helped user research flight options to Tokyo, found Spring Airlines cheapest" |

### Why Both?

- **Facts alone** lose context — knowing a preference without knowing why it matters.
- **Episodes alone** are hard to query — searching through stories for a simple fact is wasteful.
- **Combined**: facts for quick lookups, episodes for reasoning and learning from experience.

## 3. Storage: Pure Markdown Files

**Zero external dependencies.** No SQLite, no ChromaDB, no vector DB.

### Directory Layout

```
data/agents/main/memory/
├── facts/
│   ├── user.md      # User: identity, preferences, social relationships, important dates
│   └── memory.md    # Experience: accumulated insights, patterns, non-obvious knowledge
└── episodes/
    ├── 2026-02.md   # Experience summaries for Feb 2026
    └── 2026-03.md   # Organized by month
```

### Fact File Naming: Fixed Categories

Fact files use a **closed set** of two predefined names. The LLM cannot create
arbitrary fact files — it may only write to the categories listed above.

| File | What it captures | Example content |
|------|-----------------|-----------------|
| `user.md` | About the **person**: identity, preferences, social relationships, important dates, recurring habits | Name, language, wife's birthday Mar 15, weekly standup with 老王 Wed 10am |
| `memory.md` | About **experience**: insights accumulated from interactions, patterns learned, non-obvious knowledge | User prefers seeing options before deciding; Tavily search API has 1000/day limit |

**Why only two files?** Pegasus is a **general-purpose autonomous agent**, not a
coding assistant or project tool. It may help users with research, scheduling,
conversation, or any other task. Two categories — **person** (who) and
**experience** (what was learned) — are the most stable classification
dimensions regardless of usage scenario. More categories lead to classification
ambiguity and LLMs creating files that don't fit.

**Why fixed names?** Free-form naming leads to LLMs creating files that duplicate
existing information or invent meaningless categories. Fixed names force the LLM
to decide: "Is this about the user, or about something I learned?"

### Facts Size Budget

Total facts directory must stay under **15KB** (~4-5K tokens when injected into
reflector context). All fact files are loaded in full into the reflector's system
prompt, so they must remain highly condensed. If the total approaches the limit,
the reflector should condense existing content before adding new facts.

The `memory_write` tool enforces this limit at the execution layer — writes that
would push facts/ over 15KB are rejected with an error instructing the LLM to
trim existing content first.

### Why Markdown?

- **Human-readable**: open with any editor, review and correct anytime
- **Human-editable**: user can directly add, remove, or fix memories
- **Versionable**: works with git, diffs are meaningful
- **Zero dependencies**: just `fs.readFile` / `fs.writeFile`
- **LLM-native**: LLMs understand markdown natively, no serialization needed

### File Format: Facts

Each fact file also has a file-level `> Summary:` line, same as episodes.

```markdown
# User

> Summary: 建军, Chinese, wife birthday Mar 15, standup with 老王 Wed

- Name: 建军 (Jianjun)
- Language: prefers Chinese conversation
- Wife's birthday: March 15 (annual reminder)
- Colleague: 老王, weekly standup Wed 10:00
- Updated: 2026-02-28
```

### File Format: Episodes

Each episode entry starts with a one-line `Summary`. This summary is injected into the system prompt index so the LLM can decide whether to load the full entry without reading the entire file.

**Summary must be ultra-concise** — every token in the system prompt costs context window budget. Use shorthand, arrows, abbreviations. Aim for under 10 words.

```markdown
# 2026-02 Episodes

> Summary: Tokyo flight research, birthday gift ideas

## Tokyo flight research
- Summary: Spring Airlines cheapest for Apr Tokyo trip
- Date: 2026-02-26
- Task: User asked to compare flights to Tokyo in April
- Findings: Spring Airlines ¥1200, ANA ¥2800, JAL ¥3100
- Lesson: Tavily search returns stale prices; cross-check with airline sites

## Birthday gift brainstorm
- Summary: wife likes ceramics, settled on Jingdezhen tea set
- Date: 2026-02-27
- Task: User asked for gift ideas for wife's birthday
- Context: Wife likes traditional crafts, especially ceramics
- Decision: Jingdezhen hand-painted tea set from Taobao
```

The file-level `> Summary:` line is regenerated after each `memory_write` or `memory_append`. The `memory_list` tool reads these summaries and the system prompt is built from `memory_list` output at the start of each task.

## 4. Organization: Directory Structure IS the Index

No separate index file or database needed. The directory tree itself serves as the index.

The LLM reads the directory listing to know what memories are available, then selects which files to read — a progressive, two-step retrieval.

### Why This Works

- Fact file names are fixed (user.md, memory.md) — no index maintenance needed
- Episode files organize naturally by month — the filesystem IS the timeline
- No sync issues, no corruption risk

## 5. Retrieval: LLM Judges Relevance via User Message

### Two-Step Retrieval Process

**Step 1 — Inject memory index as the first user message (iteration=1 only):**

At the start of a task (first cognitive iteration only), `memory_list` is called and its output is injected as a **user message** — not in the system prompt. This keeps the system prompt clean and avoids wasting context budget on every subsequent iteration.

```
[User message injected at iteration=1]

Available memory:
- facts/user.md (420B): 建军, Chinese, wife birthday Mar 15, standup with 老王 Wed
- facts/memory.md (310B): Tavily search returns stale prices
- episodes/2026-02.md (1.2KB): Tokyo flight research, birthday gift ideas

Use memory_read to load relevant files before responding.
```

This message is only added once (when `iteration === 1`). On subsequent reasoning iterations (after tool calls return), the memory index is already in the conversation history and does not need to be re-fetched.

**Step 2 — LLM decides** which files to read (if any) based on the current task.

### Why LLM-Driven?

- **Semantic understanding**: the LLM knows whether "what's my name?" requires `facts/user.md`
- **No keyword matching**: avoids brittle regex or TF-IDF approaches
- **Context-aware**: the same memory file may be relevant in one context and irrelevant in another
- **Prompt guidance**: we control retrieval behavior through prompt engineering, not code

## 6. Implementation: Memory Tools

Memory is accessed through the existing tool system (M3 infrastructure), requiring no changes to the cognitive loop.

### Tool Definitions

| Tool | Purpose | When Called |
|------|---------|------------|
| `memory_read` | Read a specific memory file | Thinker decides current task needs it |
| `memory_write` | Create or overwrite a fact file | New important fact learned |
| `memory_patch` | Patch specific sections of a memory file | Update individual facts without rewriting entire file |
| `memory_append` | Append an episode entry | After significant task completion |
| `memory_list` | List available memory files with summary | Auto-called at iteration=1 to build memory index |

### Tool Signatures

```typescript
// memory_read: Read a memory file
{
  name: "memory_read",
  params: { path: string }  // e.g., "facts/user.md"
  returns: string            // file content
}

// memory_write: Write/overwrite a fact file
{
  name: "memory_write",
  params: { path: string, content: string }
  returns: { success: boolean }
}

// memory_patch: Patch specific sections of a memory file
{
  name: "memory_patch",
  params: {
    path: string,            // e.g., "facts/user.md"
    patches: Array<{
      oldText: string,       // text to find
      newText: string        // replacement text
    }>
  }
  returns: { success: boolean, appliedCount: number }
}

// memory_append: Append an episode entry
{
  name: "memory_append",
  params: {
    path: string,
    entry: string,           // markdown block
    summary?: string         // optional: override file-level summary line
  }
  returns: { success: boolean }
}

// memory_list: List memory files with summary
{
  name: "memory_list",
  params: {}
  returns: Array<{
    path: string,
    summary: string,  // e.g. "user name, language, role"
    size: number      // bytes, so LLM can avoid loading huge files
  }>
}
```

### Path Sandboxing

All paths are relative to the agent's memory directory (e.g., `data/agents/main/memory/`) and **must not escape** that directory. The tools validate paths to prevent directory traversal attacks.

## 7. Write Timing: When Memories Are Created

### Reflection Gating: shouldReflect()

Not every completed task triggers reflection. The `shouldReflect()` function
filters out tasks that are unlikely to produce valuable memories:

**Skip reflection when:**
- Trivial tasks: ≤1 iteration, ≤1 action, result under 500 chars
- Zero tool calls with ≤1 iteration (pure conversation, no work done)
- Read-only tasks with short results (≤2 iterations, result under 500 chars)
  — simple lookups rarely produce new insights

**Why aggressive filtering?** Each reflection is an LLM call. If 80% of tasks
produce no memory writes, those are wasted API calls. Better to miss an
occasional insight than burn tokens on every trivial task.

**Important caveat:** User identity information (name, preferences) typically
surfaces in Main Agent conversation, not in Task Agent execution. The
`shouldReflect()` gate applies only to Task Agent. Main Agent reflection
is a separate concern (see `docs/todos.md`).

### Reflector Persona Alignment

The PostTaskReflector's system prompt begins with the agent's **persona identity**
(name, role, personality, values). This ensures the reflector's judgment about
"what matters" aligns with the agent's character. A precise, analytical persona
produces different memories than a casual, exploratory one.

### How the Reflector Works

The **PostTaskReflector** runs as a **tool-use loop** after task completion. Instead of producing structured JSON output that the Agent then parses and executes, the Reflector LLM directly calls memory tools (read/write/patch/append) in a multi-turn conversation.

Before the loop starts, the Agent pre-loads:
- **Existing facts** (full content of all fact files — kept under 15KB budget)
- **Episode index** (summaries from episode files)

These are provided to the Reflector's system prompt so it has full context to decide what to update.

### Memory Quality: What to Record vs Skip

The reflector prompt enforces strict content guidelines to prevent memory
pollution (LLMs recording everything they see).

**Core principle: Memory is for interaction-derived insights, not information
the agent can look up again.**

Memory captures what the agent learns from **conversations and task execution**
— things that exist nowhere else. If information can be re-retrieved (from the
web, files, or APIs), it generally does not belong in long-term memory.

**Worth recording:**
- User-stated personal information (name, preferences, work patterns)
- User's social relationships (colleagues, family, teams)
- Important dates and recurring events (birthdays, meetings, deadlines)
- Lessons learned from completing tasks (what worked, what didn't)
- User-specific preferences discovered through interaction
- Non-obvious patterns (e.g., "user always asks for options before deciding")

**NOT worth recording:**
- Information that can be searched again (web results, API responses)
- Generic knowledge the LLM already has
- Routine operations with no new insight
- Trivial Q&A with no lasting value
- Duplicates of information already in existing facts

### Fact File Constraints

The reflector prompt explicitly lists the allowed fact file names and their
purposes. The LLM cannot create new fact files — only write to the predefined
categories (`user.md`, `memory.md`). See Section 3 for the file naming design.

### Fact Extraction

```
Reflector (tool-use loop):
  "User mentioned their wife's birthday is March 15 — this belongs in user.md."
  → LLM calls memory_read("facts/user.md")
  → LLM calls memory_write("facts/user.md", updated content with birthday)
  "Tavily search returned stale prices — worth noting in memory.md."
  → LLM calls memory_append("facts/memory.md", "- Tavily search returns stale flight prices; cross-check with airline sites")
```

### Episode Archival

```
Reflector (tool-use loop):
  "We did a non-trivial flight comparison with useful findings.
   The process and result are worth remembering."
  → LLM calls memory_append("episodes/2026-02.md", summary block)
```

## 8. Architecture Integration

```
                    ┌─ memory_list → directory index (iteration=1 only)
First User Msg ─────┤
                    └─ "use memory tools if relevant"
                           │
Thinker ───── LLM call ────┤── may request memory_read
                           │── generates response
                           │
Reflector ── tool-use loop ┤── LLM directly calls memory_write (new facts)
  (pre-loaded facts +      │── LLM directly calls memory_patch (update facts)
   episode index)          └── LLM directly calls memory_append (experience)
```

### Key Insight

The memory system integrates **entirely through the tool mechanism**. No modifications needed to:

- EventBus
- TaskFSM state machine
- Cognitive loop (reason → act)
- Agent event dispatch

The only changes are:

1. Register memory tools in the ToolRegistry (and a separate `reflectionToolRegistry` for PostTaskReflector)
2. Inject memory directory listing as the first user message (iteration=1 only)
3. Let the existing tool-call loop handle `memory_read` during reasoning
4. PostTaskReflector uses its own tool-use loop to call `memory_write` / `memory_patch` / `memory_append` directly

## 9. Configuration

Memory storage directory is configured within the agent's data directory (e.g., `data/agents/main/memory/`). There is no separate memory config section — the path is derived internally.

## 10. Acceptance Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | **Remembers user info across restarts** | User says "I'm Zhang San" → restart → ask "what's my name?" → correct answer |
| 2 | **Remembers past work** | Ask "what bug did we fix last time?" → accurate summary |
| 3 | **Human-readable files** | Open `data/agents/main/memory/facts/user.md` in an editor → makes sense |
| 4 | **Human-editable** | Manually edit a memory file → agent uses updated content |
| 5 | **Zero new dependencies** | No new entries in `package.json` |
| 6 | **Test coverage >= 95%** | `make coverage` passes |

## 11. Explicitly Out of Scope

- **Conversation history / working memory** — Not part of M2. Context window management is a separate concern.
- **Vector search / embeddings** — Overkill for the current scale. Directory-based retrieval with LLM judgment is sufficient.
- **Database storage** — No SQLite, no KV store. Plain files only.
- **Token counting / context compression** — No sliding window, no summarization of old messages.
- **Automatic forgetting / decay** — Memories persist until explicitly updated or deleted.

## 12. Future Considerations

If memory files grow very large (hundreds of entries), we may need:

- **Episode splitting**: break large monthly files into smaller chunks (e.g., by week)
- **Episode summarization**: periodically compress old episodes into higher-level summaries
- **Selective episode injection**: only list recent or frequently-accessed episodes in the memory index
- **Memory decay**: auto-archive old, unused facts

These are optimizations for scale, not needed for the current milestone.
