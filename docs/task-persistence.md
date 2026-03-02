# Task Persistence

> Date: 2026-02-25

## Problem

Tasks run entirely in memory. When the process exits, all execution history is lost. The LLM cannot recall what happened in previous sessions.

## Solution

Persist task execution as incremental event logs. Each state change appends one line to a JSONL file. A replay function reconstructs the full conversation history from the log.

## Storage Layout

```
data/agents/main/tasks/
├── index.jsonl                      ← taskId → date lookup
├── 2026-02-25/
│   ├── a1b2c3d4e5f6.jsonl
│   └── g7h8i9j0k1l2.jsonl
└── 2026-02-26/
    └── m3n4o5p6q7r8.jsonl
```

- One directory per date (YYYY-MM-DD), derived from task creation time
- One JSONL file per task, named by taskId
- Append-only — each line is a self-contained event record

## Index

Two control files at `data/agents/main/tasks/`:

**`index.jsonl`** — taskId → date folder mapping. Append-only, one line per task, written on creation.

```jsonl
{"taskId":"a1b2c3d4","date":"2026-02-25"}
{"taskId":"e5f6g7h8","date":"2026-02-25"}
```

Used by `task_replay` to resolve taskId → file path without scanning date directories.

**`pending.json`** — currently active (non-terminal) tasks. JSON array, read-modify-write.

```json
[
  {"taskId":"e5f6g7h8","ts":1740000001}
]
```

A task is added on creation and removed on completion or failure. On startup, any remaining entries represent tasks that were interrupted.

## Event Log Format

Each line captures a single state transition with its incremental data:

```jsonl
{"ts":1740000000,"event":"TASK_CREATED","taskId":"abc123","data":{...}}
{"ts":1740000001,"event":"REASON_DONE","taskId":"abc123","data":{...}}
{"ts":1740000002,"event":"TOOL_CALL_COMPLETED","taskId":"abc123","data":{...}}
{"ts":1740000003,"event":"TASK_COMPLETED","taskId":"abc123","data":{...}}
{"ts":1740000004,"event":"REFLECTION_COMPLETE","taskId":"abc123","data":{...}}
```

Only new/changed data is written per event — messages are tracked by index to avoid duplication.

## Reading Back

**Replay** reads the JSONL file line-by-line and reconstructs the full TaskContext by accumulating each event's delta. This gives back the complete conversation history, execution trace, and final result.

**Two access levels:**

| Consumer | Gets |
|----------|------|
| Internal code | Full `TaskContext` (messages, reasoning, plan, actions, reflections) |
| LLM tools | Only `messages` (conversation history) — internal control state is hidden |

## LLM Tools

- **`task_list`** — List historical tasks by date. Returns summaries (taskId, input, status, time).
- **`task_replay`** — Load a task's conversation history by taskId. Returns the message array.

## Integration

The persister subscribes to the EventBus as a passive listener. It does not participate in task execution — it only observes and records. Failures in persistence are logged but never block task processing.

## Data Flow

```
EventBus events
    ↓ (subscribe)
TaskPersister
    ↓ (append)
data/agents/main/tasks/YYYY-MM-DD/{taskId}.jsonl
    ↓ (replay)
TaskContext / Message[]
    ↓ (via tools)
LLM reads historical tasks
```
