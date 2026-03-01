import { describe, expect, test } from "bun:test";
import { TaskType, DEFAULT_TASK_TYPE } from "@pegasus/task/task-type.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import { AITaskTypeRegistry } from "@pegasus/aitask-types/registry.ts";
import { parseAITaskTypeFile, scanAITaskTypeDir, loadAITaskTypeDefinitions } from "@pegasus/aitask-types/loader.ts";
import type { AITaskTypeDefinition } from "@pegasus/aitask-types/types.ts";
import { allTaskTools } from "@pegasus/tools/builtins/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("TaskType enum", () => {
  test("has correct string values", () => {
    expect(TaskType.GENERAL).toBe("general" as TaskType);
    expect(TaskType.EXPLORE).toBe("explore" as TaskType);
    expect(TaskType.PLAN).toBe("plan" as TaskType);
  });

  test("DEFAULT_TASK_TYPE is general", () => {
    expect(DEFAULT_TASK_TYPE).toBe(TaskType.GENERAL);
  });
});

describe("TaskContext taskType", () => {
  test("createTaskContext defaults taskType to general", () => {
    const ctx = createTaskContext();
    expect(ctx.taskType).toBe("general");
  });

  test("createTaskContext accepts custom taskType", () => {
    const ctx = createTaskContext({ taskType: "explore" });
    expect(ctx.taskType).toBe("explore");
  });

  test("createTaskContext defaults description to empty string", () => {
    const ctx = createTaskContext();
    expect(ctx.description).toBe("");
  });

  test("createTaskContext accepts custom description", () => {
    const ctx = createTaskContext({ description: "Search for weather data" });
    expect(ctx.description).toBe("Search for weather data");
  });
});

// ── AITaskTypeLoader tests ──

const testDir = "/tmp/pegasus-test-aitask-types";

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("AITaskTypeLoader", () => {
  test("parseAITaskTypeFile parses valid AITASK.md", () => {
    cleanup();
    const dir = join(testDir, "explore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), [
      "---",
      "name: explore",
      'description: "Research agent"',
      "tools: \"read_file, web_search, notify\"",
      "---",
      "",
      "## Your Role",
      "You are a research assistant.",
    ].join("\n"));

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "explore", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("explore");
    expect(def!.description).toBe("Research agent");
    expect(def!.tools).toEqual(["read_file", "web_search", "notify"]);
    expect(def!.prompt).toContain("research assistant");
    expect(def!.source).toBe("builtin");
    cleanup();
  });

  test("parseAITaskTypeFile handles tools: * for all tools", () => {
    cleanup();
    const dir = join(testDir, "general");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), [
      "---",
      "name: general",
      'description: "Full access"',
      'tools: "*"',
      "---",
      "General agent.",
    ].join("\n"));

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "general", "builtin");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseAITaskTypeFile uses dir name when name not in frontmatter", () => {
    cleanup();
    const dir = join(testDir, "myagent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), [
      "---",
      'description: "Custom agent"',
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "myagent", "user");
    expect(def!.name).toBe("myagent");
    expect(def!.source).toBe("user");
    cleanup();
  });

  test("parseAITaskTypeFile rejects invalid name", () => {
    cleanup();
    const dir = join(testDir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), [
      "---",
      "name: Invalid Name!",
      'description: "Bad"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "bad", "builtin");
    expect(def).toBeNull();
    cleanup();
  });

  test("parseAITaskTypeFile handles missing frontmatter", () => {
    cleanup();
    const dir = join(testDir, "nofm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), "Just a body without frontmatter.");

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "nofm", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("nofm");
    expect(def!.prompt).toBe("Just a body without frontmatter.");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseAITaskTypeFile warns on missing description", () => {
    cleanup();
    const dir = join(testDir, "nodesc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AITASK.md"), [
      "---",
      "name: nodesc",
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseAITaskTypeFile(join(dir, "AITASK.md"), "nodesc", "builtin");
    expect(def).not.toBeNull();
    expect(def!.description).toBe("");
    cleanup();
  });

  test("parseAITaskTypeFile returns null for unreadable file", () => {
    const def = parseAITaskTypeFile("/tmp/nonexistent-file.md", "ghost", "builtin");
    expect(def).toBeNull();
  });

  test("scanAITaskTypeDir discovers all AI task type directories", () => {
    cleanup();
    for (const name of ["alpha", "beta"]) {
      const dir = join(testDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "AITASK.md"), [
        "---",
        `name: ${name}`,
        `description: "${name} agent"`,
        'tools: "*"',
        "---",
        `${name} body.`,
      ].join("\n"));
    }

    const defs = scanAITaskTypeDir(testDir, "builtin");
    expect(defs.length).toBe(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    cleanup();
  });

  test("scanAITaskTypeDir returns empty for non-existent directory", () => {
    const defs = scanAITaskTypeDir("/tmp/nonexistent-aitask-type-dir", "builtin");
    expect(defs).toEqual([]);
  });

  test("loadAITaskTypeDefinitions merges builtin and user", () => {
    cleanup();
    const builtinDir = join(testDir, "builtin");
    const userDir = join(testDir, "user");
    mkdirSync(join(builtinDir, "explore"), { recursive: true });
    mkdirSync(join(userDir, "custom"), { recursive: true });
    writeFileSync(join(builtinDir, "explore", "AITASK.md"), "---\nname: explore\ndescription: builtin\ntools: \"*\"\n---\nBody.");
    writeFileSync(join(userDir, "custom", "AITASK.md"), "---\nname: custom\ndescription: user\ntools: \"*\"\n---\nBody.");

    const defs = loadAITaskTypeDefinitions(builtinDir, userDir);
    expect(defs.length).toBe(2);
    cleanup();
  });

  test("loads builtin AI task type files from project", () => {
    const defs = scanAITaskTypeDir(join(process.cwd(), "subagents"), "builtin");
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const names = defs.map((d) => d.name).sort();
    expect(names).toContain("general");
    expect(names).toContain("explore");
    expect(names).toContain("plan");
  });
});

// ── AITaskTypeRegistry tests ──

describe("AITaskTypeRegistry", () => {
  function makeDef(name: string, tools: string[] = ["*"], source: "builtin" | "user" = "builtin"): AITaskTypeDefinition {
    return { name, description: `${name} agent`, tools, prompt: `${name} prompt`, source };
  }

  test("registerMany and get", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore", ["read_file", "notify"])]);
    expect(reg.get("general")).not.toBeNull();
    expect(reg.get("explore")).not.toBeNull();
    expect(reg.get("unknown")).toBeNull();
  });

  test("user overrides builtin", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
      makeDef("explore", ["read_file", "web_search"], "user"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("builtin does not override user", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "user"),
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("later builtin overrides earlier builtin", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("getToolNames resolves * to all task tools", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("general")]);
    const names = reg.getToolNames("general");
    expect(names.length).toBe(allTaskTools.length);
    expect(names).toContain("read_file");
    expect(names).toContain("notify");
  });

  test("getToolNames returns explicit tool list", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("explore", ["read_file", "web_search", "notify"])]);
    expect(reg.getToolNames("explore")).toEqual(["read_file", "web_search", "notify"]);
  });

  test("getToolNames falls back to * for unknown type", () => {
    const reg = new AITaskTypeRegistry();
    const names = reg.getToolNames("unknown");
    expect(names.length).toBe(allTaskTools.length);
  });

  test("getPrompt returns prompt body", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.getPrompt("explore")).toBe("explore prompt");
  });

  test("getPrompt returns empty string for unknown type", () => {
    const reg = new AITaskTypeRegistry();
    expect(reg.getPrompt("unknown")).toBe("");
  });

  test("getMetadataForPrompt generates AI task type listing", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore")]);
    const metadata = reg.getMetadataForPrompt();
    expect(metadata).toContain("general");
    expect(metadata).toContain("explore");
    expect(metadata).toContain("spawn_subagent");
  });

  test("has returns true for registered types", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.has("explore")).toBe(true);
    expect(reg.has("unknown")).toBe(false);
  });

  test("listAll returns all definitions", () => {
    const reg = new AITaskTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore"), makeDef("plan")]);
    expect(reg.listAll().length).toBe(3);
  });
});
