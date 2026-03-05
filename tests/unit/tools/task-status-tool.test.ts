/**
 * Tests for task_status tool — runtime task state query.
 * Covers both old TaskRegistry and new TaskRunner interfaces.
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

  // ── Old TaskRegistry interface tests ──

  describe("TaskRegistry (old interface)", () => {
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

    it("should handle registry errors gracefully", async () => {
      const brokenRegistry = {
        listAll() { throw new Error("DB corrupted"); },
        getOrNull() { throw new Error("DB corrupted"); },
        activeCount: 0,
        totalCount: 0,
      };

      const result = await task_status.execute(
        {},
        { taskId: "test", taskRegistry: brokenRegistry },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("DB corrupted");
    });
  });

  // ── New TaskRunner interface tests ──

  describe("TaskRunner (new interface)", () => {
    function createMockRunner(tasks: Array<{
      taskId: string;
      taskType: string;
      description: string;
      source: string;
      startedAt: number;
    }> = []) {
      return {
        getStatus(taskId: string) {
          return tasks.find((t) => t.taskId === taskId) ?? null;
        },
        listAll() {
          return [...tasks];
        },
        get activeCount() {
          return tasks.length;
        },
      };
    }

    it("should list all active tasks when no taskId is specified", async () => {
      const runner = createMockRunner([
        { taskId: "tr-1", taskType: "web_search", description: "Search weather", source: "main-agent", startedAt: 1000 },
        { taskId: "tr-2", taskType: "general", description: "Do something", source: "skill:test", startedAt: 2000 },
      ]);

      const result = await task_status.execute(
        {},
        { taskId: "test", taskRegistry: runner },
      );
      expect(result.success).toBe(true);
      const data = result.result as { tasks: Array<{ taskId: string; state: string; description: string; taskType: string }>; activeCount: number; totalCount: number };
      expect(data.activeCount).toBe(2);
      expect(data.totalCount).toBe(2);
      expect(data.tasks).toHaveLength(2);
      expect(data.tasks[0]!.taskId).toBe("tr-1");
      expect(data.tasks[0]!.state).toBe("running");
      expect(data.tasks[0]!.description).toBe("Search weather");
      expect(data.tasks[0]!.taskType).toBe("web_search");
      expect(data.tasks[1]!.taskId).toBe("tr-2");
    });

    it("should query a specific active task by taskId", async () => {
      const runner = createMockRunner([
        { taskId: "tr-42", taskType: "general", description: "Active task", source: "main-agent", startedAt: 5000 },
      ]);

      const result = await task_status.execute(
        { taskId: "tr-42" },
        { taskId: "test", taskRegistry: runner },
      );
      expect(result.success).toBe(true);
      const data = result.result as { taskId: string; state: string; description: string; taskType: string; source: string; startedAt: number };
      expect(data.taskId).toBe("tr-42");
      expect(data.state).toBe("running");
      expect(data.description).toBe("Active task");
      expect(data.taskType).toBe("general");
      expect(data.source).toBe("main-agent");
      expect(data.startedAt).toBe(5000);
    });

    it("should return not_found for unknown taskId", async () => {
      const runner = createMockRunner([]);

      const result = await task_status.execute(
        { taskId: "nonexistent" },
        { taskId: "test", taskRegistry: runner },
      );
      expect(result.success).toBe(true);
      const data = result.result as { status: string };
      expect(data.status).toBe("not_found");
    });

    it("should show activeCount from runner", async () => {
      const runner = createMockRunner([
        { taskId: "tr-a", taskType: "general", description: "Task A", source: "main", startedAt: 100 },
      ]);

      const result = await task_status.execute(
        {},
        { taskId: "test", taskRegistry: runner },
      );
      expect(result.success).toBe(true);
      const data = result.result as { activeCount: number; totalCount: number };
      expect(data.activeCount).toBe(1);
      expect(data.totalCount).toBe(1);
    });

    it("should return empty list when no tasks are active", async () => {
      const runner = createMockRunner([]);

      const result = await task_status.execute(
        {},
        { taskId: "test", taskRegistry: runner },
      );
      expect(result.success).toBe(true);
      const data = result.result as { tasks: unknown[]; activeCount: number; totalCount: number };
      expect(data.tasks).toHaveLength(0);
      expect(data.activeCount).toBe(0);
      expect(data.totalCount).toBe(0);
    });

    it("should handle runner errors gracefully", async () => {
      const brokenRunner = {
        getStatus() { throw new Error("Runner crashed"); },
        listAll() { throw new Error("Runner crashed"); },
        get activeCount() { return 0; },
      };

      const result = await task_status.execute(
        {},
        { taskId: "test", taskRegistry: brokenRunner },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Runner crashed");
    });
  });

  // ── Unknown registry type ──

  it("should return error for unknown registry type", async () => {
    const unknownRegistry = { someOtherMethod: () => {} };

    const result = await task_status.execute(
      {},
      { taskId: "test", taskRegistry: unknownRegistry },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown task registry type");
  });
});
