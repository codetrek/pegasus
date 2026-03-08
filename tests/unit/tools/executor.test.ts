/**
 * Unit tests for ToolExecutor.
 */

import { describe, it, expect, mock } from "bun:test";
import { ToolExecutor } from "../../../src/agents/tools/executor.ts";
import type { Tool, ToolContext, ToolCategory } from "../../../src/agents/tools/types.ts";
import { z } from "zod";

describe("ToolExecutor", () => {
  it("should execute a tool successfully", async () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };

    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: z.object({}),
      execute: async () => ({
        success: true,
        result: { test: "result" },
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 10,
      }),
    };

    const registry = {
      get: mock(() => tool),
      updateCallStats: mock(() => {}),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    const context: ToolContext = { agentId: "test-task-id" };

    const result = await executor.execute("test_tool", {}, context);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ test: "result" });
    // execute() only emits TOOL_CALL_REQUESTED; COMPLETED is emitted via emitCompletion()
    expect(events).toHaveLength(1); // REQUESTED only
  });

  it("should handle tool not found", async () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };

    const registry = {
      get: mock(() => undefined),
      updateCallStats: mock(() => {}),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    const context: ToolContext = { agentId: "test-task-id" };

    const result = await executor.execute("unknown_tool", {}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    // execute() only emits TOOL_CALL_REQUESTED; FAILED is emitted via emitCompletion()
    expect(events).toHaveLength(1); // REQUESTED only
  });

  it("should handle tool timeout", async () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };

    const tool: Tool = {
      name: "slow_tool",
      description: "Slow tool",
      category: "system" as ToolCategory,
      parameters: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return {
          success: true,
          startedAt: Date.now(),
        };
      },
    };

    const registry = {
      get: mock(() => tool),
      updateCallStats: mock(() => {}),
    };

    const executor = new ToolExecutor(registry, mockBus, 100); // 100ms timeout
    const context: ToolContext = { agentId: "test-task-id" };

    const result = await executor.execute("slow_tool", {}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.durationMs).toBeGreaterThanOrEqual(90); // Allow small timer jitter
    expect(result.durationMs).toBeLessThan(500); // Should timeout quickly
    // execute() only emits TOOL_CALL_REQUESTED; FAILED is emitted via emitCompletion()
    expect(events).toHaveLength(1); // REQUESTED only
  });

  it("should update call statistics on success", async () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };

    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: z.object({}),
      execute: async () => ({
        success: true,
        result: "ok",
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 50,
      }),
    };

    const statsUpdates: unknown[] = [];
    const registry = {
      get: mock(() => tool),
      updateCallStats: mock((name, duration, success) => {
        statsUpdates.push({ name, duration, success });
      }),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    const context: ToolContext = { agentId: "test-task-id" };

    await executor.execute("test_tool", {}, context);

    expect(statsUpdates).toHaveLength(1);
    expect(statsUpdates[0]).toEqual({ name: "test_tool", duration: 50, success: true });
  });

  it("should update call statistics on failure", async () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };

    const tool: Tool = {
      name: "failing_tool",
      description: "Failing tool",
      category: "system" as ToolCategory,
      parameters: z.object({}),
      execute: async () => {
        throw new Error("Tool failed");
      },
    };

    const statsUpdates: unknown[] = [];
    const registry = {
      get: mock(() => tool),
      updateCallStats: mock((name, duration, success) => {
        statsUpdates.push({ name, duration, success });
      }),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    const context: ToolContext = { agentId: "test-task-id" };

    await executor.execute("failing_tool", {}, context);

    expect(statsUpdates).toHaveLength(1);
    expect(statsUpdates[0]).toEqual({ name: "failing_tool", duration: expect.any(Number), success: false });
  });

  it("emitCompletion emits TOOL_CALL_COMPLETED for success", () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };
    const registry = {
      get: mock(() => undefined),
      updateCallStats: mock(() => {}),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    executor.emitCompletion(
      "test_tool",
      { success: true, result: { data: 1 }, startedAt: 0, completedAt: 10, durationMs: 10 },
      { agentId: "task-1" },
    );

    expect(events).toHaveLength(1);
    const event = events[0] as { type: number; payload: Record<string, unknown> };
    expect(event.type).toBe(410); // TOOL_CALL_COMPLETED
    expect(event.payload).toMatchObject({ toolName: "test_tool", result: { data: 1 } });
  });

  it("emitCompletion emits TOOL_CALL_FAILED for failure", () => {
    const events: unknown[] = [];
    const mockBus = {
      emit: (event: unknown) => { events.push(event); },
    };
    const registry = {
      get: mock(() => undefined),
      updateCallStats: mock(() => {}),
    };

    const executor = new ToolExecutor(registry, mockBus, 10000);
    executor.emitCompletion(
      "test_tool",
      { success: false, error: "boom", startedAt: 0, completedAt: 10, durationMs: 10 },
      { agentId: "task-1" },
    );

    expect(events).toHaveLength(1);
    const event = events[0] as { type: number; payload: Record<string, unknown> };
    expect(event.type).toBe(420); // TOOL_CALL_FAILED
    expect(event.payload).toMatchObject({ toolName: "test_tool", error: "boom" });
  });
});
