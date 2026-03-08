/**
 * Tests for SubAgentTypeRegistry — registration, priority resolution,
 * tool/prompt/model resolution, and metadata generation.
 */
import { describe, expect, test } from "bun:test";
import { SubAgentTypeRegistry } from "@pegasus/agents/subagents/registry.ts";
import type { SubAgentTypeDefinition } from "@pegasus/agents/subagents/types.ts";

function makeDef(overrides?: Partial<SubAgentTypeDefinition>): SubAgentTypeDefinition {
  return {
    name: "test-agent",
    description: "A test agent",
    tools: ["*"],
    prompt: "You are a test agent.",
    source: "builtin",
    ...overrides,
  };
}

describe("SubAgentTypeRegistry", () => {
  // ── Basic registration and retrieval ─────────────────────

  test("get() returns registered definition", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "explore" })]);
    const def = reg.get("explore");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("explore");
  });

  test("get() returns null for unknown name", () => {
    const reg = new SubAgentTypeRegistry();
    expect(reg.get("nonexistent")).toBeNull();
  });

  test("has() returns true for registered, false for unknown", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "explore" })]);
    expect(reg.has("explore")).toBe(true);
    expect(reg.has("unknown")).toBe(false);
  });

  test("listAll() returns all registered definitions", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef({ name: "explore" }),
      makeDef({ name: "plan" }),
    ]);
    const all = reg.listAll();
    expect(all.length).toBe(2);
  });

  // ── Priority resolution ──────────────────────────────────

  test("user source overrides builtin source", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef({ name: "explore", description: "builtin version", source: "builtin" }),
      makeDef({ name: "explore", description: "user version", source: "user" }),
    ]);
    expect(reg.get("explore")!.description).toBe("user version");
  });

  test("builtin does not override existing user source", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef({ name: "explore", description: "user version", source: "user" }),
      makeDef({ name: "explore", description: "builtin version", source: "builtin" }),
    ]);
    expect(reg.get("explore")!.description).toBe("user version");
  });

  // ── getPrompt ────────────────────────────────────────────

  test("getPrompt() returns prompt for known AI task type", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "explore", prompt: "You explore." })]);
    expect(reg.getPrompt("explore")).toBe("You explore.");
  });

  test("getPrompt() returns empty string for unknown AI task type", () => {
    const reg = new SubAgentTypeRegistry();
    expect(reg.getPrompt("unknown")).toBe("");
  });

  // ── getModel ─────────────────────────────────────────────

  test("getModel() returns tier name model field", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "explore", model: "fast" })]);
    expect(reg.getModel("explore")).toBe("fast");
  });

  test("getModel() returns specific model spec", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "custom", model: "openai/gpt-4o-mini" })]);
    expect(reg.getModel("custom")).toBe("openai/gpt-4o-mini");
  });

  test("getModel() returns undefined for AI task type without model", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "no-model" })]);
    expect(reg.getModel("no-model")).toBeUndefined();
  });

  test("getModel() returns undefined for unknown AI task type", () => {
    const reg = new SubAgentTypeRegistry();
    expect(reg.getModel("nonexistent")).toBeUndefined();
  });

  test("getModel() reflects user override model", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef({ name: "explore", model: "fast", source: "builtin" }),
      makeDef({ name: "explore", model: "openai/gpt-4o", source: "user" }),
    ]);
    expect(reg.getModel("explore")).toBe("openai/gpt-4o");
  });

  // ── getToolNames ─────────────────────────────────────────

  test("getToolNames() expands '*' to all task tool names", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "general", tools: ["*"] })]);
    const names = reg.getToolNames("general");
    expect(names.length).toBeGreaterThan(0);
    // Should contain actual tool names, not "*"
    expect(names).not.toContain("*");
  });

  test("getToolNames() returns specific tools when listed", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([makeDef({ name: "explore", tools: ["read_file", "grep_files"] })]);
    expect(reg.getToolNames("explore")).toEqual(["read_file", "grep_files"]);
  });

  test("getToolNames() falls back to all tools for unknown AI task type", () => {
    const reg = new SubAgentTypeRegistry();
    const names = reg.getToolNames("unknown");
    expect(names.length).toBeGreaterThan(0);
  });

  // ── getMetadataForPrompt ─────────────────────────────────

  test("getMetadataForPrompt() includes registered AI task type names and descriptions", () => {
    const reg = new SubAgentTypeRegistry();
    reg.registerMany([
      makeDef({ name: "explore", description: "Read-only research" }),
      makeDef({ name: "general", description: "Full access" }),
    ]);
    const metadata = reg.getMetadataForPrompt();
    expect(metadata).toContain("explore");
    expect(metadata).toContain("Read-only research");
    expect(metadata).toContain("general");
    expect(metadata).toContain("Full access");
  });
});
