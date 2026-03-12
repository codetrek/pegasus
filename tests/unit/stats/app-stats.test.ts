import { describe, it, expect } from "bun:test";
import { createAppStats, recordLLMUsage, recordToolCall } from "@pegasus/stats/app-stats.ts";

describe("AppStats", () => {
  it("creates stats with default values", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    expect(stats.persona).toBe("Atlas");
    expect(stats.status).toBe("idle");
    expect(stats.startedAt).toBeGreaterThan(0);
    expect(stats.model.provider).toBe("openai");
    expect(stats.model.modelId).toBe("gpt-4o");
    expect(stats.model.contextWindow).toBe(128000);
    expect(stats.llm.byModel).toEqual({});
    expect(stats.llm.compacts).toBe(0);
    expect(stats.budget.used).toBe(0);
    expect(stats.budget.total).toBe(128000);
    expect(stats.budget.compactThreshold).toBe(0.75);
    expect(stats.subagents.active).toBe(0);
    expect(stats.subagents.completed).toBe(0);
    expect(stats.subagents.failed).toBe(0);
    expect(stats.tools.total).toBe(0);
    expect(stats.tools.calls).toBe(0);
    expect(stats.memory.factCount).toBe(0);
    expect(stats.memory.episodeCount).toBe(0);
    expect(stats.channels).toEqual([]);
  });
});

describe("recordLLMUsage", () => {
  it("updates lastCall and byModel (budget.used is owned by MainAgent, not recordLLMUsage)", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordLLMUsage(stats, {
      model: "gpt-4o", promptTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, outputTokens: 100, latencyMs: 1500,
    });
    expect(stats.llm.lastCall).toEqual({ model: "gpt-4o", promptTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, outputTokens: 100, latencyMs: 1500 });
    expect(stats.llm.byModel["gpt-4o"]!.calls).toBe(1);
    expect(stats.llm.byModel["gpt-4o"]!.totalPromptTokens).toBe(1000);
    expect(stats.llm.byModel["gpt-4o"]!.totalOutputTokens).toBe(100);
    expect(stats.budget.used).toBe(0); // budget.used NOT updated by recordLLMUsage
  });

  it("accumulates across multiple calls", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordLLMUsage(stats, { model: "gpt-4o", promptTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, latencyMs: 500 });
    recordLLMUsage(stats, { model: "gpt-4o", promptTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 80, latencyMs: 600 });
    expect(stats.llm.byModel["gpt-4o"]!.calls).toBe(2);
    expect(stats.llm.byModel["gpt-4o"]!.totalPromptTokens).toBe(300);
    expect(stats.llm.byModel["gpt-4o"]!.totalOutputTokens).toBe(130);
    expect(stats.budget.used).toBe(0); // budget.used NOT updated by recordLLMUsage
  });
});

describe("recordToolCall", () => {
  it("increments success counter", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordToolCall(stats, true);
    expect(stats.tools.calls).toBe(1);
    expect(stats.tools.success).toBe(1);
    expect(stats.tools.fail).toBe(0);
  });

  it("increments fail counter", () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    recordToolCall(stats, false);
    expect(stats.tools.calls).toBe(1);
    expect(stats.tools.success).toBe(0);
    expect(stats.tools.fail).toBe(1);
  });
});
