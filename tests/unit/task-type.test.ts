import { describe, expect, test } from "bun:test";


import { SubAgentTypeRegistry } from "@pegasus/agents/subagents/registry.ts";
import { parseSubAgentTypeFile, scanSubAgentTypeDir, loadSubAgentTypeDefinitions } from "@pegasus/agents/subagents/loader.ts";
import type { SubAgentTypeDefinition } from "@pegasus/agents/subagents/types.ts";
import { allTaskTools } from "@pegasus/tools/builtins/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ── SubAgentTypeLoader tests ──

const testDir = "/tmp/pegasus-test-subagents";

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("SubAgentTypeLoader", () => {
  test("parseSubAgentTypeFile parses valid SUBAGENT.md", () => {
    cleanup();
    const dir = join(testDir, "explore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: explore",
      'description: "Research agent"',
      "tools: \"read_file, web_search, notify\"",
      "---",
      "",
      "## Your Role",
      "You are a research assistant.",
    ].join("\n"));

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "explore", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("explore");
    expect(def!.description).toBe("Research agent");
    expect(def!.tools).toEqual(["read_file", "web_search", "notify"]);
    expect(def!.prompt).toContain("research assistant");
    expect(def!.source).toBe("builtin");
    cleanup();
  });

  test("parseSubAgentTypeFile handles tools: * for all tools", () => {
    cleanup();
    const dir = join(testDir, "general");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: general",
      'description: "Full access"',
      'tools: "*"',
      "---",
      "General agent.",
    ].join("\n"));

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "general", "builtin");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseSubAgentTypeFile uses dir name when name not in frontmatter", () => {
    cleanup();
    const dir = join(testDir, "myagent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      'description: "Custom agent"',
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "myagent", "user");
    expect(def!.name).toBe("myagent");
    expect(def!.source).toBe("user");
    cleanup();
  });

  test("parseSubAgentTypeFile rejects invalid name", () => {
    cleanup();
    const dir = join(testDir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: Invalid Name!",
      'description: "Bad"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "bad", "builtin");
    expect(def).toBeNull();
    cleanup();
  });

  test("parseSubAgentTypeFile handles missing frontmatter", () => {
    cleanup();
    const dir = join(testDir, "nofm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), "Just a body without frontmatter.");

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "nofm", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("nofm");
    expect(def!.prompt).toBe("Just a body without frontmatter.");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseSubAgentTypeFile warns on missing description", () => {
    cleanup();
    const dir = join(testDir, "nodesc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: nodesc",
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubAgentTypeFile(join(dir, "SUBAGENT.md"), "nodesc", "builtin");
    expect(def).not.toBeNull();
    expect(def!.description).toBe("");
    cleanup();
  });

  test("parseSubAgentTypeFile returns null for unreadable file", () => {
    const def = parseSubAgentTypeFile("/tmp/nonexistent-file.md", "ghost", "builtin");
    expect(def).toBeNull();
  });

  test("scanSubAgentTypeDir discovers all AI task type directories", () => {
    cleanup();
    for (const name of ["alpha", "beta"]) {
      const dir = join(testDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SUBAGENT.md"), [
        "---",
        `name: ${name}`,
        `description: "${name} agent"`,
        'tools: "*"',
        "---",
        `${name} body.`,
      ].join("\n"));
    }

    const defs = scanSubAgentTypeDir(testDir, "builtin");
    expect(defs.length).toBe(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    cleanup();
  });

  test("scanSubAgentTypeDir returns empty for non-existent directory", () => {
    const defs = scanSubAgentTypeDir("/tmp/nonexistent-subagent-type-dir", "builtin");
    expect(defs).toEqual([]);
  });

  test("loadSubAgentTypeDefinitions merges builtin and user", () => {
    cleanup();
    const builtinDir = join(testDir, "builtin");
    const userDir = join(testDir, "user");
    mkdirSync(join(builtinDir, "explore"), { recursive: true });
    mkdirSync(join(userDir, "custom"), { recursive: true });
    writeFileSync(join(builtinDir, "explore", "SUBAGENT.md"), "---\nname: explore\ndescription: builtin\ntools: \"*\"\n---\nBody.");
    writeFileSync(join(userDir, "custom", "SUBAGENT.md"), "---\nname: custom\ndescription: user\ntools: \"*\"\n---\nBody.");

    const defs = loadSubAgentTypeDefinitions(builtinDir, userDir);
    expect(defs.length).toBe(2);
    cleanup();
  });

  test("loads builtin AI task type files from project", () => {
    const defs = scanSubAgentTypeDir(join(process.cwd(), "subagents"), "builtin");
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const names = defs.map((d) => d.name).sort();
    expect(names).toContain("general");
    expect(names).toContain("explore");
    expect(names).toContain("plan");
  });
});

// ── SubAgentTypeRegistry tests ──

describe("SubAgentTypeRegistry", () => {
  function makeDef(name: string, tools: string[] = ["*"], source: "builtin" | "user" = "builtin"): SubAgentTypeDefinition {
    return { name, description: `${name} agent`, tools, prompt: `${name} prompt`, source };
  }

  test("registerMany and get", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore", ["read_file", "notify"])]);
    expect(reg.get("general")).not.toBeNull();
    expect(reg.get("explore")).not.toBeNull();
    expect(reg.get("unknown")).toBeNull();
  });

  test("user overrides builtin", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
      makeDef("explore", ["read_file", "web_search"], "user"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("builtin does not override user", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "user"),
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("later builtin overrides earlier builtin", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("getToolNames resolves * to all task tools", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("general")]);
    const names = reg.getToolNames("general");
    expect(names.length).toBe(allTaskTools.length);
    expect(names).toContain("read_file");
    expect(names).toContain("notify");
  });

  test("getToolNames returns explicit tool list", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("explore", ["read_file", "web_search", "notify"])]);
    expect(reg.getToolNames("explore")).toEqual(["read_file", "web_search", "notify"]);
  });

  test("getToolNames falls back to * for unknown type", () => {
    const reg = new SubAgentTypeRegistry();
    const names = reg.getToolNames("unknown");
    expect(names.length).toBe(allTaskTools.length);
  });

  test("getPrompt returns prompt body", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.getPrompt("explore")).toBe("explore prompt");
  });

  test("getPrompt returns empty string for unknown type", () => {
    const reg = new SubAgentTypeRegistry();
    expect(reg.getPrompt("unknown")).toBe("");
  });

  test("getMetadataForPrompt generates AI task type listing", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore")]);
    const metadata = reg.getMetadataForPrompt();
    expect(metadata).toContain("general");
    expect(metadata).toContain("explore");
    expect(metadata).toContain("spawn_subagent");
  });

  test("has returns true for registered types", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.has("explore")).toBe(true);
    expect(reg.has("unknown")).toBe(false);
  });

  test("listAll returns all definitions", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore"), makeDef("plan")]);
    expect(reg.listAll().length).toBe(3);
  });
});
