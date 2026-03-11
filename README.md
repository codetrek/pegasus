# Pegasus — Autonomous Agent System

Pegasus is a continuously running autonomous agent that handles multiple tasks concurrently, calls tools, makes decisions, and learns from experience. Unlike traditional chatbots, it maintains persistent memory, manages long-running projects, and operates across multiple communication channels.

## What It Does

**Think, then act.** Pegasus uses an inner monologue architecture — the LLM's output is private reasoning, and only deliberate `reply` tool calls reach the user. This separation means the agent can think through complex problems, plan multi-step actions, and self-correct before responding.

**Remember everything.** Long-term memory stores facts and episodic experiences as markdown files. The agent learns user preferences, project context, and domain knowledge over time. Memory persists across restarts and is searchable by the agent.

**Run projects autonomously.** Long-lived task spaces (Projects) run in isolated Worker threads with their own session, memory, and skill set. Each project maintains independent context while the Main Agent coordinates across all of them.

**Work across channels.** CLI, Telegram — and more planned. The same agent, same memory, same personality, accessible from anywhere.

## Key Capabilities

### Cognitive Architecture
- **Inner monologue** — private LLM reasoning separated from user-facing output
- **2-stage pipeline** — Reason → Act, with async post-task reflection for memory extraction
- **Task state machine** — precise lifecycle control with suspend/resume
- **Concurrent execution** — multiple tasks run in parallel with semaphore-based throttling

### Model Flexibility
- **Multi-provider** — OpenAI, Anthropic, Codex, GitHub Copilot, Ollama, LM Studio, or any OpenAI-compatible endpoint
- **Per-role models** — different models for reasoning, task execution, summarization, and reflection
- **Per-role tuning** — override context window size and API type per role
- **150+ models** — auto-detected context window sizes for all major models

### Autonomy
- **Skill system** — extensible SKILL.md files that the agent auto-discovers and invokes
- **Subagent specialization** — task types (explore, plan, general) with tailored tool sets and prompts
- **Project system** — isolated long-running workspaces with Worker threads
- **Startup recovery** — session repair and pending task auto-recovery after restart

### Safety
- **Anti-power-seeking guardrails** — the agent prioritizes safety over task completion
- **Input sanitization** — Unicode control character stripping for prompt injection defense
- **Tool restrictions** — two-layer validation (LLM visibility + execution gating) per task type

## Getting Started

```bash
bun install
cp .env.example .env   # set your API key
bun run dev
```

See [docs/](./docs/) for technical documentation, configuration reference, and architecture details.

## License

MIT
