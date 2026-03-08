import { describe, it, expect, mock } from "bun:test";
import {
  projectTools,
  create_project,
  list_projects,
  disable_project,
  enable_project,
  archive_project,
} from "../../../src/agents/tools/builtins/project-tools.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";

// ── Mock ProjectManager ───────────────────────────────────

const mockManager = {
  create: (opts: { name: string; goal: string; background?: string; constraints?: string; model?: string; workdir?: string }) => ({
    name: opts.name,
    status: "active" as const,
    prompt: `## Goal\n\n${opts.goal}`,
    projectDir: `/tmp/projects/${opts.name}`,
  }),
  list: (status?: string) => {
    const all = [
      { name: "proj1", status: "active" },
      { name: "proj2", status: "disabled" },
    ];
    if (!status) return all;
    return all.filter((p) => p.status === status);
  },
  get: (name: string) => {
    if (name === "not-found") return null;
    return { name, projectDir: `/tmp/projects/${name}`, status: "active" };
  },
  disable: (name: string) => {
    if (name === "not-found") throw new Error(`Project "${name}" not found`);
  },
  enable: (name: string) => {
    if (name === "not-found") throw new Error(`Project "${name}" not found`);
  },
  archive: (name: string) => {
    if (name === "not-found") throw new Error(`Project "${name}" not found`);
  },
};

// ── Mock ProjectAdapter ───────────────────────────────────

function makeMockAdapter() {
  return {
    startProject: mock((_name: string, _projectDir: string) => {}),
    stopProject: mock((_name: string) => Promise.resolve()),
  };
}

function makeContext(manager = mockManager, adapter?: ReturnType<typeof makeMockAdapter>): ToolContext {
  return {
    taskId: "test",
    projectManager: manager,
    projectAdapter: adapter,
  } as unknown as ToolContext;
}

// ── Tests ─────────────────────────────────────────────────

describe("project tools", () => {
  it("should export 5 project tools", () => {
    expect(projectTools).toHaveLength(5);
  });

  it("tool names should be correct", () => {
    const names = projectTools.map((t) => t.name);
    expect(names).toEqual([
      "create_project",
      "list_projects",
      "disable_project",
      "enable_project",
      "archive_project",
    ]);
  });

  it("each tool should have a description", () => {
    for (const tool of projectTools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("each tool should use SYSTEM category", () => {
    for (const tool of projectTools) {
      expect(tool.category).toBe(ToolCategory.SYSTEM);
    }
  });

  it("each tool should have parameters defined", () => {
    for (const tool of projectTools) {
      expect(tool.parameters).toBeDefined();
    }
  });
});

describe("create_project tool", () => {
  it("should have correct parameter schema with required and optional fields", () => {
    const schema = create_project.parameters;
    // Validate required fields succeed
    const valid = schema.safeParse({ name: "test", goal: "do stuff" });
    expect(valid.success).toBe(true);

    // Validate all optional fields
    const full = schema.safeParse({
      name: "test",
      goal: "do stuff",
      background: "some context",
      constraints: "no limits",
      model: "gpt-4o",
      workdir: "/tmp",
    });
    expect(full.success).toBe(true);

    // Missing required field should fail
    const missing = schema.safeParse({ goal: "do stuff" });
    expect(missing.success).toBe(false);
  });

  it("should return success with project definition on create", async () => {
    const result = await create_project.execute(
      { name: "my-project", goal: "Build something great" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      name: string;
      status: string;
      prompt: string;
      projectDir: string;
    };
    expect(data.action).toBe("create_project");
    expect(data.name).toBe("my-project");
    expect(data.status).toBe("active");
    expect(data.prompt).toContain("Build something great");
    expect(data.projectDir).toBe("/tmp/projects/my-project");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await create_project.execute(
      { name: "timed", goal: "test" },
      makeContext(),
    );
    const after = Date.now();
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should return error when projectManager is missing", async () => {
    const result = await create_project.execute(
      { name: "fail", goal: "test" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("projectManager not available");
  });

  it("should return error when create throws", async () => {
    const errorManager = {
      ...mockManager,
      create: () => { throw new Error("Project \"dup\" already exists"); },
    };
    const result = await create_project.execute(
      { name: "dup", goal: "test" },
      makeContext(errorManager),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });
});

describe("list_projects tool", () => {
  it("should accept optional status parameter", () => {
    const schema = list_projects.parameters;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ status: "active" }).success).toBe(true);
    expect(schema.safeParse({ status: "invalid" }).success).toBe(false);
  });

  it("should return all projects when no status filter", async () => {
    const result = await list_projects.execute({}, makeContext());
    expect(result.success).toBe(true);
    const data = result.result as { action: string; count: number; projects: unknown[] };
    expect(data.action).toBe("list_projects");
    expect(data.count).toBe(2);
    expect(data.projects).toHaveLength(2);
  });

  it("should filter projects by status", async () => {
    const result = await list_projects.execute({ status: "active" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.result as { count: number; projects: Array<{ name: string }> };
    expect(data.count).toBe(1);
    expect(data.projects[0]!.name).toBe("proj1");
  });

  it("should return error when projectManager is missing", async () => {
    const result = await list_projects.execute({}, { taskId: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("projectManager not available");
  });
});

describe("disable_project tool", () => {
  it("should require name parameter", () => {
    const schema = disable_project.parameters;
    expect(schema.safeParse({ name: "proj1" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("should return success when disabling a project", async () => {
    const result = await disable_project.execute({ name: "proj1" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.result as { action: string; name: string; status: string };
    expect(data.action).toBe("disable_project");
    expect(data.name).toBe("proj1");
    expect(data.status).toBe("disabled");
  });

  it("should return error for non-existent project", async () => {
    const result = await disable_project.execute({ name: "not-found" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("enable_project tool", () => {
  it("should require name parameter", () => {
    const schema = enable_project.parameters;
    expect(schema.safeParse({ name: "proj1" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("should return success when enabling a project", async () => {
    const result = await enable_project.execute({ name: "proj1" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.result as { action: string; name: string; status: string };
    expect(data.action).toBe("enable_project");
    expect(data.name).toBe("proj1");
    expect(data.status).toBe("active");
  });

  it("should return error for non-existent project", async () => {
    const result = await enable_project.execute({ name: "not-found" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("archive_project tool", () => {
  it("should require name parameter", () => {
    const schema = archive_project.parameters;
    expect(schema.safeParse({ name: "proj1" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("should return success when archiving a project", async () => {
    const result = await archive_project.execute({ name: "proj1" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.result as { action: string; name: string; status: string };
    expect(data.action).toBe("archive_project");
    expect(data.name).toBe("proj1");
    expect(data.status).toBe("archived");
  });

  it("should return error for non-existent project", async () => {
    const result = await archive_project.execute({ name: "not-found" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ── Worker lifecycle integration tests ────────────────────

describe("project tools Worker lifecycle", () => {
  it("create_project should call projectAdapter.startProject", async () => {
    const adapter = makeMockAdapter();
    const result = await create_project.execute(
      { name: "new-proj", goal: "Build something" },
      makeContext(mockManager, adapter),
    );
    expect(result.success).toBe(true);
    expect(adapter.startProject).toHaveBeenCalledTimes(1);
    expect(adapter.startProject).toHaveBeenCalledWith("new-proj", "/tmp/projects/new-proj");
  });

  it("disable_project should call projectAdapter.stopProject", async () => {
    const adapter = makeMockAdapter();
    const result = await disable_project.execute(
      { name: "proj1" },
      makeContext(mockManager, adapter),
    );
    expect(result.success).toBe(true);
    expect(adapter.stopProject).toHaveBeenCalledTimes(1);
    expect(adapter.stopProject).toHaveBeenCalledWith("proj1");
  });

  it("enable_project should call projectAdapter.startProject with projectDir from pm.get()", async () => {
    const adapter = makeMockAdapter();
    const result = await enable_project.execute(
      { name: "proj1" },
      makeContext(mockManager, adapter),
    );
    expect(result.success).toBe(true);
    expect(adapter.startProject).toHaveBeenCalledTimes(1);
    expect(adapter.startProject).toHaveBeenCalledWith("proj1", "/tmp/projects/proj1");
  });

  it("archive_project should call projectAdapter.stopProject", async () => {
    const adapter = makeMockAdapter();
    const result = await archive_project.execute(
      { name: "proj1" },
      makeContext(mockManager, adapter),
    );
    expect(result.success).toBe(true);
    expect(adapter.stopProject).toHaveBeenCalledTimes(1);
    expect(adapter.stopProject).toHaveBeenCalledWith("proj1");
  });

  it("list_projects should NOT call projectAdapter", async () => {
    const adapter = makeMockAdapter();
    const result = await list_projects.execute(
      {},
      makeContext(mockManager, adapter),
    );
    expect(result.success).toBe(true);
    expect(adapter.startProject).not.toHaveBeenCalled();
    expect(adapter.stopProject).not.toHaveBeenCalled();
  });
});

describe("project tools without projectAdapter (graceful fallback)", () => {
  it("create_project should succeed without projectAdapter", async () => {
    const result = await create_project.execute(
      { name: "no-adapter", goal: "test" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.result as { name: string };
    expect(data.name).toBe("no-adapter");
  });

  it("disable_project should succeed without projectAdapter", async () => {
    const result = await disable_project.execute(
      { name: "proj1" },
      makeContext(),
    );
    expect(result.success).toBe(true);
  });

  it("enable_project should succeed without projectAdapter", async () => {
    const result = await enable_project.execute(
      { name: "proj1" },
      makeContext(),
    );
    expect(result.success).toBe(true);
  });
});
