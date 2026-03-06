import { describe, it, expect } from "bun:test";
import { spawn_subagent } from "../../../src/tools/builtins/spawn-subagent-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

describe("spawn_subagent tool", () => {
  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      subAgentManager: {
        spawn: (_desc: string, _input: string, _mem?: string) => "sa-001",
      },
      tickManager: { start: () => {} },
      getMemorySnapshot: async () => undefined,
      ...overrides,
    };
  }

  it("should spawn a subagent and return subagentId", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      subAgentManager: {
        spawn: (desc: string, input: string, mem?: string) => {
          capturedArgs = [desc, input, mem];
          return "sa-xyz";
        },
      },
      getMemorySnapshot: async () => "memory content here",
    });

    const result = await spawn_subagent.execute(
      { description: "refactor module", input: "Extract helpers" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { subagentId: string; status: string; description: string };
    expect(data.subagentId).toBe("sa-xyz");
    expect(data.status).toBe("spawned");
    expect(data.description).toBe("refactor module");

    // Verify spawn was called with correct args including memory
    expect(capturedArgs).toEqual(["refactor module", "Extract helpers", "memory content here"]);
  });

  it("should start tickManager after spawning", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );

    expect(tickStarted).toBe(true);
  });

  it("should return error when subAgentManager is not available", async () => {
    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("SubAgentManager not available");
  });

  it("should handle spawn errors gracefully", async () => {
    const ctx = makeContext({
      subAgentManager: {
        spawn: () => { throw new Error("worker limit reached"); },
      },
    });

    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("worker limit reached");
  });

  it("should work without getMemorySnapshot", async () => {
    let capturedMem: unknown = "NOT_SET";
    const ctx = makeContext({
      getMemorySnapshot: undefined,
      subAgentManager: {
        spawn: (_desc: string, _input: string, mem?: string) => {
          capturedMem = mem;
          return "sa-1";
        },
      },
    });

    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(capturedMem).toBeUndefined();
  });

  it("should work without tickManager", async () => {
    const ctx = makeContext({ tickManager: undefined });

    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await spawn_subagent.execute(
      { description: "timed", input: "test" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(spawn_subagent.name).toBe("spawn_subagent");
    expect(spawn_subagent.description).toContain("SubAgent");
    expect(spawn_subagent.description).toContain("autonomous");
    expect(spawn_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should validate required parameters", () => {
    const schema = spawn_subagent.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ description: "only desc" }).success).toBe(false);
    expect(schema.safeParse({ input: "only input" }).success).toBe(false);
    expect(schema.safeParse({ description: "label", input: "instructions" }).success).toBe(true);
  });
});
