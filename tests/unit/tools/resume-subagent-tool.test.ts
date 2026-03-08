import { describe, it, expect } from "bun:test";
import { resume_subagent } from "../../../src/agents/tools/builtins/resume-subagent-tool.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";

describe("resume_subagent tool", () => {
  /** Stub methods that other tools need but resume_subagent tests don't care about. */
  const registryStubs = {
    getStatus: () => null,
    listAll: () => [],
    get activeCount() { return 0; },
  } as const;

  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      taskRegistry: {
        submit: () => "",
        resume: async (_id: string, _input: string) => "sa-001",
        ...registryStubs,
      },
      tickManager: { start: () => {} },
      ...overrides,
    };
  }

  it("should resume a subagent and return status", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      taskRegistry: {
        submit: () => "",
        resume: async (id: string, input: string) => {
          capturedArgs = [id, input];
          return id;
        },
        ...registryStubs,
      },
    });

    const result = await resume_subagent.execute(
      { subagent_id: "sa-001", input: "continue with phase 2" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { subagentId: string; status: string };
    expect(data.subagentId).toBe("sa-001");
    expect(data.status).toBe("resumed");

    // Verify resume was called with correct args
    expect(capturedArgs).toEqual(["sa-001", "continue with phase 2"]);
  });

  it("should start tickManager after resuming", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await resume_subagent.execute(
      { subagent_id: "sa-1", input: "go" },
      ctx,
    );

    expect(tickStarted).toBe(true);
  });

  it("should return error when taskRegistry is not available", async () => {
    const result = await resume_subagent.execute(
      { subagent_id: "sa-1", input: "go" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("taskRegistry not available");
  });

  it("should handle subagent not found error", async () => {
    const ctx = makeContext({
      taskRegistry: {
        submit: () => "",
        resume: async () => { throw new Error("Task sa-999 not found in task index"); },
        ...registryStubs,
      },
    });

    const result = await resume_subagent.execute(
      { subagent_id: "sa-999", input: "resume" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("sa-999 not found");
  });

  it("should handle subagent still running error", async () => {
    const ctx = makeContext({
      taskRegistry: {
        submit: () => "",
        resume: async () => { throw new Error("Task is still running, cannot resume"); },
        ...registryStubs,
      },
    });

    const result = await resume_subagent.execute(
      { subagent_id: "sa-1", input: "resume" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("still running");
  });

  it("should work without tickManager", async () => {
    const ctx = makeContext({ tickManager: undefined });

    const result = await resume_subagent.execute(
      { subagent_id: "sa-1", input: "go" },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("should not start tickManager on error", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      taskRegistry: {
        submit: () => "",
        resume: async () => { throw new Error("fail"); },
        ...registryStubs,
      },
      tickManager: { start: () => { tickStarted = true; } },
    });

    await resume_subagent.execute(
      { subagent_id: "sa-1", input: "go" },
      ctx,
    );
    expect(tickStarted).toBe(false);
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await resume_subagent.execute(
      { subagent_id: "sa-1", input: "test" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(resume_subagent.name).toBe("resume_subagent");
    expect(resume_subagent.description).toContain("Resume");
    expect(resume_subagent.description).toContain("sub-agent");
    expect(resume_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should validate required parameters", () => {
    const schema = resume_subagent.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ subagent_id: "sa-123" }).success).toBe(false);
    expect(schema.safeParse({ input: "only input" }).success).toBe(false);
    expect(schema.safeParse({ subagent_id: "sa-123", input: "new instructions" }).success).toBe(true);
  });
});
