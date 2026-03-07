# TODOs

Tracked features, improvements, and ideas — what's done and what's next.

## Completed

### Skill System
- [x] Skill framework: SkillLoader, SkillRegistry, SKILL.md format (YAML frontmatter + markdown body)
- [x] Skill storage: `skills/` (builtin, git tracked) + `data/skills/` (user/LLM created, runtime)
- [x] Skill triggering: LLM-driven (description in context) + user `/` command
- [x] Skill injection: inline (MainAgent/TaskAgent context) + fork (spawn_task)

### AITask Types (Task Specialization)
- [x] Task type system: explore, plan, general
- [x] Per-type tool sets: explore (read-only), plan (read-only + write plans), general (all tools)
- [x] Per-type system prompts: specialized instructions for each type
- [x] `spawn_task` type parameter: MainAgent specifies task type when spawning
- [x] Skill `agent` field maps to task type
- [x] Two-layer tool restriction: LLM visibility + execution validation
- [x] Persistence backward compatibility (old JSONL defaults to "general")

### Task Progress Notification
- [x] `notify` tool for Task Agent: send messages to MainAgent during execution
- [x] TASK_NOTIFY EventBus event (persisted to JSONL)
- [x] MainAgent receives notify as `task_notify` events (same channel as completion)

### System Prompt Optimization
- [x] P0 — Prompt Mode (full/minimal) + per-tool descriptions
- [x] P1 — Safety guardrails + tool call style guidance + input sanitization
- [x] P2 — Section modularization: `buildXxxSection()` composable functions
- [x] Runtime metadata: one-line runtime info in system prompt (host, OS, model, timezone, workspace)

### Project System
- [x] PROJECT.md format: frontmatter (name, status, model, workdir, timestamps) + markdown body
- [x] Project directory structure: `data/agents/projects/<name>/` with session/, memory/, skills/
- [x] ProjectAdapter: ChannelAdapter implementation using Bun Worker threads
- [x] Project Agent Worker: independent Agent instance running in Worker thread
- [x] Project lifecycle FSM: active ⇄ suspended → completed → archived
- [x] Project discovery: scan `data/agents/projects/*/PROJECT.md` on startup
- [x] MainAgent project tools: create/list/suspend/resume/complete/archive
- [x] Project memory isolation: scoped memory per project
- [x] Project skill loading: global + project-specific skills
- [x] Project Agent spawn_task for sub-tasks

### Multi-Model & LLM Providers
- [x] Tier-based model selection: fast, balanced, powerful tiers (replaces per-role system)
- [x] Per-tier context window and API type override
- [x] SUBAGENT.md `model` field: declare tier or specific model per subagent type
- [x] pi-ai LLM layer: unified multi-provider abstraction (replaced custom clients)
- [x] OpenAI Codex integration (Responses API + device code OAuth)
- [x] GitHub Copilot integration (OpenAI-compatible + device code OAuth)
- [x] Provider auto-detection + explicit type override
- [x] 150+ model context window auto-detection

### Multi-Channel
- [x] Telegram channel adapter (Grammy + long polling, text-only MVP)
- [x] Multi-channel adapter routing in MainAgent (`registerAdapter()`)
- [x] CLIAdapter extracted from cli.ts as proper ChannelAdapter

### Tool System
- [x] MCP server integration: connect external tool services via standard protocol
- [x] MCP OAuth authentication: Client Credentials + Device Code flows
- [x] web_search: Tavily API integration for real-time web searches
- [x] web_fetch: AI-powered web content extraction with LLM summarization
- [x] Background tool execution: bg_run, bg_output, bg_stop for long-running commands
- [x] Large file context protection: automatic truncation and guidance for oversized reads

### Memory System
- [x] Memory injection: load facts fully + episodes summary into session on start and after compact
- [x] PostTaskReflector: async memory extraction after task completion (facts + episodes)
- [x] MainAgent reflection: extract facts/episodes during session compact (fire-and-forget)

## Planned

### System Prompt — Remaining
- [ ] AITASK.md verification: confirm explore/plan/general prompts match design constraints

### Skill System — Remaining
- [ ] LLM-created skills: PostTaskReflector creates new skills from repeated patterns

### Task Types — Remaining
- [ ] Additional types: deepresearch, code

### Heartbeat & Scheduled Tasks
- [ ] Heartbeat system: periodic poll to check if anything needs attention
- [ ] Cron/scheduled tasks: time-based task triggers (reminders, periodic checks)
- [ ] Wake events: external triggers (file system changes, webhook callbacks)

### Multi-User Identity & Permissions
- [ ] Owner ID hashing: HMAC-SHA256 hashes instead of raw IDs in system prompt
- [ ] Authorized senders: allowlisted sender hashes for owner vs guest distinction
- [ ] Per-user permission model: different tool access levels per user
- [ ] `hasChannel` empty array edge case: `OwnerStore.hasChannel()` uses `in` operator which returns true for `"telegram": []`. Should check array length > 0.

### Security — Channel Projects
- [ ] Channel Project tool restriction: Channel Projects currently have full tool access (including shell_exec, write_file). The PROJECT.md goal says "Do NOT execute shell commands" but this is only a prompt-level constraint. Should add code-level tool filtering for channel Projects.
- [ ] Sanitize channelType in notification: `channelType` is not sanitized in notification text (currently only userId and username are sanitized).

### Multi-Channel — Remaining
- [ ] Telegram 要支持发图片/voice
- [ ] Slack channel adapter
- [ ] SMS channel adapter
- [ ] Web/API channel adapter

### Memory Improvements
- [ ] Episode splitting: break large monthly files by week
- [ ] Episode summarization: compress old episodes into higher-level summaries
- [ ] Selective injection: only list recent/relevant memory in context
- [ ] Memory decay: auto-archive old, unused facts

### Tool System — Remaining
- [ ] Custom tool plugins: user-defined TypeScript tools
- [ ] Tool permission system: per-tool approval rules

### Observability
- [ ] Task execution dashboard
- [ ] Memory usage visualization
- [ ] Token cost tracking per task/session

### SubAgent Ownership & Hierarchy
- [x] SubAgent now belongs to its parent Agent via TaskRunner (not a global singleton)
  - Done: SubAgentManager deleted, all subagents managed by TaskRunner
  - Done: Two-level nesting — L1 can spawn L2, L2 cannot spawn further (depth-based)
  - Remaining: TaskRunner is still a flat tracker (not hierarchical tree). If needed later, can add parent-child tracking.

### ToolContext Redesign
- [ ] ToolContext is a god bag — 16 optional fields, 10 typed as `unknown`
  - Current: flat interface with all fields optional, tools do `as SomeLike` type assertions internally
  - Problem: no type safety, every field is MainAgent-specific coupling, `Object.assign` on every tool call
  - Options:
    - A) Simplify to `Record<string, unknown>` (honest bag, tools declare what they need)
    - B) Typed per-tool context via generics or intersection types
  - Done: `subAgentManager` field removed (SubAgentManager deleted)
  - Also: `userId`, `allowedPaths` fields are never set — dead fields
  - Also: `storeImage` callback should move to ImageManager (already has `store()`)
  - Related: Agent.buildToolContext() and MainAgent.buildToolContext() can be simplified once ToolContext is cleaner

### Unified spawn_subagent
- [x] spawn_task and spawn_subagent merged into single `spawn_subagent` tool
  - Done: spawn_task + resume_task deleted
  - Done: SubAgentManager + Worker subagent mode deleted (~2,500 lines)
  - Done: TaskRunner gains depth + memorySnapshot for nesting control
  - Done: All subagents run inline via Agent.run() (no Worker threads)
  - Done: Two-level nesting limit enforced via depth parameter
  - Done: resume preserves original task depth (prevents L2→L1 escalation)
