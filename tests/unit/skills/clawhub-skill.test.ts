import { describe, expect, test } from "bun:test";
import path from "path";
import { parseSkillFile } from "@pegasus/skills/loader.ts";

describe("clawhub SKILL.md", () => {
  const skillPath = path.join(process.cwd(), "skills", "clawhub", "SKILL.md");

  test("parses as valid SkillDefinition", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("clawhub");
  });

  test("has description mentioning ClawHub", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.description.toLowerCase()).toContain("clawhub");
  });

  test("has argument-hint for sub-commands", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.argumentHint).toBeDefined();
    expect(skill!.argumentHint).toContain("search");
    expect(skill!.argumentHint).toContain("install");
  });

  test("uses inline context (default)", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.context).toBe("inline");
  });

  test("is user-invocable", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.userInvocable).toBe(true);
  });

  test("allows model invocation", () => {
    const skill = parseSkillFile(skillPath, "clawhub", "builtin");
    expect(skill).not.toBeNull();
    expect(skill!.disableModelInvocation).toBe(false);
  });
});
