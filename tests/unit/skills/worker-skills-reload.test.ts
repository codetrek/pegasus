import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import path from "path";
import { SkillRegistry } from "@pegasus/skills/registry.ts";
import {
  handleSkillsReload,
  _testState,
} from "@pegasus/workers/agent-worker.ts";

const tmpDir = path.join("/tmp", `worker-skills-test-${Date.now()}`);

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} instructions.\n`,
  );
}

describe("handleSkillsReload", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Restore module state
    _testState.setSkillRegistry(null);
    _testState.setSkillDirs([]);
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reloads project skill registry from configured dirs", () => {
    const userDir = path.join(tmpDir, "user");
    mkdirSync(userDir, { recursive: true });
    writeSkill(userDir, "existing-skill", "An existing skill");

    const registry = new SkillRegistry();
    registry.reloadFromDirs([{ dir: userDir, source: "user" }]);
    expect(registry.has("existing-skill")).toBe(true);
    expect(registry.has("new-skill")).toBe(false);

    // Set module state
    _testState.setSkillRegistry(registry);
    _testState.setSkillDirs([{ dir: userDir, source: "user" }]);

    // Add new skill to disk
    writeSkill(userDir, "new-skill", "A new skill");

    // Trigger reload
    handleSkillsReload();

    // Verify new skill is now available
    expect(registry.has("new-skill")).toBe(true);
    expect(registry.has("existing-skill")).toBe(true);
  });

  test("does nothing when no skill registry configured", () => {
    // No registry set — should not throw
    _testState.setSkillRegistry(null);
    _testState.setSkillDirs([]);
    expect(() => handleSkillsReload()).not.toThrow();
  });

  test("does nothing when no dirs configured", () => {
    const registry = new SkillRegistry();
    _testState.setSkillRegistry(registry);
    _testState.setSkillDirs([]);
    expect(() => handleSkillsReload()).not.toThrow();
    expect(registry.listAll()).toHaveLength(0);
  });
});
