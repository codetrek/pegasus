/**
 * Tests for Telegram command builder — converts skills to Telegram / menu.
 */
import { describe, it, expect } from "bun:test";
import {
  toTelegramCommandName,
  buildTelegramCommands,
} from "../../../src/channels/telegram-commands.ts";
import type { SkillDefinition } from "../../../src/skills/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test",
    description: "Test skill",
    disableModelInvocation: false,
    userInvocable: true,
    context: "inline" as const,
    agent: "general",
    bodyPath: "/tmp/fake/SKILL.md",
    source: "builtin" as const,
    ...overrides,
  };
}

describe("toTelegramCommandName", () => {
  it("should keep simple lowercase names unchanged", () => {
    expect(toTelegramCommandName("commit")).toBe("commit");
    expect(toTelegramCommandName("review")).toBe("review");
  });

  it("should convert hyphens to underscores", () => {
    expect(toTelegramCommandName("code-review")).toBe("code_review");
    expect(toTelegramCommandName("my-long-skill-name")).toBe("my_long_skill_name");
  });

  it("should lowercase uppercase characters", () => {
    expect(toTelegramCommandName("MySkill")).toBe("myskill");
  });

  it("should strip invalid characters", () => {
    expect(toTelegramCommandName("skill@v2!")).toBe("skillv2");
    expect(toTelegramCommandName("hello world")).toBe("helloworld");
  });

  it("should truncate to 32 characters", () => {
    const long = "a".repeat(50);
    expect(toTelegramCommandName(long)).toHaveLength(32);
  });

  it("should handle empty string", () => {
    expect(toTelegramCommandName("")).toBe("");
  });

  it("should handle digits and underscores", () => {
    expect(toTelegramCommandName("skill_v2")).toBe("skill_v2");
    expect(toTelegramCommandName("test123")).toBe("test123");
  });
});

describe("buildTelegramCommands", () => {
  it("should convert skills to TelegramCommand array", () => {
    const skills = [
      makeSkill({ name: "commit", description: "Commit changes" }),
      makeSkill({ name: "review", description: "Review code" }),
    ];
    const commands = buildTelegramCommands(skills);
    expect(commands).toEqual([
      { command: "commit", description: "Commit changes" },
      { command: "review", description: "Review code" },
    ]);
  });

  it("should convert hyphenated skill names", () => {
    const skills = [
      makeSkill({ name: "code-review", description: "Review code changes" }),
    ];
    const commands = buildTelegramCommands(skills);
    expect(commands[0]!.command).toBe("code_review");
  });

  it("should truncate long descriptions to 256 chars", () => {
    const skills = [
      makeSkill({ name: "test", description: "x".repeat(300) }),
    ];
    const commands = buildTelegramCommands(skills);
    expect(commands[0]!.description).toHaveLength(256);
  });

  it("should use skill name as fallback for empty description", () => {
    const skills = [
      makeSkill({ name: "test", description: "" }),
    ];
    const commands = buildTelegramCommands(skills);
    expect(commands[0]!.description).toBe("test");
  });

  it("should skip skills with invalid names after conversion", () => {
    const skills = [
      makeSkill({ name: "!!!", description: "Bad name" }),
      makeSkill({ name: "good", description: "Good name" }),
    ];
    const commands = buildTelegramCommands(skills);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe("good");
  });

  it("should limit to 100 commands", () => {
    const skills = Array.from({ length: 150 }, (_, i) =>
      makeSkill({ name: `skill${i}`, description: `Skill ${i}` }),
    );
    const commands = buildTelegramCommands(skills);
    expect(commands).toHaveLength(100);
  });

  it("should handle empty skills array", () => {
    expect(buildTelegramCommands([])).toEqual([]);
  });
});
