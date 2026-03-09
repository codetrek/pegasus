import { describe, expect, test } from "bun:test";
import { loadPersona, PersonaSchema } from "@pegasus/identity/persona.ts";
import { buildSystemPrompt, formatSize, buildRuntimeSection } from "@pegasus/agents/prompts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Persona tests ───────────────────────────────────────────

describe("PersonaSchema", () => {
  test("valid persona passes validation", () => {
    const result = PersonaSchema.parse({
      name: "Alice",
      role: "digital employee",
      personality: ["professional", "helpful"],
      style: "concise and warm",
      values: ["accuracy", "empathy"],
    });
    expect(result.name).toBe("Alice");
    expect(result.personality).toHaveLength(2);
  });

  test("optional background field", () => {
    const result = PersonaSchema.parse({
      name: "Alice",
      role: "assistant",
      personality: ["helpful"],
      style: "concise",
      values: ["accuracy"],
      background: "10 years of experience",
    });
    expect(result.background).toBe("10 years of experience");
  });

  test("missing required field throws", () => {
    expect(() =>
      PersonaSchema.parse({ name: "Alice", role: "assistant" }),
    ).toThrow();
  });

  test("empty name throws", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "",
        role: "assistant",
        personality: ["helpful"],
        style: "concise",
        values: ["accuracy"],
      }),
    ).toThrow();
  });

  test("empty personality array throws", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "Alice",
        role: "assistant",
        personality: [],
        style: "concise",
        values: ["accuracy"],
      }),
    ).toThrow();
  });
});

describe("loadPersona", () => {
  const testDir = join(import.meta.dir, "..", "fixtures");
  const validFile = join(testDir, "test-persona.json");
  const invalidFile = join(testDir, "invalid-persona.json");

  test("loads valid persona from JSON file", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    writeFileSync(
      validFile,
      JSON.stringify({
        name: "TestBot",
        role: "test assistant",
        personality: ["helpful"],
        style: "concise",
        values: ["accuracy"],
      }),
    );

    const persona = loadPersona(validFile);
    expect(persona.name).toBe("TestBot");
    expect(persona.role).toBe("test assistant");

    unlinkSync(validFile);
  });

  test("throws on invalid JSON file", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    writeFileSync(invalidFile, "not valid json");

    expect(() => loadPersona(invalidFile)).toThrow();

    unlinkSync(invalidFile);
  });

  test("throws on non-existent file", () => {
    expect(() => loadPersona("/tmp/nonexistent-persona.json")).toThrow();
  });

  test("throws when persona fails validation", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const badFile = join(testDir, "bad-persona.json");
    writeFileSync(badFile, JSON.stringify({ name: "Alice" }));

    expect(() => loadPersona(badFile)).toThrow();

    unlinkSync(badFile);
  });

  test("loads default persona file", () => {
    const persona = loadPersona("data/personas/default.json");
    expect(persona.name).toBeTruthy();
    expect(persona.role).toBeTruthy();
  });
});

// ── Prompt tests ────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  const persona: Persona = {
    name: "Alice",
    role: "digital employee",
    personality: ["professional", "helpful"],
    style: "concise and warm",
    values: ["accuracy", "empathy"],
  };

  const personaWithBg: Persona = {
    ...persona,
    background: "Expert in AI systems",
  };

  // Identity section (both modes)
  test("includes persona identity in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("digital employee");
    expect(prompt).toContain("professional");
    expect(prompt).toContain("concise and warm");
    expect(prompt).toContain("accuracy");
  });

  test("includes persona identity in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("digital employee");
  });

  test("includes background when present", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona: personaWithBg });
    expect(prompt).toContain("Expert in AI systems");
  });

  // Runtime metadata (both modes)
  test("includes runtime metadata in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("Runtime:");
    expect(prompt).toContain(process.platform);
    expect(prompt).toContain("tz:");
    expect(prompt).toContain("cwd:");
  });

  test("includes runtime metadata in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).toContain("Runtime:");
  });

  // Safety section (both modes)
  test("includes safety section in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("no independent goals");
  });

  test("includes safety section in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).toContain("## Safety");
  });

  // Main-only sections
  test("includes How You Think in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## How You Think");
    expect(prompt).toContain("INNER MONOLOGUE");
    expect(prompt).toContain("reply()");
  });

  test("does NOT include How You Think in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("## How You Think");
    expect(prompt).not.toContain("INNER MONOLOGUE");
  });

  test("includes Tools section in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## Tools");
    expect(prompt).toContain("memory_list");
    expect(prompt).toContain("memory_read");
    expect(prompt).toContain("memory_write");
    expect(prompt).toContain("memory_patch");
    expect(prompt).toContain("memory_append");
    expect(prompt).toContain("spawn_subagent");
    expect(prompt).toContain("spawn_subagent");
    expect(prompt).toContain("resume_subagent");
    expect(prompt).toContain("current_time");
    expect(prompt).toContain("session_archive_read");
  });

  test("Tools section organizes tools by category", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    // Verify sub-headers exist
    expect(prompt).toContain("### Communication");
    expect(prompt).toContain("### Delegation");
    expect(prompt).toContain("### Projects");
    expect(prompt).toContain("### Skills");
    expect(prompt).toContain("### Memory");
    expect(prompt).toContain("### Context");

    // Verify delegation tools are under Delegation, not Communication
    const delegationIdx = prompt.indexOf("### Delegation");
    const projectsIdx = prompt.indexOf("### Projects");
    const spawnSubagentIdx = prompt.indexOf("spawn_subagent");
    const resumeSubagentIdx = prompt.indexOf("resume_subagent");

    // spawn_subagent and resume_subagent should be between Delegation and Projects headers
    expect(spawnSubagentIdx).toBeGreaterThan(delegationIdx);
    expect(spawnSubagentIdx).toBeLessThan(projectsIdx);
    expect(resumeSubagentIdx).toBeGreaterThan(delegationIdx);
    expect(resumeSubagentIdx).toBeLessThan(projectsIdx);
  });

  test("does NOT include Tools section in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("## Tools");
  });

  test("includes Thinking Style merged into How You Think in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("token-efficient");
  });

  test("does NOT include separate Thinking Style section in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("token-efficient");
  });

  test("includes Delegation in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## Delegation");
  });

  test("delegation section has sub-sections with examples and flowchart", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    // Sub-section headers (preserved from original, with bg_run added)
    expect(prompt).toContain("### reply() — Handle It Yourself");
    expect(prompt).toContain("### bg_run() — Long-Running");
    expect(prompt).toContain("### spawn_subagent() — Multi-Step Reasoning");
    expect(prompt).toContain("### create_project() — Long-Lived Effort");
    // Decision Flowchart
    expect(prompt).toContain("### Decision Flowchart");
    // After Delegation
    expect(prompt).toContain("### After Delegation");
    // Concrete examples
    expect(prompt).toContain("Research top 5 frameworks");
    // spawn_subagent is the delegation tool
    expect(prompt).toContain("spawn_subagent(type=");
  });

  test("does NOT include Delegation in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("## Delegation");
  });

  test("includes Channels in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## Channels and reply()");
  });

  test("does NOT include Channels in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("## Channels and reply()");
  });

  test("includes Session History in main mode", () => {
    const prompt = buildSystemPrompt({ mode: "main", persona });
    expect(prompt).toContain("## Session History");
  });

  test("does NOT include Session History in task mode", () => {
    const prompt = buildSystemPrompt({ mode: "task", persona });
    expect(prompt).not.toContain("## Session History");
  });

  // Task-only: AI task type prompt
  test("appends AI task prompt in task mode", () => {
    const prompt = buildSystemPrompt({
      mode: "task",
      persona,
      subAgentPrompt: "## Your Role\nYou are a research assistant.",
    });
    expect(prompt).toContain("research assistant");
  });

  test("does NOT append AI task prompt in main mode even if provided", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona,
      subAgentPrompt: "## Your Role\nYou are a research assistant.",
    });
    expect(prompt).not.toContain("research assistant");
  });

  // AI task type metadata (main only)
  test("includes AI task type metadata in main mode when provided", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona,
      subAgentMetadata: "## Available AI Task Types\n- explore: read-only research",
    });
    expect(prompt).toContain("Available AI Task Types");
  });

  // Skill metadata (main only)
  test("includes skill metadata in main mode when provided", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona,
      skillMetadata: "## Available Skills\n- commit: git commit helper",
    });
    expect(prompt).toContain("Available Skills");
  });

  test("includes skill metadata in task mode (for project agents)", () => {
    const prompt = buildSystemPrompt({
      mode: "task",
      persona,
      skillMetadata: "## Available Skills\n- commit: git commit helper",
    });
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("commit: git commit helper");
  });

  // Backward compat: no mode defaults to "task"
  test("no mode defaults to task mode for backward compatibility", () => {
    const prompt = buildSystemPrompt({ persona });
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("## Safety");
    expect(prompt).not.toContain("## How You Think");
  });

  // formatSize (unchanged)
  test("formatSize formats bytes correctly", () => {
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(2560)).toBe("2.5KB");
  });
});

// ── Prompt structure integration tests ────────────────────

describe("buildSystemPrompt - prompt structure", () => {
  const persona: Persona = {
    name: "Pegasus",
    role: "personal AI assistant",
    personality: ["curious", "precise"],
    style: "clear and direct",
    values: ["accuracy", "helpfulness"],
  };

  test("main mode prompt has correct section order", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona,
      subAgentMetadata: "## Available AI Task Types\n- explore: research",
      skillMetadata: "## Available Skills\n- commit: git",
    });

    const safetyIdx = prompt.indexOf("## Safety");
    const thinkIdx = prompt.indexOf("## How You Think");
    const toolsIdx = prompt.indexOf("## Tools");
    const delegateIdx = prompt.indexOf("## Delegation");
    const subAgentIdx = prompt.indexOf("## Available AI Task Types");
    const channelIdx = prompt.indexOf("## Channels and reply()");
    const sessionIdx = prompt.indexOf("## Session History");
    const skillIdx = prompt.indexOf("## Available Skills");

    // All sections present
    expect(safetyIdx).toBeGreaterThan(0);
    expect(thinkIdx).toBeGreaterThan(0);
    expect(toolsIdx).toBeGreaterThan(0);
    expect(delegateIdx).toBeGreaterThan(0);
    expect(subAgentIdx).toBeGreaterThan(0);
    expect(channelIdx).toBeGreaterThan(0);
    expect(sessionIdx).toBeGreaterThan(0);
    expect(skillIdx).toBeGreaterThan(0);

    // Correct order
    expect(safetyIdx).toBeLessThan(thinkIdx);
    expect(thinkIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(delegateIdx);
    expect(delegateIdx).toBeLessThan(subAgentIdx);
    expect(subAgentIdx).toBeLessThan(channelIdx);
    expect(channelIdx).toBeLessThan(sessionIdx);
    expect(sessionIdx).toBeLessThan(skillIdx);
  });

  test("task mode prompt is minimal", () => {
    const prompt = buildSystemPrompt({
      mode: "task",
      persona,
      subAgentPrompt: "## Your Role\nYou are a research assistant.\n\n## Rules\n1. READ ONLY",
    });

    // Has: identity + safety + AI task type prompt
    expect(prompt).toContain("Pegasus");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Your Role");
    expect(prompt).toContain("READ ONLY");

    // Does NOT have main-only sections
    expect(prompt).not.toContain("## How You Think");
    expect(prompt).not.toContain("## Tools");
    expect(prompt).not.toContain("## Delegation");
    expect(prompt).not.toContain("## Channels");
    expect(prompt).not.toContain("## Session History");
  });

  test("main mode prompt does not contain AI task type body", () => {
    const prompt = buildSystemPrompt({
      mode: "main",
      persona,
      subAgentPrompt: "## Your Role\nYou are a research assistant.",
    });
    expect(prompt).not.toContain("You are a research assistant");
  });

  test("SubAgent persona background injects system prompt into identity section", () => {
    const subAgentPersona: Persona = {
      name: "SubAgent",
      role: "autonomous orchestrator",
      personality: ["focused", "systematic", "autonomous"],
      style: "concise and task-oriented",
      values: ["accuracy", "efficiency", "thoroughness"],
      background: [
        "## Your Role",
        "",
        "You are a SubAgent — an autonomous orchestrator.",
        "",
        "## Rules",
        "",
        "1. FOCUS: Stay strictly on the task you were given.",
      ].join("\n"),
    };

    // task mode (SubAgent's Thinker uses default task mode)
    const prompt = buildSystemPrompt({ mode: "task", persona: subAgentPersona });
    expect(prompt).toContain("SubAgent");
    expect(prompt).toContain("autonomous orchestrator");
    expect(prompt).toContain("FOCUS: Stay strictly on the task");

    // Verify it does NOT include main-only sections
    expect(prompt).not.toContain("## How You Think");
    expect(prompt).not.toContain("## Tools");
  });
});

describe("buildRuntimeSection", () => {
  test("returns a single line with runtime info", () => {
    const lines = buildRuntimeSection();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Runtime:/);
  });

  test("includes platform, timezone, date, cwd", () => {
    const line = buildRuntimeSection()[0]!;
    expect(line).toContain(process.platform);
    expect(line).toContain("tz:");
    expect(line).toContain("date:");
    expect(line).toContain("cwd:");
  });

  test("date is in YYYY-MM-DD format", () => {
    const line = buildRuntimeSection()[0]!;
    const dateMatch = line.match(/date: (\d{4}-\d{2}-\d{2})/);
    expect(dateMatch).not.toBeNull();
  });
});
