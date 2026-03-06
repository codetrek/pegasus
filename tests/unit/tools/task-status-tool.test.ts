/**
 * Tests for task_status tool — runtime task state query.
 * Covers the TaskRunner interface.
 */
import { describe, it, expect } from "bun:test";
import { task_status } from "../../../src/tools/builtins/task-status-tool.ts";

describe("task_status", () => {
  it("should return error when taskRegistry is not in context", async () => {
    const result = await task_status.execute({}, { taskId: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TaskRunner not available");
  });

  // ── TaskRunner interface tests ──

  describe("TaskRunner interface", () => {
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
