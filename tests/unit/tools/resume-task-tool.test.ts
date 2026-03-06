import { describe, it, expect } from "bun:test";
import { resume_task } from "../../../src/tools/builtins/resume-task-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

describe("resume_task tool", () => {
  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      taskRegistry: {
        resume: async (_taskId: string, _input: string) => {},
      },
      tickManager: { start: () => {} },
      ...overrides,
    };
  }

  it("should resume a task and return status", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      taskRegistry: {
        resume: async (taskId: string, input: string) => {
          capturedArgs = [taskId, input];
        },
      },
    });

    const result = await resume_task.execute(
      { task_id: "task-456", input: "continue analysis" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { taskId: string; status: string };
    expect(data.taskId).toBe("task-456");
    expect(data.status).toBe("resumed");

    // Verify resume was called with correct args
    expect(capturedArgs).toEqual(["task-456", "continue analysis"]);
  });

  it("should start tickManager after resuming", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await resume_task.execute(
      { task_id: "task-1", input: "go" },
      ctx,
    );

    expect(tickStarted).toBe(true);
  });

  it("should return error when taskRegistry is not available", async () => {
    const result = await resume_task.execute(
      { task_id: "task-1", input: "go" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("taskRegistry not available");
  });

  it("should handle task not found error", async () => {
    const ctx = makeContext({
      taskRegistry: {
        resume: async () => { throw new Error("Task task-999 not found"); },
      },
    });

    const result = await resume_task.execute(
      { task_id: "task-999", input: "resume" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("task-999 not found");
  });

  it("should handle task still running error", async () => {
    const ctx = makeContext({
      taskRegistry: {
        resume: async () => { throw new Error("Task is still running"); },
      },
    });

    const result = await resume_task.execute(
      { task_id: "task-1", input: "resume" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("still running");
  });

  it("should work without tickManager", async () => {
    const ctx = makeContext({ tickManager: undefined });

    const result = await resume_task.execute(
      { task_id: "task-1", input: "go" },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("should not start tickManager on error", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      taskRegistry: {
        resume: async () => { throw new Error("fail"); },
      },
      tickManager: { start: () => { tickStarted = true; } },
    });

    await resume_task.execute(
      { task_id: "task-1", input: "go" },
      ctx,
    );
    expect(tickStarted).toBe(false);
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await resume_task.execute(
      { task_id: "task-1", input: "go" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(resume_task.name).toBe("resume_task");
    expect(resume_task.description).toContain("Resume");
    expect(resume_task.description).toContain("previously completed task");
    expect(resume_task.category).toBe(ToolCategory.SYSTEM);
  });

  it("should validate required parameters", () => {
    const schema = resume_task.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ task_id: "t-1" }).success).toBe(false);
    expect(schema.safeParse({ input: "x" }).success).toBe(false);
    expect(schema.safeParse({ task_id: "t-1", input: "x" }).success).toBe(true);
  });
});
