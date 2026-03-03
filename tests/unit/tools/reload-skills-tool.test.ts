import { describe, expect, test } from "bun:test";
import { reload_skills } from "@pegasus/tools/builtins/reload-skills-tool.ts";
import { ToolCategory } from "@pegasus/tools/types.ts";

describe("reload_skills tool", () => {
  test("returns signal with action reload_skills", async () => {
    const result = await reload_skills.execute({}, { taskId: "test" });

    expect(result.success).toBe(true);
    const data = result.result as { action: string };
    expect(data.action).toBe("reload_skills");
  });

  test("includes timing metadata", async () => {
    const result = await reload_skills.execute({}, { taskId: "test" });

    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("has correct tool metadata", () => {
    expect(reload_skills.name).toBe("reload_skills");
    expect(reload_skills.description).toContain("skill");
    expect(reload_skills.category).toBe(ToolCategory.SYSTEM);
  });
});
