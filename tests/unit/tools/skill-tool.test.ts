import { describe, it, expect } from "bun:test";
import { use_skill } from "../../../src/agents/tools/builtins/skill-tool.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";

describe("use_skill tool", () => {
  /** Stub methods that other tools need but skill tests don't care about. */
  const registryStubs = {
    getStatus: () => null,
    listAll: () => [],
    get activeCount() { return 0; },
  } as const;

  function makeSkillRegistry(skills: Record<string, { context?: string; agent?: string; body?: string }>) {
    return {
      get: (name: string) => {
        const s = skills[name];
        if (!s) return undefined;
        return { name, context: s.context, agent: s.agent };
      },
      loadBody: (name: string, _args?: string) => {
        const s = skills[name];
        return s?.body ?? null;
      },
    };
  }

  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      skillRegistry: makeSkillRegistry({
        "code-review": { body: "Review the code for quality..." },
        "deploy": { context: "fork", agent: "general", body: "Deploy to production..." },
      }),
      taskRegistry: {
        submit: (_input: string, _source: string, _type: string, _desc: string) => "task-skill-1",
        resume: async () => "",
        ...registryStubs,
      },
      tickManager: { start: () => {} },
      ...overrides,
    };
  }

  it("should return skill body for inline skill", async () => {
    const result = await use_skill.execute(
      { skill: "code-review", args: "PR #42" },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("Review the code for quality...");
  });

  it("should fork skill as background task", async () => {
    let capturedArgs: unknown[] = [];
    const ctx = makeContext({
      taskRegistry: {
        submit: (input: string, source: string, type: string, desc: string) => {
          capturedArgs = [input, source, type, desc];
          return "task-fork-1";
        },
        resume: async () => "",
        ...registryStubs,
      },
    });

    const result = await use_skill.execute(
      { skill: "deploy" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { taskId: string; status: string; skill: string };
    expect(data.taskId).toBe("task-fork-1");
    expect(data.status).toBe("spawned");
    expect(data.skill).toBe("deploy");

    // Verify submit was called correctly
    expect(capturedArgs).toEqual(["Deploy to production...", "skill:deploy", "general", "Skill: deploy"]);
  });

  it("should start tickManager for fork skills", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await use_skill.execute({ skill: "deploy" }, ctx);
    expect(tickStarted).toBe(true);
  });

  it("should NOT start tickManager for inline skills", async () => {
    let tickStarted = false;
    const ctx = makeContext({
      tickManager: { start: () => { tickStarted = true; } },
    });

    await use_skill.execute({ skill: "code-review" }, ctx);
    expect(tickStarted).toBe(false);
  });

  it("should return error for unknown skill", async () => {
    const result = await use_skill.execute(
      { skill: "nonexistent" },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("nonexistent");
    expect(result.error).toContain("not found");
  });

  it("should return error when skillRegistry is not available", async () => {
    const result = await use_skill.execute(
      { skill: "test" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("skillRegistry not available");
  });

  it("should return error when taskRegistry missing for fork skill", async () => {
    const ctx = makeContext({ taskRegistry: undefined });

    const result = await use_skill.execute(
      { skill: "deploy" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("taskRegistry not available");
  });

  it("should handle null body for inline skill", async () => {
    const ctx = makeContext({
      skillRegistry: makeSkillRegistry({
        "empty-skill": { body: undefined as any },
      }),
    });

    const result = await use_skill.execute(
      { skill: "empty-skill" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("could not be loaded");
  });

  it("should use skill.agent as task type for fork", async () => {
    let capturedType = "";
    const ctx = makeContext({
      skillRegistry: makeSkillRegistry({
        "explore-skill": { context: "fork", agent: "explore", body: "go" },
      }),
      taskRegistry: {
        submit: (_input: string, _source: string, type: string, _desc: string) => {
          capturedType = type;
          return "t-1";
        },
        resume: async () => "",
        ...registryStubs,
      },
    });

    await use_skill.execute({ skill: "explore-skill" }, ctx);
    expect(capturedType).toBe("explore");
  });

  it("should default to general type when skill.agent is not set for fork", async () => {
    let capturedType = "";
    const ctx = makeContext({
      skillRegistry: makeSkillRegistry({
        "no-agent-skill": { context: "fork", body: "go" },
      }),
      taskRegistry: {
        submit: (_input: string, _source: string, type: string, _desc: string) => {
          capturedType = type;
          return "t-1";
        },
        resume: async () => "",
        ...registryStubs,
      },
    });

    await use_skill.execute({ skill: "no-agent-skill" }, ctx);
    expect(capturedType).toBe("general");
  });

  it("should handle errors from skillRegistry gracefully", async () => {
    const ctx = makeContext({
      skillRegistry: {
        get: () => ({ name: "broken", context: "inline" }),
        loadBody: () => { throw new Error("load failed"); },
      },
    });

    const result = await use_skill.execute({ skill: "broken" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("load failed");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await use_skill.execute(
      { skill: "code-review" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(use_skill.name).toBe("use_skill");
    expect(use_skill.description).toContain("skill");
    expect(use_skill.category).toBe(ToolCategory.SYSTEM);
  });

  it("should pass args through to loadBody", async () => {
    let capturedLoadArgs: unknown[] = [];
    const ctx = makeContext({
      skillRegistry: {
        get: (name: string) => ({ name, context: "inline" }),
        loadBody: (name: string, args?: string) => {
          capturedLoadArgs = [name, args];
          return "body";
        },
      },
    });

    await use_skill.execute({ skill: "my-skill", args: "arg1 arg2" }, ctx);
    expect(capturedLoadArgs).toEqual(["my-skill", "arg1 arg2"]);
  });
});
