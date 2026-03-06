import { describe, it, expect } from "bun:test";
import { spawn_task } from "../../../src/tools/builtins/spawn-task-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

describe("spawn_task tool", () => {
  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      taskRegistry: {
        submit: (_input: string, _source: string, _type: string, _desc: string) => "task-123",
      },
      tickManager: { start: () => {} },
      ...overrides,
    };
  }

  it("should spawn a task and return taskId", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      taskRegistry: {
        submit: (input: string, source: string, type: string, desc: string) => {
          capturedArgs = [input, source, type, desc];
          return "task-abc";
        },
      },
    });

    const result = await spawn_task.execute(
      { description: "search the web", input: "find weather in Beijing", type: "explore" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { taskId: string; status: string; type: string; description: string };
    expect(data.taskId).toBe("task-abc");
    expect(data.status).toBe("spawned");
    expect(data.type).toBe("explore");
    expect(data.description).toBe("search the web");

    // Verify submit was called with correct args
    expect(capturedArgs).toEqual(["find weather in Beijing", "main-agent", "explore", "search the web"]);
  });

  it("should start tickManager after spawning", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await spawn_task.execute(
      { description: "test", input: "test input" },
      ctx,
    );

    expect(tickStarted).toBe(true);
  });

  it("should default type to general when not specified", async () => {
    const result = await spawn_task.execute(
      { description: "test", input: "test" },
      makeContext(),
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("general");
  });

  it("should pass through explicit type", async () => {
    const result = await spawn_task.execute(
      { description: "research", input: "find papers", type: "explore" },
      makeContext(),
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("explore");
  });

  it("should accept plan type", async () => {
    const result = await spawn_task.execute(
      { description: "plan", input: "analyze codebase", type: "plan" },
      makeContext(),
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("plan");
  });

  it("should return error when taskRegistry is not available", async () => {
    const result = await spawn_task.execute(
      { description: "test", input: "test" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("taskRegistry not available");
  });

  it("should handle taskRegistry errors gracefully", async () => {
    const ctx = makeContext({
      taskRegistry: {
        submit: () => { throw new Error("runner is full"); },
      },
    });

    const result = await spawn_task.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("runner is full");
  });

  it("should work without tickManager (graceful degradation)", async () => {
    const ctx = makeContext({ tickManager: undefined });

    const result = await spawn_task.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("should use taskId from context as source", async () => {
    let capturedSource = "";
    const ctx: ToolContext = {
      taskId: "ctx-456",
      taskRegistry: {
        submit: (_input: string, source: string) => { capturedSource = source; return "t-1"; },
      },
    };

    await spawn_task.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(capturedSource).toBe("ctx-456");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await spawn_task.execute(
      { description: "timed", input: "test" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(spawn_task.name).toBe("spawn_task");
    expect(spawn_task.description).toContain("background task");
    expect(spawn_task.category).toBe(ToolCategory.SYSTEM);
  });
});
