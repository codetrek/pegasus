/**
 * Tests for task_status tool — runtime task state query.
 */
import { describe, it, expect } from "bun:test";
import { task_status } from "../../../src/tools/builtins/task-status-tool.ts";
import { TaskRegistry } from "../../../src/task/registry.ts";
import { TaskFSM } from "../../../src/task/fsm.ts";
import { EventType, createEvent } from "../../../src/events/types.ts";

function createTestTask(_taskId: string, description: string): TaskFSM {
  const event = createEvent(EventType.MESSAGE_RECEIVED, {
    source: "test",
    payload: { text: description, taskType: "general", description },
  });
  return TaskFSM.fromEvent(event);
}

describe("task_status", () => {
  it("should return error when taskRegistry is not in context", async () => {
    const result = await task_status.execute({}, { taskId: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TaskRegistry not available");
  });

  it("should list all tasks when no taskId is specified", async () => {
    const registry = new TaskRegistry();
    const task = createTestTask("t1", "Test task");
    registry.register(task);

    const result = await task_status.execute(
      {},
      { taskId: "test", taskRegistry: registry },
    );
    expect(result.success).toBe(true);
    const data = result.result as { tasks: unknown[]; activeCount: number; totalCount: number };
    expect(data.totalCount).toBe(1);
    expect(data.tasks).toHaveLength(1);
  });

  it("should query a specific task by taskId", async () => {
    const registry = new TaskRegistry();
    const task = createTestTask("t1", "Specific task");
    registry.register(task);

    const result = await task_status.execute(
      { taskId: task.taskId },
      { taskId: "test", taskRegistry: registry },
    );
    expect(result.success).toBe(true);
    const data = result.result as { taskId: string; state: string; description: string };
    expect(data.taskId).toBe(task.taskId);
    expect(data.state).toBe("idle");
    expect(data.description).toBe("Specific task");
  });

  it("should return not_found for unknown taskId", async () => {
    const registry = new TaskRegistry();

    const result = await task_status.execute(
      { taskId: "nonexistent" },
      { taskId: "test", taskRegistry: registry },
    );
    expect(result.success).toBe(true);
    const data = result.result as { status: string };
    expect(data.status).toBe("not_found");
  });

  it("should show active count correctly", async () => {
    const registry = new TaskRegistry();
    const task1 = createTestTask("t1", "Task 1");
    const task2 = createTestTask("t2", "Task 2");
    registry.register(task1);
    registry.register(task2);

    // Transition task1 to REASONING (active)
    const createdEvent = createEvent(EventType.TASK_CREATED, {
      source: "agent",
      taskId: task1.taskId,
    });
    task1.transition(createdEvent);

    const result = await task_status.execute(
      {},
      { taskId: "test", taskRegistry: registry },
    );
    expect(result.success).toBe(true);
    const data = result.result as { activeCount: number; totalCount: number };
    expect(data.totalCount).toBe(2);
    expect(data.activeCount).toBe(1);
  });

  it("should include error field for failed tasks", async () => {
    const registry = new TaskRegistry();
    const task = createTestTask("t1", "Failing task");
    registry.register(task);

    // Transition to REASONING then FAILED
    const createdEvent = createEvent(EventType.TASK_CREATED, {
      source: "agent",
      taskId: task.taskId,
    });
    task.transition(createdEvent);
    task.context.error = "Something went wrong";
    const failEvent = createEvent(EventType.TASK_FAILED, {
      source: "agent",
      taskId: task.taskId,
      payload: { error: "Something went wrong" },
    });
    task.transition(failEvent);

    const result = await task_status.execute(
      { taskId: task.taskId },
      { taskId: "test", taskRegistry: registry },
    );
    expect(result.success).toBe(true);
    const data = result.result as { state: string; error: string };
    expect(data.state).toBe("failed");
    expect(data.error).toBe("Something went wrong");
  });
});
