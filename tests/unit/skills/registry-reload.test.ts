import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import path from "path";
import { SkillRegistry } from "@pegasus/skills/registry.ts";

const tmpDir = path.join("/tmp", `skills-reload-test-${Date.now()}`);
const builtinDir = path.join(tmpDir, "builtin");
const userDir = path.join(tmpDir, "user");
const mainDir = path.join(tmpDir, "main");

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`,
  );
}

describe("SkillRegistry.reloadFromDirs", () => {
  beforeEach(() => {
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    mkdirSync(mainDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads skills from multiple directories", () => {
    writeSkill(builtinDir, "commit", "Builtin commit skill");
    writeSkill(userDir, "deploy", "User deploy skill");

    const registry = new SkillRegistry();
    registry.reloadFromDirs([
      { dir: builtinDir, source: "builtin" },
      { dir: userDir, source: "user" },
    ]);

    expect(registry.has("commit")).toBe(true);
    expect(registry.has("deploy")).toBe(true);
    expect(registry.listAll()).toHaveLength(2);
  });

  test("later directories override earlier (priority)", () => {
    writeSkill(builtinDir, "review", "Builtin review");
    writeSkill(userDir, "review", "User custom review");

    const registry = new SkillRegistry();
    registry.reloadFromDirs([
      { dir: builtinDir, source: "builtin" },
      { dir: userDir, source: "user" },
    ]);

    const skill = registry.get("review");
    expect(skill).not.toBeNull();
    expect(skill!.source).toBe("user");
    expect(skill!.description).toBe("User custom review");
  });

  test("three-tier priority: main > global > builtin", () => {
    writeSkill(builtinDir, "helper", "Builtin helper");
    writeSkill(userDir, "helper", "Global helper");
    writeSkill(mainDir, "helper", "Main-only helper");

    const registry = new SkillRegistry();
    registry.reloadFromDirs([
      { dir: builtinDir, source: "builtin" },
      { dir: userDir, source: "user" },
      { dir: mainDir, source: "user" },
    ]);

    const skill = registry.get("helper");
    expect(skill).not.toBeNull();
    // Last user source wins (main-only dir)
    expect(skill!.description).toBe("Main-only helper");
  });

  test("reload clears previous state", () => {
    writeSkill(builtinDir, "old-skill", "Old skill");

    const registry = new SkillRegistry();
    registry.reloadFromDirs([{ dir: builtinDir, source: "builtin" }]);
    expect(registry.has("old-skill")).toBe(true);

    // Clear builtinDir and add new skill
    rmSync(path.join(builtinDir, "old-skill"), { recursive: true, force: true });
    writeSkill(builtinDir, "new-skill", "New skill");

    registry.reloadFromDirs([{ dir: builtinDir, source: "builtin" }]);
    expect(registry.has("old-skill")).toBe(false);
    expect(registry.has("new-skill")).toBe(true);
  });

  test("handles missing directories gracefully", () => {
    const registry = new SkillRegistry();
    registry.reloadFromDirs([
      { dir: "/tmp/nonexistent-dir-12345", source: "builtin" },
      { dir: userDir, source: "user" },
    ]);
    expect(registry.listAll()).toHaveLength(0);
  });

  test("detects newly added skills after reload", () => {
    const registry = new SkillRegistry();
    registry.reloadFromDirs([{ dir: userDir, source: "user" }]);
    expect(registry.listAll()).toHaveLength(0);

    // Add a skill and reload
    writeSkill(userDir, "fresh-skill", "Fresh skill");
    registry.reloadFromDirs([{ dir: userDir, source: "user" }]);
    expect(registry.has("fresh-skill")).toBe(true);
  });
});
