# Main Agent

Main Agent is Pegasus's **inner voice** — its continuous mental activity. Like a human's inner monologue when thinking through a problem, Main Agent's LLM output is self-talk: reasoning, weighing options, planning next steps. The user never sees this internal dialogue directly.

All outward behavior is through explicit tool calls. When Main Agent wants to speak to the user, it calls the `reply` tool. When it needs complex work done, it calls `spawn_task`. The LLM's text output is purely internal cognition.

## Core Concept: Inner Monologue

```
User says: "帮我查一下北京天气"

Main Agent's inner monologue (LLM text output, user never sees):
  "The user wants weather info for Beijing. This requires a web search,
   which I can't do directly. I should spawn a task for this and let the
   user know I'm working on it."

Main Agent's actions (tool calls, visible effects):
  → reply("好的，我来帮你查一下...")        ← user sees this
  → spawn_task("search Beijing weather")   ← task system handles this

[Task completes]

Main Agent's inner monologue:
  "The weather result is back — Beijing 25°C, sunny. I should tell the user."

Main Agent's actions:
  → reply("北京今天晴，25°C，适合外出。")   ← user sees this
```

This separation gives Pegasus the ability to **think without speaking** — it can reason, hesitate, change its mind, all without the user seeing unfinished thoughts.

## Role

```
Channel Adapters ──→ Main Agent ──→ Task System
  (CLI, Slack, ...)   (inner voice)   (Reason→Act→Reflect)
                           ↑
                     Session History
                  (monologue + actions)
```

- **Inner voice** — continuous reasoning about what to do and how to respond
- **Decision maker** — all outward actions are deliberate tool calls
- **Result integrator** — receives task results, thinks about them, decides what to tell the user

## API

```typescript
mainAgent.send(message: InboundMessage): void
mainAgent.onReply(callback: (message: OutboundMessage) => void): void
```

`send()` is fire-and-forget. Messages enter an internal queue and are processed sequentially. Main Agent is always responsive — new messages queue up while it's busy.

`onReply()` is triggered only when the LLM calls the `reply` tool. The LLM decides when, whether, and how many times to reply.

## Message Types

```typescript
interface InboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}

interface ChannelInfo {
  type: string;       // "cli" | "slack" | "sms" | "web" | "api"
  channelId: string;  // the "space" where the conversation happens
  userId?: string;    // who sent the message
  replyTo?: string;   // thread/conversation within the channel
}

interface OutboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}
```

### channelId vs replyTo

**`channelId`** identifies the conversation space:
- CLI: `"main"` (only one)
- Slack: `"#general"`, `"@zhangsan"` (a channel or DM)
- SMS: `"+8613800138000"` (a phone number)

**`replyTo`** identifies a thread or sub-conversation within the space:
- Slack: `"thread:1234567890"` (reply within a message thread)
- Web: `"session:abc123"` (a WebSocket session)
- CLI / SMS: not needed (no thread concept)

### Reply routing examples

```
Scenario: Slack group chat

Inbound message:
  channel: { type: "slack", channelId: "#general", userId: "zhangsan", replyTo: "thread:weather-discussion" }
  text: "@Pegasus 北京天气怎么样？"

Main Agent can reply to different targets:

  → reply({ text: "25°C 晴天", channelId: "#general", replyTo: "thread:weather-discussion" })
    Effect: reply in the same thread where the user asked

  → reply({ text: "结果私聊给你了", channelId: "@zhangsan" })
    Effect: send a direct message to the user

  → reply({ text: "大家注意今天有雨", channelId: "#general" })
    Effect: post a new message in the channel (not in a thread)
```

```
Scenario: CLI (simple)

Inbound message:
  channel: { type: "cli", channelId: "main" }
  text: "你好"

  → reply({ text: "你好！", channelId: "main" })
    Effect: print to stdout
```

```
Scenario: User says "把结果发到 Slack 上"

Main Agent is receiving via CLI, but the user wants output on Slack:

  → reply({ text: "好的，已发送到 Slack", channelId: "main" })         ← reply to CLI
  → reply({ text: "北京今天晴，25°C", channelId: "#weather-updates" }) ← also post to Slack
```

### reply tool signature

```typescript
reply({
  text: string;        // what to say
  channelId: string;   // which channel to send to
  replyTo?: string;    // optional: which thread within the channel
})
```

`channelId` is required — Main Agent must always explicitly choose where to speak. System prompt injects the available channels and the source channel of each inbound message, so the LLM has the context to decide.

## Tools

Main Agent's tools are its way of **acting on the world**. The LLM's text output is thinking; tool calls are doing.

| Tool | Purpose | Effect |
|------|---------|--------|
| `reply` | Speak to the user | Takes `text` + `channelId`, triggers `onReply` → delivered via channel adapter |
| `spawn_task` | Delegate simple work | Creates a task in the Task System |
| `spawn_subagent` | Delegate complex work | Launches an autonomous SubAgent in a Worker thread |
| `resume_subagent` | Resume a completed SubAgent | Restores session history and injects new input |
| `current_time` | Get current date/time | Returns result to inner monologue |
| `memory_list` / `memory_read` | Access long-term memory | Returns result to inner monologue |
| `task_status` / `task_list` | Query task state and history | Returns result to inner monologue |

Information-gathering tools (current_time, memory, task queries) return results into the inner monologue. Only `reply` produces user-visible output — it requires a `channelId` so Main Agent explicitly chooses where to send the message. Only `spawn_task` creates external side effects.

Complex tools (file I/O, shell, web search) are NOT available to Main Agent — they're only available inside Tasks.

## Interaction Examples

### Simple greeting

```
User: "你好"
Inner monologue: "A simple greeting, I should respond warmly."
→ reply("你好！有什么可以帮你的？")
```

### Quick tool lookup

```
User: "现在几点了？"
Inner monologue: "They want the time, I can check this directly."
→ current_time()
Inner monologue: "It's 15:25, let me tell them."
→ reply("现在是下午3:25。")
```

### Complex task delegation

```
User: "查一下北京天气，然后写个总结"
Inner monologue: "This needs web search and multi-step processing.
  I should spawn a task and let the user know."
→ reply("好的，我来帮你查一下...")
→ spawn_task({ description: "search Beijing weather and summarize", input: "..." })

[Task completes, result injected into session]

Inner monologue: "Weather results are back. Beijing 25°C sunny. Let me summarize for the user."
→ reply("北京今天晴，25°C，适合外出。")
```

### Choosing not to reply

```
User: "👍"
Inner monologue: "Just an acknowledgment, no response needed."
(no reply tool called — silence)
```

### Task failure

```
User: "读取 /etc/shadow"
→ spawn_task({ description: "read file", input: "/etc/shadow" })

[Task fails: permission denied]

Inner monologue: "The task failed with a permission error. This is expected —
  /etc/shadow requires root. I should let the user know and suggest alternatives."
→ reply("没有权限读取该文件。需要我换一种方式吗？")
```

## Task Communication

Task System pushes notifications directly into Main Agent's message queue. Main Agent does not poll or subscribe to EventBus for task events.

### Notification Callback

Main Agent registers a callback with the Task System at startup:

```typescript
this.agent.onNotify((taskId, type, data) => {
  this.queue.push({ kind: "task_notify", taskId, type, data });
  this._processQueue();
});
```

The Task System calls this whenever something noteworthy happens — it does not need to know what Main Agent is, only that there's a callback to invoke.

### What gets notified (and what doesn't)

| Notify | Don't notify |
|--------|-------------|
| Task completed (final result) | Each REASON_DONE / tool call step |
| Task failed (error) | Internal state transitions |
| Needs user clarification (NEED_MORE_INFO) | |
| Task notify (interim messages via `notify()` tool) | |

Task Agent can send messages to Main Agent during execution using the `notify()` tool. This is a general-purpose communication channel — not just progress updates. Use cases:
- Progress updates for long-running tasks
- Interim results the user might want to see early
- Clarification requests when the task is ambiguous
- Warnings about issues encountered (e.g., API errors, permission denied)

Each notify message arrives as a `task_notify` queue item and triggers `_think`, allowing Main Agent to decide whether to `reply()` to the user.

**Principle: only notify Main Agent with information that matters to the user.** Internal tool calls, intermediate reasoning, FSM transitions — these are Task System's internal business. Main Agent only needs to know outcomes and decisions that require its attention.

### Replaces onTaskComplete

The old per-task `onTaskComplete(taskId, callback)` pattern is replaced by this global notification callback. Benefits:

- No per-task callback registration (callbacks survive restart)
- Task can notify multiple times (not just on completion)
- Task System recovery can notify about failed pending tasks through the same channel

Main Agent maintains a session-level message history. This is the record of its inner monologue and all interactions.

**Session contains:**
- User messages (inbound)
- Main Agent's inner monologue (LLM text output)
- Tool calls and results (reply, spawn_task, current_time, etc.)
- Task result summaries (injected when tasks complete)

**Session does NOT contain:**
- Task-internal messages (tool calls and LLM reasoning inside tasks)
- UI/progress events

### Two Message Streams

| Level | Scope | Content | Lifetime |
|-------|-------|---------|----------|
| **Session** | Main Agent | Inner monologue + tool calls + user messages + task summaries | Persisted across restarts |
| **Task** | Per-task | LLM reasoning + tool calls + tool results | Single task lifecycle |

### Persistence

```
data/agents/main/session/
├── current.jsonl              ← active session
├── 2026-02-25-143000.jsonl    ← compacted previous session
└── 2026-02-24-180000.jsonl    ← older
```

Session is persisted as append-only JSONL. When token count exceeds threshold, the current session is compacted: renamed to a timestamped file, replaced with a summary that references the archived file.

### Startup Recovery

Two independent recovery processes, each handled by its own layer:

**Session recovery** (SessionStore's responsibility):

SessionStore.load() automatically repairs unclosed tool calls before returning messages. If the process crashed mid-thinking, the last assistant message may have tool calls without matching tool results:

```
[assistant] toolCalls: [spawn_task("查天气"), reply("好的")]
← process crashed — no tool result for either
```

SessionStore injects cancellation results to close them:

```
[tool] {"cancelled": true, "reason": "process restarted"}   ← for spawn_task
[tool] {"cancelled": true, "reason": "process restarted"}   ← for reply
```

This is purely a session data integrity concern — SessionStore doesn't know or care about tasks. It just ensures every tool call has a matching tool result so the message history is well-formed for the next LLM call.

**Task recovery** (Task System's responsibility):

Handled by Agent during its own `start()`, completely independent of Main Agent:

1. TaskPersister scans `data/agents/main/tasks/pending.json` for unfinished tasks
2. For each: append `TASK_FAILED` to its JSONL log, remove from `pending.json`
3. Push failure notification through the `onNotify` callback → enters Main Agent queue

Main Agent receives these as normal `task_notify` events. It doesn't know or care that they came from recovery vs normal execution.

**Startup sequence:**

```
MainAgent.start()
  1. sessionMessages = sessionStore.load()    ← repair happens inside load()
  2. agent.onNotify(callback)                 ← register before agent.start()
  3. agent.start()                            ← Task System recovers pending tasks
     → TaskPersister.recoverPending()
     → onNotify called for each failed task → enters Main Agent queue
  4. processQueue()                           ← handle recovery notifications
```

Main Agent is fully passive in recovery — it just loads its session (already repaired) and waits for notifications to arrive through the normal queue.

### Token Counting & Compaction

Token count is tracked in two parts:
- **Known tokens**: from `usage.promptTokens` returned by the last LLM call (exact)
- **New tokens**: counted via provider-specific methods (tiktoken for OpenAI, count_tokens API for Anthropic)

When estimated total exceeds threshold, compact before the next LLM call.

## System Prompt Design

The system prompt is built **once** at startup and cached for all LLM calls. This enables LLM prefix caching — the provider can reuse the cached token prefix across calls, saving cost and latency.

### Prompt Modes

The prompt builder (`src/identity/prompt.ts`) supports two modes via `buildSystemPrompt(options)`:

**Main Agent (mode: "main")** — full prompt with all sections:

| Section | Purpose |
|---------|---------|
| Identity | Persona name, role, personality, style, values, background |
| Safety | Anti-power-seeking guardrails for autonomous agent |
| How You Think | Inner monologue concept, reply() as only communication |
| Tools | Per-tool descriptions for all 15 MainAgent tools |
| Thinking Style | When to narrate vs silently call tools |
| When to Reply vs Spawn | Decision guidelines for direct reply vs task |
| AITask Types | Injected from AITaskTypeRegistry |
| Channels and reply() | Channel metadata format + per-channel style guidelines |
| Session History | Compact info + archive access |
| Available Skills | Injected from SkillRegistry (2% of context window budget) |

**Task Agent (mode: "task")** — minimal prompt:

| Section | Purpose |
|---------|---------|
| Identity | Same persona identity |
| Safety | Same safety guardrails |
| AITASK.md body | Type-specific instructions (explore/plan/general) |

Task Agents skip How You Think, Tools, Thinking Style, Reply vs Spawn, Channels, Session History, and Skills — saving ~100 lines of irrelevant tokens per LLM call.

> **Source of truth:** The actual prompt text lives in `src/identity/prompt.ts` section builder functions.

### Input Sanitization

External channel messages are sanitized via `sanitizeForPrompt()` (`src/infra/sanitize.ts`) before entering the session. Strips Unicode control/format/separator characters while preserving normal whitespace. Defends against prompt injection via crafted Unicode sequences.

### Dynamic Part (injected into messages)

Memory index is injected as a user message on the first LLM call (iteration 1 only), not in the system prompt. This keeps the system prompt stable for prefix caching.

Multiple channels connect to the same Main Agent through a unified adapter interface:

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│   CLI   │  │  Slack  │  │   SMS   │
│ Adapter │  │ Adapter │  │ Adapter │
└────┬────┘  └────┬────┘  └────┬────┘
     └────────────┴─────┬──────┘
                        ▼
                   Main Agent
```

```typescript
interface ChannelAdapter {
  readonly type: string;
  start(agent: { send(msg: InboundMessage): void }): Promise<void>;
  deliver(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
```

Each adapter listens for input on its channel and calls `agent.send()`. When Main Agent calls the `reply` tool, the outbound message is routed to the correct adapter via `deliver()`.

### Adapter Routing

Main Agent supports multi-channel routing via `registerAdapter()`. Each adapter is stored in an internal list, and the unified reply callback routes outbound messages by `channel.type`:

```typescript
mainAgent.registerAdapter(cliAdapter);      // type: "cli"
mainAgent.registerAdapter(telegramAdapter); // type: "telegram"

// When reply tool is called with channel.type = "telegram",
// the message is routed to telegramAdapter.deliver()
```

Adapters are started independently and connected to Main Agent's `send()`:

```typescript
await cliAdapter.start({ send: (msg) => mainAgent.send(msg) });
await telegramAdapter.start({ send: (msg) => mainAgent.send(msg) });
```

The `lastChannel` field tracks the most recent inbound message's channel, used for routing task completion notifications back to the correct channel.

If no adapter matches the `channel.type` in an outbound message, a warning is logged but no error is thrown. If an adapter's `deliver()` fails, the error is caught and logged without crashing the agent.

The legacy `onReply()` callback still works when no adapters are registered — useful for tests and simple setups.

The system prompt lists all channel types and their reply style guidelines. When a user message arrives, the channel metadata (type, channelId, replyTo) is visible in the message, and the LLM adapts its reply() accordingly.

## Relationship to Task System

Main Agent and the Task System are separate layers:

| Concern | Main Agent | Task System |
|---------|-----------|-------------|
| LLM role | Inner voice (thinking) | Execution engine (doing) |
| Output | Inner monologue + tool calls | Cognitive pipeline results |
| User interaction | Via `reply` tool | None (internal only) |
| State | Session history (cross-task) | TaskContext (per-task) |
| Tools | reply + spawn_task + simple tools | Full tool suite |
| Persistence | data/agents/main/session/ (session JSONL) | data/agents/main/tasks/ (task JSONL) |
| Lifetime | Entire session | Single task |
| Communication | Receives notifications via callback | Pushes results to Main Agent queue |
| Recovery | Repairs unclosed tool calls in session | Marks pending tasks as failed |

The Task System (Agent, TaskFSM, cognitive pipeline, EventBus) is unchanged internally. Main Agent creates tasks through `spawn_task`, and receives results via the `onNotify` callback pushed directly into its message queue.
