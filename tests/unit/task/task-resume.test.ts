import { afterAll, describe, expect, test } from "bun:test";
import {
  TaskState,
  TERMINAL_STATES,
  RESUMABLE_STATES,
} from "@pegasus/task/states.ts";
import {
  createTaskContext,
  prepareContextForResume,
} from "@pegasus/task/context.ts";
import { TaskFSM } from "@pegasus/task/fsm.ts";
import { TaskRegistry } from "@pegasus/task/registry.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import type { Event } from "@pegasus/events/types.ts";
import { InvalidStateTransition } from "@pegasus/infra/errors.ts";
import { TaskPersister } from "@pegasus/task/persister.ts";
import { EventBus } from "@pegasus/events/bus.ts";
import { resume_task } from "@pegasus/tools/builtins/resume-task-tool.ts";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";

// ── Helpers ────────────────────────────────────────

function makeEvent(
  type: EventType,
  overrides: Partial<Pick<Event, "source" | "taskId" | "payload">> = {},
): Event {
  return createEvent(type, {
    source: overrides.source ?? "test",
    taskId: overrides.taskId ?? null,
    payload: overrides.payload ?? {},
  });
}

// ── FSM tests ────────────────────────────────────

describe("Task Resume — FSM", () => {
  test("COMPLETED + TASK_RESUMED → REASONING", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });

  test("FAILED + TASK_RESUMED → throws InvalidStateTransition", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.FAILED;

    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_RESUMED));
    }).toThrow(InvalidStateTransition);
  });

  test("isTerminal: FAILED=true, COMPLETED=false", () => {
    const fsm = new TaskFSM();

    fsm.state = TaskState.FAILED;
    expect(fsm.isTerminal).toBe(true);

    fsm.state = TaskState.COMPLETED;
    expect(fsm.isTerminal).toBe(false);
  });

  test("isDone: COMPLETED=true, FAILED=true, others=false", () => {
    const fsm = new TaskFSM();

    fsm.state = TaskState.COMPLETED;
    expect(fsm.isDone).toBe(true);

    fsm.state = TaskState.FAILED;
    expect(fsm.isDone).toBe(true);

    fsm.state = TaskState.REASONING;
    expect(fsm.isDone).toBe(false);

    fsm.state = TaskState.IDLE;
    expect(fsm.isDone).toBe(false);
  });

  test("COMPLETED cannot accept non-TASK_RESUMED events", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_CREATED));
    }).toThrow(InvalidStateTransition);

    expect(() => {
      fsm.transition(makeEvent(EventType.REASON_DONE));
    }).toThrow(InvalidStateTransition);
  });

  test("canTransition: COMPLETED + TASK_RESUMED = true", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    expect(fsm.canTransition(EventType.TASK_RESUMED)).toBe(true);
    expect(fsm.canTransition(EventType.TASK_CREATED)).toBe(false);
    expect(fsm.canTransition(EventType.TASK_FAILED)).toBe(false);
  });

  test("cleanupTerminal only cleans FAILED, not COMPLETED", () => {
    const registry = new TaskRegistry();

    const completed = new TaskFSM();
    completed.state = TaskState.COMPLETED;
    const failed = new TaskFSM();
    failed.state = TaskState.FAILED;
    const active = new TaskFSM();
    active.state = TaskState.REASONING;

    registry.register(completed);
    registry.register(failed);
    registry.register(active);

    const cleaned = registry.cleanupTerminal();
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.state).toBe(TaskState.FAILED);

    // COMPLETED task still in registry
    expect(registry.getOrNull(completed.taskId)).toBe(completed);
    // Active task still there
    expect(registry.getOrNull(active.taskId)).toBe(active);
    // Failed task removed
    expect(registry.getOrNull(failed.taskId)).toBeNull();
  });

  test("RESUMABLE_STATES contains COMPLETED", () => {
    expect(RESUMABLE_STATES.has(TaskState.COMPLETED)).toBe(true);
    expect(RESUMABLE_STATES.size).toBe(1);
  });

  test("TERMINAL_STATES contains only FAILED", () => {
    expect(TERMINAL_STATES.has(TaskState.FAILED)).toBe(true);
    expect(TERMINAL_STATES.size).toBe(1);
    expect(TERMINAL_STATES.has(TaskState.COMPLETED)).toBe(false);
  });
});

// ── TaskFSM.hydrate() tests ────────────────────

describe("Task Resume — hydrate", () => {
  test("reconstructs FSM with correct taskId, state, context", () => {
    const ctx = createTaskContext({ inputText: "original task" });
    ctx.messages.push({ role: "user", content: "original task" });
    ctx.actionsDone.push({
      stepIndex: 0,
      actionType: "respond",
      actionInput: {},
      result: "done",
      success: true,
      startedAt: Date.now(),
    });

    const fsm = TaskFSM.hydrate("test-123", ctx, TaskState.COMPLETED);

    expect(fsm.taskId).toBe("test-123");
    expect(fsm.state).toBe(TaskState.COMPLETED);
    expect(fsm.context.inputText).toBe("original task");
    expect(fsm.context.messages).toHaveLength(1);
    expect(fsm.context.actionsDone).toHaveLength(1);
    // Should NOT have logged task_created (no history entry)
    expect(fsm.history).toHaveLength(0);
  });

  test("hydrated FSM can transition COMPLETED → REASONING via TASK_RESUMED", () => {
    const ctx = createTaskContext({ inputText: "original" });
    const fsm = TaskFSM.hydrate("test-456", ctx, TaskState.COMPLETED);

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });
});

// ── prepareContextForResume() tests ─────────────

describe("Task Resume — prepareContextForResume", () => {
  test("clears cognitive state, preserves messages and actionsDone", () => {
    const ctx = createTaskContext({ inputText: "original" });
    ctx.plan = { goal: "old", steps: [], reasoning: "old" };
    ctx.reasoning = { answer: "stale" };
    ctx.finalResult = { some: "result" };
    ctx.error = "old error";
    ctx.iteration = 5;
    ctx.postReflection = { assessment: "done", toolCallsCount: 2 };
    ctx.suspendedState = "reasoning";
    ctx.suspendReason = "waiting";
    ctx.messages.push(
      { role: "user", content: "original" },
      { role: "assistant", content: "response" },
    );
    ctx.actionsDone.push({
      stepIndex: 0,
      actionType: "respond",
      actionInput: {},
      result: "ok",
      success: true,
      startedAt: Date.now(),
    });

    prepareContextForResume(ctx, "continue with this");

    // Cleared
    expect(ctx.plan).toBeNull();
    expect(ctx.reasoning).toBeNull();
    expect(ctx.finalResult).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.iteration).toBe(0);
    expect(ctx.postReflection).toBeNull();
    expect(ctx.suspendedState).toBeNull();
    expect(ctx.suspendReason).toBeNull();

    // Preserved
    expect(ctx.messages).toHaveLength(3); // 2 original + 1 new
    expect(ctx.actionsDone).toHaveLength(1);

    // New message appended
    expect(ctx.messages[2]).toEqual({ role: "user", content: "continue with this" });
  });

  test("works on empty context", () => {
    const ctx = createTaskContext();

    prepareContextForResume(ctx, "new instruction");

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.content).toBe("new instruction");
    expect(ctx.iteration).toBe(0);
  });
});

// ── Persister tests ────────────────────────────

describe("Task Resume — Persister", () => {
  const persisterDataDir = "/tmp/pegasus-test-task-resume-persister";
  const persisterTasksDir = `${persisterDataDir}/tasks`;

  afterAll(async () => {
    await rm(persisterDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("TASK_RESUMED event is recorded in JSONL and replay reconstructs context", async () => {
    const bus = new EventBus({ keepHistory: true });
    const registry = new TaskRegistry();
    const persister = new TaskPersister(bus, registry, persisterTasksDir);
    // Keep reference to prevent GC (side-effect: subscribes to EventBus)
    void persister;

    await bus.start();

    try {
      // Simulate a task lifecycle: create → complete → resume
      const taskId = "persist-resume-test";
      const task = new TaskFSM({ taskId });
      task.context.inputText = "original task";
      task.context.messages.push({ role: "user", content: "original task" });
      registry.register(task);

      // 1. TASK_CREATED
      await bus.emit(createEvent(EventType.TASK_CREATED, {
        source: "test",
        taskId,
      }));
      await Bun.sleep(50);

      // 2. TASK_COMPLETED
      task.state = TaskState.COMPLETED;
      task.context.finalResult = { response: "done" };
      task.context.iteration = 1;
      await bus.emit(createEvent(EventType.TASK_COMPLETED, {
        source: "test",
        taskId,
        payload: { result: task.context.finalResult },
      }));
      await Bun.sleep(50);

      // 3. Prepare for resume and emit TASK_RESUMED
      prepareContextForResume(task.context, "continue please");
      await bus.emit(createEvent(EventType.TASK_RESUMED, {
        source: "agent",
        taskId,
        payload: { newInput: "continue please" },
      }));
      await Bun.sleep(50);

      // Verify JSONL file exists and has TASK_RESUMED
      const taskPath = await TaskPersister.resolveTaskPath(
        persisterTasksDir,
        taskId,
      );
      expect(taskPath).not.toBeNull();

      const content = await readFile(taskPath!, "utf-8");
      const lines = content.trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const resumeEvent = events.find((e: { event: string }) => e.event === "TASK_RESUMED");
      expect(resumeEvent).toBeDefined();
      expect(resumeEvent.data.newInput).toBe("continue please");
      expect(resumeEvent.data.previousState).toBe("completed");

      // Replay and verify context
      const replayedCtx = await TaskPersister.replay(taskPath!);
      expect(replayedCtx.plan).toBeNull();
      expect(replayedCtx.reasoning).toBeNull();
      expect(replayedCtx.finalResult).toBeNull();
      expect(replayedCtx.iteration).toBe(0);
      // Messages should include the new user message from resume
      const userMsgs = replayedCtx.messages.filter((m) => m.role === "user");
      expect(userMsgs.some((m) => m.content === "continue please")).toBe(true);

      // Verify pending.json was updated (task added back)
      const pendingPath = path.join(persisterTasksDir, "pending.json");
      const pendingContent = await readFile(pendingPath, "utf-8");
      const pending = JSON.parse(pendingContent);
      expect(pending.some((p: { taskId: string }) => p.taskId === taskId)).toBe(true);
    } finally {
      await bus.stop();
    }
  }, 10_000);
});

// ── resume_task tool tests ──────────────────────

describe("Task Resume — resume_task tool", () => {
  test("returns correct signal payload", async () => {
    const result = await resume_task.execute(
      { task_id: "abc-123", input: "do more" },
      { taskId: "main-agent" },
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      action: "resume_task",
      task_id: "abc-123",
      input: "do more",
    });
  });

  test("Zod validation on parameters", () => {
    const schema = resume_task.parameters;

    // Valid
    expect(() => schema.parse({ task_id: "abc", input: "hello" })).not.toThrow();

    // Missing task_id
    expect(() => schema.parse({ input: "hello" })).toThrow();

    // Missing input
    expect(() => schema.parse({ task_id: "abc" })).toThrow();

    // Both missing
    expect(() => schema.parse({})).toThrow();
  });
});
