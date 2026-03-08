import { describe, it, expect } from "bun:test";
import { reload_skills } from "../../../src/agents/tools/builtins/reload-skills-tool.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";

describe("reload_skills tool", () => {
  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      onSkillsReloaded: () => 5,
      ...overrides,
    };
  }

  it("should call onSkillsReloaded and return skill count", async () => {
    let called = false;
    const ctx = makeContext({
      onSkillsReloaded: () => { called = true; return 12; },
    });

    const result = await reload_skills.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(called).toBe(true);
    const data = result.result as { reloaded: boolean; skillCount: number };
    expect(data.reloaded).toBe(true);
    expect(data.skillCount).toBe(12);
  });

  it("should return error when onSkillsReloaded is not available", async () => {
    const result = await reload_skills.execute({}, { taskId: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("onSkillsReloaded not available");
  });

  it("should handle callback errors gracefully", async () => {
    const ctx = makeContext({
      onSkillsReloaded: () => { throw new Error("disk read failure"); },
    });

    const result = await reload_skills.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk read failure");
  });

  it("should return zero skill count when registry is empty", async () => {
    const ctx = makeContext({
      onSkillsReloaded: () => 0,
    });

    const result = await reload_skills.execute({}, ctx);
    expect(result.success).toBe(true);
    const data = result.result as { skillCount: number };
    expect(data.skillCount).toBe(0);
  });

  it("should include timing metadata", async () => {
    const before = Date.now();
    const result = await reload_skills.execute({}, makeContext());
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(reload_skills.name).toBe("reload_skills");
    expect(reload_skills.description).toContain("skill");
    expect(reload_skills.category).toBe(ToolCategory.SYSTEM);
  });
});
