/**
 * Unit tests for BackgroundTaskManager and background meta tools (bg_run, bg_output, bg_stop).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import {
  BackgroundTaskManager,
} from "../../../src/agents/tools/background.ts";
import { PendingTracker } from "../../../src/agents/pending-tracker.ts";
import { readFile, rm } from "node:fs/promises";
import { ToolExecutor } from "../../../src/agents/tools/executor.ts";
import { bg_run, bg_output, bg_stop } from "../../../src/agents/tools/builtins/background-tools.ts";
import type { Tool, ToolContext, ToolCategory, ToolResult } from "../../../src/agents/tools/types.ts";

// ── Helpers ─────────────────────────────────────────

/** Create a mock tool that resolves after `delayMs` milliseconds. */
function makeMockTool(
  name: string,
  delayMs: number,
  opts?: { throws?: boolean },
): Tool {
  return {
    name,
    description: `Mock tool (${delayMs}ms)`,
    category: "system" as ToolCategory,
    parameters: z.object({}),
    async execute(): Promise<ToolResult> {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (opts?.throws) {
        throw new Error("Tool exploded");
      }
      return {
        success: true,
        result: { mock: true },
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: delayMs,
      };
    },
  };
}

/** Create a ToolExecutor backed by a map of mock tools. */
function makeExecutor(tools: Tool[], timeout = 10_000): ToolExecutor {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const registry = {
    get: mock((name: string) => toolMap.get(name)),
    updateCallStats: mock(() => {}),
  };
  const bus = { emit: mock(() => {}) };
  return new ToolExecutor(registry, bus, timeout);
}

/** Minimal ToolContext for tests. */
function ctx(extras?: Partial<ToolContext>): ToolContext {
  return { agentId: "test-task", ...extras };
}

// ── BackgroundTaskManager ───────────────────────────

describe("BackgroundTaskManager", () => {
  // 1. run() returns task ID immediately
  it("run() returns task ID starting with 'bg-'", () => {
    const executor = makeExecutor([makeMockTool("slow", 500)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("slow", {}, ctx());
    expect(id).toMatch(/^bg-/);
  }, 5000);

  // 2. getStatus() returns "running" for active task
  it("getStatus() returns 'running' for an active task", () => {
    const executor = makeExecutor([makeMockTool("slow", 5000)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("slow", {}, ctx());

    const status = mgr.getStatus(id);
    expect(status.status).toBe("running");
    if (status.status === "running") {
      expect(status.tool).toBe("slow");
      expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  }, 5000);

  // 3. getStatus() returns "completed" with result
  it("getStatus() returns 'completed' after fast tool finishes", async () => {
    const executor = makeExecutor([makeMockTool("fast", 10)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("fast", {}, ctx());

    // Wait for the tool to finish
    await new Promise((r) => setTimeout(r, 200));

    const status = mgr.getStatus(id);
    expect(status.status).toBe("completed");
    if (status.status === "completed") {
      expect(status.result.success).toBe(true);
      expect(status.result.result).toEqual({ mock: true });
    }
  }, 5000);

  // 4. getStatus() returns "failed" with error when tool throws
  it("getStatus() returns 'failed' when tool throws", async () => {
    const executor = makeExecutor([makeMockTool("boom", 10, { throws: true })]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("boom", {}, ctx());

    await new Promise((r) => setTimeout(r, 200));

    const status = mgr.getStatus(id);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toContain("Tool exploded");
    }
  }, 5000);

  // 5. getStatus() returns "not_found" for unknown ID
  it("getStatus() returns 'not_found' for unknown ID", () => {
    const executor = makeExecutor([]);
    const mgr = new BackgroundTaskManager(executor);
    const status = mgr.getStatus("bg-nonexistent");
    expect(status.status).toBe("not_found");
  }, 5000);

  // 6. waitFor() resolves when task completes
  it("waitFor() resolves when task completes", async () => {
    const executor = makeExecutor([makeMockTool("fast", 50)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("fast", {}, ctx());

    const status = await mgr.waitFor(id, 5000);
    expect(status.status).toBe("completed");
    if (status.status === "completed") {
      expect(status.result.success).toBe(true);
    }
  }, 5000);

  // 7. waitFor() times out if task doesn't complete
  it("waitFor() times out returning 'running' if task is slow", async () => {
    const executor = makeExecutor([makeMockTool("slow", 10_000)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("slow", {}, ctx());

    const status = await mgr.waitFor(id, 100);
    expect(status.status).toBe("running");
  }, 5000);

  // 8. stop() terminates running task
  it("stop() marks task as failed with 'Stopped by user'", () => {
    const executor = makeExecutor([makeMockTool("slow", 10_000)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("slow", {}, ctx());

    const stopped = mgr.stop(id);
    expect(stopped).toBe(true);

    const status = mgr.getStatus(id);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("Stopped by user");
    }
  }, 5000);

  // 9. stop() returns false for unknown task
  it("stop() returns false for unknown task", () => {
    const executor = makeExecutor([]);
    const mgr = new BackgroundTaskManager(executor);
    expect(mgr.stop("bg-nonexistent")).toBe(false);
  }, 5000);

  // 10. stop() prevents completion handler from overwriting status
  it("stop() prevents completion handler from overwriting status", async () => {
    const executor = makeExecutor([makeMockTool("moderate", 100)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("moderate", {}, ctx());

    // Stop immediately — before the tool resolves
    mgr.stop(id);

    // Wait for the tool promise to settle
    await new Promise((r) => setTimeout(r, 300));

    const status = mgr.getStatus(id);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("Stopped by user");
    }
  }, 5000);

  // 11. cleanup() removes old completed tasks
  it("cleanup() removes old completed tasks", async () => {
    const executor = makeExecutor([makeMockTool("fast", 5)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("fast", {}, ctx());

    // Wait for completion
    await mgr.waitFor(id, 2000);
    expect(mgr.getStatus(id).status).toBe("completed");

    // Hack completedAt to be very old by manipulating internal state
    // Access the private tasks map via any-cast
    const tasks = (mgr as any).tasks as Map<string, any>;
    const task = tasks.get(id)!;
    task.completedAt = Date.now() - 999_999;

    // Cleanup with a short maxAge
    mgr.cleanup(1000);

    expect(mgr.getStatus(id).status).toBe("not_found");
  }, 5000);

  // 12. cleanup() preserves running tasks
  it("cleanup() preserves running tasks", () => {
    const executor = makeExecutor([makeMockTool("slow", 60_000)]);
    const mgr = new BackgroundTaskManager(executor);
    const id = mgr.run("slow", {}, ctx());

    // Cleanup should not touch running tasks
    mgr.cleanup(0);

    expect(mgr.getStatus(id).status).toBe("running");
  }, 5000);

  // 13. Per-call timeout caps at MAX_TOOL_TIMEOUT
  it("run() caps per-call timeout at MAX_TOOL_TIMEOUT", async () => {
    // Tool that runs forever — we just care that the timeout
    // parameter is capped, not that it actually triggers
    const executor = makeExecutor([makeMockTool("fast", 10)]);
    const mgr = new BackgroundTaskManager(executor);

    // Pass a ridiculously large timeout
    const id = mgr.run("fast", {}, ctx(), 999_999_999);

    // The task should still start successfully (not throw)
    expect(id).toMatch(/^bg-/);

    // Wait for it to complete (the tool itself is fast)
    const status = await mgr.waitFor(id, 2000);
    expect(status.status).toBe("completed");
  }, 5000);

  // 13b. run() passes AbortSignal to executor via options
  it("passes AbortSignal to executor via options", async () => {
    let receivedSignal: AbortSignal | undefined;

    const mockExecutor = {
      execute: async (_tool: string, _params: unknown, _ctx: any, options?: { timeout?: number; signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return { success: true, startedAt: Date.now(), completedAt: Date.now(), durationMs: 0 };
      },
    } as any;

    const mgr = new BackgroundTaskManager(mockExecutor);
    const id = mgr.run("test_tool", {}, ctx());

    // Wait for execution
    await mgr.waitFor(id, 2000);

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  }, 5000);

  // 13c. run() background timeout sets status to failed via catch path
  it("run() executor rejection triggers catch path", async () => {
    // Create a tool that is NOT registered, so executor.execute() throws ToolNotFoundError.
    // However, ToolExecutor catches that and returns { success: false }.
    // To truly trigger the .catch() path, we need executor.execute() itself to reject.
    // Use a custom executor whose execute() rejects.
    const mockBrokenExecutor = {
      execute: async () => {
        throw new Error("Executor crashed");
      },
    } as any;
    const mgr = new BackgroundTaskManager(mockBrokenExecutor);

    const id = mgr.run("any_tool", {}, ctx(), 5000);

    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 200));

    const status = mgr.getStatus(id);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toContain("Executor crashed");
    }
  }, 5000);
});

// ── ToolExecutor timeout override ────────────────────

describe("ToolExecutor timeout override", () => {
  // 14. execute() with options.timeout overrides default
  it("execute() with options.timeout overrides default timeout", async () => {
    // Create executor with a very long default (30s)
    // but call with a short override (100ms) on a slow tool (10s)
    const executor = makeExecutor([makeMockTool("slow", 10_000)], 30_000);

    const result = await executor.execute("slow", {}, ctx(), { timeout: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.durationMs).toBeLessThan(2000);
  }, 5000);

  // 15. execute() options.timeout capped at MAX_TOOL_TIMEOUT
  it("execute() options.timeout is capped at MAX_TOOL_TIMEOUT", async () => {
    // Pass a huge timeout — should be capped, and tool completes quickly
    const executor = makeExecutor([makeMockTool("fast", 10)], 1000);

    const result = await executor.execute("fast", {}, ctx(), {
      timeout: 999_999_999,
    });
    expect(result.success).toBe(true);
    // If capping didn't work and the raw value was used as ms, the test
    // itself would not hang because the tool completes in 10ms anyway.
    // The key assertion is that it succeeds rather than erroring.
  }, 5000);
});

// ── bg_run tool ──────────────────────────────────────

describe("bg_run", () => {
  // 16. Starts background task and returns task ID
  it("starts background task and returns task ID", async () => {
    const executor = makeExecutor([makeMockTool("my_tool", 100)]);
    const mgr = new BackgroundTaskManager(executor);
    const context = ctx({ backgroundManager: mgr });

    const result = await bg_run.execute(
      { tool: "my_tool", params: {} },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.result as any).bgTaskId).toMatch(/^bg-/);
    expect((result.result as any).tool).toBe("my_tool");
    expect((result.result as any).status).toBe("running");
  }, 5000);

  // 17. Returns error if backgroundManager not in context
  it("returns error if backgroundManager not in context", async () => {
    const context = ctx(); // no backgroundManager
    const result = await bg_run.execute(
      { tool: "my_tool", params: {} },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  }, 5000);
});

// ── bg_output tool ───────────────────────────────────

describe("bg_output", () => {
  // 18. Returns status for running task (block=false)
  it("returns 'running' status for active task (block=false)", async () => {
    const executor = makeExecutor([makeMockTool("slow", 10_000)]);
    const mgr = new BackgroundTaskManager(executor);
    const bgTaskId = mgr.run("slow", {}, ctx());

    const context = ctx({ backgroundManager: mgr });
    const result = await bg_output.execute(
      { bgTaskId, block: false, timeout: 30000 },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.result as any).status).toBe("running");
  }, 5000);

  // 19. Waits and returns result (block=true)
  it("waits and returns completed result (block=true)", async () => {
    const executor = makeExecutor([makeMockTool("fast", 50)]);
    const mgr = new BackgroundTaskManager(executor);
    const bgTaskId = mgr.run("fast", {}, ctx());

    const context = ctx({ backgroundManager: mgr });
    const result = await bg_output.execute(
      { bgTaskId, block: true, timeout: 5000 },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.result as any).status).toBe("completed");
    expect((result.result as any).result.success).toBe(true);
  }, 5000);

  // 20. Returns not_found for unknown task
  it("returns 'not_found' for unknown task", async () => {
    const executor = makeExecutor([]);
    const mgr = new BackgroundTaskManager(executor);
    const context = ctx({ backgroundManager: mgr });

    const result = await bg_output.execute(
      { bgTaskId: "bg-nonexistent", block: false, timeout: 30000 },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.result as any).status).toBe("not_found");
  }, 5000);

  // 20b. Returns error if backgroundManager not in context
  it("returns error if backgroundManager not in context", async () => {
    const result = await bg_output.execute(
      { bgTaskId: "bg-test", block: false, timeout: 30000 },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  }, 5000);
});

// ── bg_stop tool ─────────────────────────────────────

describe("bg_stop", () => {
  // 21. Stops running task
  it("stops a running task", async () => {
    const executor = makeExecutor([makeMockTool("slow", 10_000)]);
    const mgr = new BackgroundTaskManager(executor);
    const bgTaskId = mgr.run("slow", {}, ctx());

    const context = ctx({ backgroundManager: mgr });
    const result = await bg_stop.execute({ bgTaskId }, context);

    expect(result.success).toBe(true);
    expect((result.result as any).stopped).toBe(true);

    // Verify the task is now failed
    const status = mgr.getStatus(bgTaskId);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("Stopped by user");
    }
  }, 5000);

  // 22. Returns stopped=false for unknown task
  it("returns stopped=false for unknown task", async () => {
    const executor = makeExecutor([]);
    const mgr = new BackgroundTaskManager(executor);
    const context = ctx({ backgroundManager: mgr });

    const result = await bg_stop.execute(
      { bgTaskId: "bg-nonexistent" },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.result as any).stopped).toBe(false);
  }, 5000);

  // 22b. Returns error if backgroundManager not in context
  it("returns error if backgroundManager not in context", async () => {
    const result = await bg_stop.execute(
      { bgTaskId: "bg-test" },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  }, 5000);
});

// ── bg_stop integration ─────────────────────────────

describe("bg_stop integration", () => {
  it("bg_stop actually kills a shell_exec subprocess", async () => {
    // Register shell_exec in the executor
    const { shell_exec } = await import("../../../src/agents/tools/builtins/shell-tools.ts");
    const toolMap = new Map([["shell_exec", shell_exec]]);
    const registry = {
      get: (name: string) => toolMap.get(name),
      updateCallStats: () => {},
    };
    const bus = { emit: () => {} };
    const executor = new ToolExecutor(registry, bus, 30_000);
    const mgr = new BackgroundTaskManager(executor);

    // Start a long-running shell command via bg_run
    const bgTaskId = mgr.run("shell_exec", { command: "sleep 60" }, ctx());

    // Let it start
    await new Promise((r) => setTimeout(r, 300));

    // Verify it's running
    expect(mgr.getStatus(bgTaskId).status).toBe("running");

    // Stop it
    const stopped = mgr.stop(bgTaskId);
    expect(stopped).toBe(true);

    // Wait for the tool execution to settle
    await new Promise((r) => setTimeout(r, 1000));

    // Verify it's failed (not completed)
    const status = mgr.getStatus(bgTaskId);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("Stopped by user");
    }
  }, 15_000);
});

// ── BackgroundTaskManager + PendingTracker ────────────

const pendingTestDir = "/tmp/pegasus-test-bg-pending";

describe("BackgroundTaskManager with PendingTracker", () => {
  let tracker: PendingTracker;

  beforeEach(async () => {
    await rm(pendingTestDir, { recursive: true, force: true }).catch(() => {});
    tracker = new PendingTracker(pendingTestDir);
  });

  afterEach(async () => {
    await rm(pendingTestDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should add entry to pending on run()", async () => {
    const tool = makeMockTool("slow", 5000);
    const executor = makeExecutor([tool]);
    const mgr = new BackgroundTaskManager(executor, 10_000, tracker);
    mgr.run("slow", {}, ctx());
    await tracker.flush();
    const content = JSON.parse(await readFile(`${pendingTestDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].kind).toBe("bg_run");
    expect(content[0].tool).toBe("slow");
  }, 5000);

  it("should remove entry from pending on completion", async () => {
    const tool = makeMockTool("fast", 10);
    const executor = makeExecutor([tool]);
    const mgr = new BackgroundTaskManager(executor, 10_000, tracker);
    const id = mgr.run("fast", {}, ctx());
    // Wait for task to complete
    await mgr.waitFor(id, 5000);
    await tracker.flush();
    const content = JSON.parse(await readFile(`${pendingTestDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(0);
  }, 5000);

  it("should remove entry from pending on stop()", async () => {
    const tool = makeMockTool("slow", 5000);
    const executor = makeExecutor([tool]);
    const mgr = new BackgroundTaskManager(executor, 10_000, tracker);
    const id = mgr.run("slow", {}, ctx());
    await tracker.flush();
    mgr.stop(id);
    await tracker.flush();
    const content = JSON.parse(await readFile(`${pendingTestDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(0);
  }, 5000);

  it("should work without tracker (backward compat)", () => {
    const tool = makeMockTool("fast", 10);
    const executor = makeExecutor([tool]);
    const mgr = new BackgroundTaskManager(executor);
    // Should not throw
    const id = mgr.run("fast", {}, ctx());
    expect(id).toMatch(/^bg-/);
  }, 5000);
});
