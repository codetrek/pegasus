import { describe, it, expect } from "bun:test";
import { spawn_subagent } from "../../../src/tools/builtins/spawn-subagent-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("spawn_subagent tool", () => {
  it("should return subagent intent with description and input", async () => {
    const result = await spawn_subagent.execute(
      { description: "refactor module", input: "Extract helper functions into utils" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      description: string;
      input: string;
    };
    expect(data.action).toBe("spawn_subagent");
    expect(data.description).toBe("refactor module");
    expect(data.input).toBe("Extract helper functions into utils");
  });

  it("should have correct tool metadata", () => {
    expect(spawn_subagent.name).toBe("spawn_subagent");
    expect(spawn_subagent.description).toContain("SubAgent");
    expect(spawn_subagent.description).toContain("autonomous");
  });

  it("should include taskId from context", async () => {
    const result = await spawn_subagent.execute(
      { description: "test subagent", input: "test input" },
      { taskId: "ctx-456" },
    );
    const data = result.result as { taskId: string };
    expect(data.taskId).toBe("ctx-456");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await spawn_subagent.execute(
      { description: "timed", input: "test" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(spawn_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should have description and input in parameters schema", () => {
    const schema = spawn_subagent.parameters;
    const parsed = schema.safeParse({ description: "label", input: "instructions" });
    expect(parsed.success).toBe(true);
  });

  it("should reject missing required parameters", () => {
    const schema = spawn_subagent.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ description: "only desc" }).success).toBe(false);
    expect(schema.safeParse({ input: "only input" }).success).toBe(false);
  });
});
