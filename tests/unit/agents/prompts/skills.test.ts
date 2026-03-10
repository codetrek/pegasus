/**
 * Tests for skill behavioral guidance prompt builder.
 *
 * Covers:
 * - buildSkillsSection(): MainAgent full guidance with skill metadata
 * - Integration with buildSystemPrompt() for main and task modes
 */

import { describe, test, expect } from "bun:test";
import { buildSkillsSection } from "../../../../src/agents/prompts/skills.ts";
import { buildSystemPrompt } from "../../../../src/agents/prompts/main-agent.ts";
import type { Persona } from "../../../../src/identity/persona.ts";

// ── Helpers ──────────────────────────────────────────

const MOCK_SKILL_METADATA = [
  "Available skills:",
  "- commit: Use when committing changes to git with conventional commit format",
  "- review: Use when reviewing code changes, PRs, or asking for code feedback",
  "",
  "Use the use_skill tool to invoke a skill when relevant.",
].join("\n");

const TEST_PERSONA: Persona = {
  name: "TestAgent",
  role: "a test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

// ── buildSkillsSection ──────────────────────────────

describe("buildSkillsSection", () => {
  test("returns array with Skills header", () => {
    const lines = buildSkillsSection(MOCK_SKILL_METADATA);
    expect(lines[0]).toBe("## Skills");
  });

  test("wraps skill metadata in the output", () => {
    const lines = buildSkillsSection(MOCK_SKILL_METADATA);
    const joined = lines.join("\n");
    expect(joined).toContain("commit: Use when committing changes");
    expect(joined).toContain("review: Use when reviewing code changes");
  });

  test("contains Decision Flow section", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("### Decision Flow");
    expect(joined).toContain("BEFORE any other action");
    expect(joined).toContain("use_skill(name, args?)");
  });

  test("contains Priority Rules section", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("### Priority Rules");
    expect(joined).toContain("More specific skill wins");
  });

  test("contains delegation integration (Step 0)", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("### Integration with Delegation");
    expect(joined).toContain("Step 0");
    expect(joined).toContain("ALWAYS CHECK FIRST");
  });

  test("contains Red Flags anti-rationalization section", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("### Red Flags");
    expect(joined).toContain("I already know how to do this");
    expect(joined).toContain("The skill IS the standard way");
  });

  test("contains 20% threshold rule", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("20% chance");
  });

  test("distinguishes inline and fork skill behavior", () => {
    const joined = buildSkillsSection(MOCK_SKILL_METADATA).join("\n");
    expect(joined).toContain("inline");
    expect(joined).toContain("fork");
  });

  test("skill metadata appears at the end after separator", () => {
    const lines = buildSkillsSection(MOCK_SKILL_METADATA);
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(0);
    // Skill metadata is the last element
    expect(lines[lines.length - 1]).toBe(MOCK_SKILL_METADATA);
  });
});

// ── Integration with buildSystemPrompt ──────────────

describe("buildSystemPrompt integration", () => {
  test("main mode wraps skillMetadata with behavioral guidance", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona: TEST_PERSONA,
      skillMetadata: MOCK_SKILL_METADATA,
    });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("### Decision Flow");
    expect(prompt).toContain("### Red Flags");
    expect(prompt).toContain("commit: Use when committing changes");
  });

  test("task mode also wraps skillMetadata with behavioral guidance", () => {
    const prompt = buildSystemPrompt({
      mode: "task",
      persona: TEST_PERSONA,
      skillMetadata: MOCK_SKILL_METADATA,
    });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("### Decision Flow");
    expect(prompt).toContain("### Red Flags");
    expect(prompt).toContain("commit: Use when committing changes");
  });

  test("main mode without skillMetadata has no Skills guidance section", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona: TEST_PERSONA,
    });
    expect(prompt).not.toContain("Skills are specialized instruction sets");
    expect(prompt).not.toContain("### Red Flags");
  });

  test("task mode without skillMetadata has no skill content", () => {
    const prompt = buildSystemPrompt({
      mode: "task",
      persona: TEST_PERSONA,
    });
    expect(prompt).not.toContain("Available skills:");
  });
});
