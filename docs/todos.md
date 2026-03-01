# TODOs

Tracked features, improvements, and ideas — what's done and what's next.

## Completed

### Skill System
- [x] Skill framework: SkillLoader, SkillRegistry, SKILL.md format (YAML frontmatter + markdown body)
- [x] Skill storage: `skills/` (builtin, git tracked) + `data/skills/` (user/LLM created, runtime)
- [x] Skill triggering: LLM-driven (description in context) + user `/` command
- [x] Skill injection: inline (MainAgent/TaskAgent context) + fork (spawn_subagent)

### Task Types (Subagent Specialization)
- [x] Task type system: explore, plan, general
- [x] Per-type tool sets: explore (read-only), plan (read-only + write plans), general (all tools)
- [x] Per-type system prompts: specialized instructions for each type
- [x] `spawn_subagent` type parameter: MainAgent specifies task type when spawning
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
- [x] Project directory structure: `data/projects/<name>/` with session/, memory/, skills/
- [x] ProjectAdapter: ChannelAdapter implementation using Bun Worker threads
- [x] Project Agent Worker: independent Agent instance running in Worker thread
- [x] Project lifecycle FSM: active ⇄ suspended → completed → archived
- [x] Project discovery: scan `data/projects/*/PROJECT.md` on startup
- [x] MainAgent project tools: create/list/suspend/resume/complete/archive
- [x] Project memory isolation: scoped memory per project
- [x] Project skill loading: global + project-specific skills
- [x] Project Agent spawn_subagent for sub-tasks

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

## Planned

### System Prompt — Remaining
- [ ] SUBAGENT.md verification: confirm explore/plan/general prompts match design constraints

### Skill System — Remaining
- [ ] LLM-created skills: PostTaskReflector creates new skills from repeated patterns

### Task Types — Remaining
- [ ] Additional types: deepresearch, code

### Heartbeat & Scheduled Tasks
- [ ] Heartbeat system: periodic poll to check if anything needs attention
- [ ] Cron/scheduled tasks: time-based task triggers (reminders, periodic checks)
- [ ] Wake events: external triggers (file system changes, webhook callbacks)

### MainAgent Reflection
- [ ] Reflection during session compact: extract facts/episodes while summarizing
- [ ] MainAgent sees user preferences, identity info — most valuable facts come from here

### Multi-User Identity & Permissions
- [ ] Owner ID hashing: HMAC-SHA256 hashes instead of raw IDs in system prompt
- [ ] Authorized senders: allowlisted sender hashes for owner vs guest distinction
- [ ] Per-user permission model: different tool access levels per user

### Multi-Channel — Remaining
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
