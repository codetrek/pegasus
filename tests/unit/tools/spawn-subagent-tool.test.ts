import { describe, it, expect } from "bun:test";
import { spawn_subagent } from "../../../src/tools/builtins/spawn-subagent-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

describe("spawn_subagent tool", () => {
  /** Stub methods that task_status needs but spawn_subagent tests don't care about. */
  const registryStubs = {
    getStatus: () => null,
    listAll: () => [],
    get activeCount() { return 0; },
  } as const;

  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      taskRegistry: {
        submit: (_input: string, _source: string, _type: string, _desc: string, _opts?: unknown) => "sa-001",
        resume: async () => "",
        ...registryStubs,
      },
      tickManager: { start: () => {} },
      getMemorySnapshot: async () => undefined,
      ...overrides,
    };
  }

  it("should spawn a subagent and return subagentId", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      taskRegistry: {
        submit: (input: string, source: string, type: string, desc: string, opts?: { memorySnapshot?: string; depth?: number }) => {
          capturedArgs = [input, source, type, desc, opts];
          return "sa-xyz";
        },
        resume: async () => "",
        ...registryStubs,
      },
      getMemorySnapshot: async () => "memory content here",
    });

    const result = await spawn_subagent.execute(
      { description: "refactor module", input: "Extract helpers" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { subagentId: string; status: string; type: string; description: string };
    expect(data.subagentId).toBe("sa-xyz");
    expect(data.status).toBe("spawned");
    expect(data.type).toBe("general");
    expect(data.description).toBe("refactor module");

    // Verify submit was called with correct args including memory and depth
    expect(capturedArgs[0]).toBe("Extract helpers"); // input
    expect(capturedArgs[1]).toBe("main-agent"); // source (context.taskId)
    expect(capturedArgs[2]).toBe("general"); // type
    expect(capturedArgs[3]).toBe("refactor module"); // description
    const opts = capturedArgs[4] as { memorySnapshot?: string; depth?: number };
    expect(opts.memorySnapshot).toBe("memory content here");
    expect(opts.depth).toBe(1);
  });

  it("should pass type parameter to taskRegistry.submit", async () => {
    let capturedType: string | undefined;
    const ctx = makeContext({
      taskRegistry: {
        submit: (_input: string, _source: string, type: string, _desc: string) => {
          capturedType = type;
          return "sa-typed";
        },
        resume: async () => "",
        ...registryStubs,
      },
    });

    await spawn_subagent.execute(
      { description: "explore task", input: "research X", type: "explore" },
      ctx,
    );

    expect(capturedType).toBe("explore");
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

  it("should return error when taskRegistry is not available", async () => {
    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("taskRegistry not available");
  });

  it("should handle submit errors gracefully", async () => {
    const ctx = makeContext({
      taskRegistry: {
        submit: () => { throw new Error("task limit reached"); },
        resume: async () => "",
        ...registryStubs,
      },
    });

    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("task limit reached");
  });

  it("should work without getMemorySnapshot", async () => {
    let capturedOpts: unknown = "NOT_SET";
    const ctx = makeContext({
      getMemorySnapshot: undefined,
      taskRegistry: {
        submit: (_input: string, _source: string, _type: string, _desc: string, opts?: unknown) => {
          capturedOpts = opts;
          return "sa-1";
        },
        resume: async () => "",
        ...registryStubs,
      },
    });

    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      ctx,
    );
    expect(result.success).toBe(true);
    const opts = capturedOpts as { memorySnapshot?: string; depth?: number };
    expect(opts.memorySnapshot).toBeUndefined();
    expect(opts.depth).toBe(1);
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
    expect(spawn_subagent.description).toContain("sub-agent");
    expect(spawn_subagent.description).toContain("background");
    expect(spawn_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should validate required parameters", () => {
    const schema = spawn_subagent.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ description: "only desc" }).success).toBe(false);
    expect(schema.safeParse({ input: "only input" }).success).toBe(false);
    expect(schema.safeParse({ description: "label", input: "instructions" }).success).toBe(true);
    // type is optional with default
    expect(schema.safeParse({ description: "label", input: "instructions", type: "explore" }).success).toBe(true);
  });
});
