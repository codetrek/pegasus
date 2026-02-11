import { describe, expect, test } from "bun:test";
import { loadPersona, PersonaSchema } from "@pegasus/identity/persona.ts";
import { buildSystemPrompt } from "@pegasus/identity/prompt.ts";
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

  test("includes persona name and role", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("digital employee");
  });

  test("includes personality traits", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("professional");
    expect(prompt).toContain("helpful");
  });

  test("includes style", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("concise and warm");
  });

  test("includes values", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("accuracy");
    expect(prompt).toContain("empathy");
  });

  test("perceive stage adds JSON instruction", () => {
    const prompt = buildSystemPrompt(persona, "perceive");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("taskType");
  });

  test("think stage adds response instruction", () => {
    const prompt = buildSystemPrompt(persona, "think");
    expect(prompt.toLowerCase()).toContain("respond");
  });

  test("plan stage adds planning instruction", () => {
    const prompt = buildSystemPrompt(persona, "plan");
    expect(prompt.toLowerCase()).toContain("plan");
  });

  test("reflect stage adds evaluation instruction", () => {
    const prompt = buildSystemPrompt(persona, "reflect");
    expect(prompt.toLowerCase()).toContain("evaluate");
  });

  test("no stage returns base prompt only", () => {
    const prompt = buildSystemPrompt(persona);
    // Should not contain stage-specific instructions
    expect(prompt).not.toContain("taskType");
  });

  test("includes background when present", () => {
    const personaWithBg: Persona = {
      ...persona,
      background: "Expert in AI systems",
    };
    const prompt = buildSystemPrompt(personaWithBg);
    expect(prompt).toContain("Expert in AI systems");
  });

  test("works without background", () => {
    // persona without background should still produce valid prompt
    const prompt = buildSystemPrompt(persona);
    expect(prompt.length).toBeGreaterThan(50);
  });
});
