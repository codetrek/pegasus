# Pending Recovery — Crash Recovery for Subagents & Background Tasks

> Date: 2026-03-12

## Problem

Subagents and background tasks (`bg_run`) are tracked purely in memory (`_activeSubagents` Map and `BackgroundTaskManager.tasks` Map). If the process crashes and restarts, all tracking is lost — there is no way to know which tasks were interrupted, no way to cancel orphaned processes, and the LLM has no visibility into what happened.

This capability was originally implemented in `TaskPersister.recoverPending()` (commit `854aea2`, PR #32) but was deleted during the architecture refactor in commit `599d912` (PR #140) when `TaskPersister` was removed as "dead code." The new architecture never re-implemented this feature.

## Solution

Introduce a `PendingTracker` class that maintains a `pending.json` file recording all in-flight subagents and background tasks. On startup, any remaining entries represent interrupted work — they are cleared from the file and reported to the LLM as recovery notifications.

## Data Model

### pending.json Format

```json
[
  {
    "id": "sub-abc123",
    "kind": "subagent",
    "ts": 1740000001,
    "description": "Explore auth module",
    "agentType": "explore",
    "input": "Find all auth-related files..."
  },
  {
    "id": "bg-xyz789",
    "kind": "bg_run",
    "ts": 1740000002,
    "tool": "shell_exec",
    "params": { "command": "bun test" }
  }
]
```

### Storage Location

`{sessionDir}/pending.json` — colocated with `current.jsonl`, follows session lifecycle.

For MainAgent: `~/.pegasus/agents/main/session/pending.json`.

### Read/Write Strategy

Read-modify-write with a Promise chain (`pendingLock`) for serialization, identical to the original `TaskPersister._updatePending` pattern. Single-process, single-threaded — no need for file locks.

## PendingTracker Class

New file: `src/agents/pending-tracker.ts`

```typescript
class PendingTracker {
  constructor(private dir: string)     // sessionDir

  add(entry: PendingEntry): void       // fire-and-forget, serialized via pendingLock
  remove(id: string): void             // fire-and-forget, serialized via pendingLock
  recover(): Promise<PendingEntry[]>   // read remnants -> clear file -> return
}
```

### Why a Separate Class

- **Not in SessionStore**: SessionStore only handles message JSONL read/write. Adding pending logic would break single responsibility.
- **Not in Agent**: Agent is already 1800+ lines. Pending tracking is an independent concern.
- **Standalone**: Can be injected into both Agent (for subagents) and BackgroundTaskManager (for bg_run).

## Write Lifecycle

### Subagent

| Event | Action | Location |
|-------|--------|----------|
| `submit()` creates subagent | `tracker.add()` | `Agent._runSubagent()`, after `_activeSubagents.set()` |
| Subagent `.run()` resolves (success or failure) | `tracker.remove()` | `_runSubagent()` `.then()` / `.catch()` |

### bg_run

| Event | Action | Location |
|-------|--------|----------|
| `BackgroundTaskManager.run()` creates task | `tracker.add()` | After `tasks.set()` |
| Task completes, fails, or is stopped | `tracker.remove()` | `.then()` / `.catch()` and `stop()` |

### Ordering Principle

- **Memory first, disk second**: Update in-memory state (`_activeSubagents.set()` / `tasks.set()`) before writing `pending.json`. If disk write fails, runtime is still correct — only crash recovery is degraded. Log a warning.
- **Remove failures don't block**: If `remove()` fails, log warn, don't throw. Next startup's `recover()` will handle the stale entry as a false positive.
- **Fire-and-forget**: `add()` / `remove()` are not awaited. Serialized internally via `pendingLock`.

## BackgroundTaskManager Integration

`BackgroundTaskManager` receives an optional `PendingTracker` via constructor:

```typescript
class BackgroundTaskManager {
  constructor(
    private executor: ToolExecutor,
    private defaultTimeout: number = MAX_TOOL_TIMEOUT,
    private pendingTracker?: PendingTracker,       // new, optional
  ) {}
}
```

- **With tracker** (MainAgent): writes `pending.json` on run/complete/stop.
- **Without tracker** (subagent-internal): behavior unchanged from today.

Only MainAgent's BackgroundTaskManager needs persistence. Subagent-internal bg_run tasks don't need double tracking — the parent already tracks the subagent itself.

## Startup Recovery

### Timing

In `Agent.onStart()`, after session load and memory injection:

```
onStart():
  1. sessionStore.load()          // existing — includes _repairUnclosedToolCalls
  2. _injectMemoryIndex()         // existing — only for fresh sessions (length === 0)
  3. recoverPending()             // NEW — read pending.json, inject notifications, clear
```

Placed last because:
- Depends on session being loaded (needs to append messages).
- Must not interfere with `_injectMemoryIndex` check (`sessionMessages.length === 0`). If recovery messages were injected first, fresh sessions would skip memory injection.
- Recovery notifications are "the most recent event" — belong at the end of session history.

### Recovery Logic

```
recoverPending(sessionDir):
  1. Read {sessionDir}/pending.json
     - File missing / parse error -> return [] (normal first start / corrupted)
     - Empty array -> return []

  2. Collect all entries as recovered list

  3. Write "[]" to pending.json (clear)

  4. Return recovered list
```

### LLM Notification

For each recovered entry, inject a user message into sessionMessages and persist to SessionStore:

**Subagent:**
```
[Recovery] Subagent sub-abc123 (explore: "Explore auth module")
was interrupted by process restart and has been marked as failed.
You may resume it with resume_subagent if needed.
```

**bg_run:**
```
[Recovery] Background task bg-xyz789 (shell_exec)
was interrupted by process restart. The process no longer exists.
```

This complements `_repairUnclosedToolCalls` (which fixes tool-call format integrity) by providing business-level interruption awareness.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `add()` write fails | `log.warn`, no throw. Worst case: crash loses one entry (task just started, minimal progress lost). |
| `remove()` write fails | `log.warn`, no throw. Worst case: false positive on next recovery — LLM discovers task already completed, harmless. |
| `add` not yet flushed when crash | Entry missing from `pending.json`. Task just started, negligible impact. Not worth WAL/fsync. |
| `remove` not yet flushed when crash | Stale entry remains. False positive on recovery — LLM self-corrects. Acceptable. |
| `recover()` finds corrupted JSON | `log.warn`, delete corrupted file, return []. Startup must never be blocked. |
| Session compact | `pending.json` is independent of `current.jsonl`. Compact renames session archive; pending.json is unaffected. |

## Testing Strategy

### Unit Tests (PendingTracker)

- `add` -> file contains entry
- `remove` -> entry gone
- `add` + `add` + `remove` -> correct remainder
- `recover` -> returns remnants + file cleared to `[]`
- `recover` empty file / missing file -> return `[]`
- `recover` corrupted JSON -> return `[]` + file deleted
- `pendingLock` serialization (concurrent add/remove don't lose data)

### Integration Tests (Agent + PendingTracker)

- Start -> spawn subagent -> verify pending.json has entry
- Subagent completes -> verify pending.json is empty
- Simulate crash recovery: manually write pending.json -> agent.start() -> verify sessionMessages contains recovery notification
