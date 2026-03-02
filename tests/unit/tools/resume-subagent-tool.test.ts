import { describe, it, expect } from "bun:test";
import { resume_subagent } from "../../../src/tools/builtins/resume-subagent-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("resume_subagent tool", () => {
  it("should return resume intent with subagent_id and input", async () => {
    const result = await resume_subagent.execute(
      { subagent_id: "sa-001", input: "continue with phase 2" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      subagent_id: string;
      input: string;
    };
    expect(data.action).toBe("resume_subagent");
    expect(data.subagent_id).toBe("sa-001");
    expect(data.input).toBe("continue with phase 2");
  });

  it("should have correct tool metadata", () => {
    expect(resume_subagent.name).toBe("resume_subagent");
    expect(resume_subagent.description).toContain("Resume");
    expect(resume_subagent.description).toContain("SubAgent");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await resume_subagent.execute(
      { subagent_id: "sa-002", input: "resume test" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(resume_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should have subagent_id and input in parameters schema", () => {
    const schema = resume_subagent.parameters;
    const parsed = schema.safeParse({ subagent_id: "sa-123", input: "new instructions" });
    expect(parsed.success).toBe(true);
  });

  it("should reject missing required parameters", () => {
    const schema = resume_subagent.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ subagent_id: "sa-123" }).success).toBe(false);
    expect(schema.safeParse({ input: "only input" }).success).toBe(false);
  });

  it("should not include taskId in result (unlike spawn)", async () => {
    const result = await resume_subagent.execute(
      { subagent_id: "sa-003", input: "test" },
      { taskId: "ctx-789" },
    );
    const data = result.result as Record<string, unknown>;
    expect(data).not.toHaveProperty("taskId");
  });
});
