import { describe, it, expect } from "bun:test";
import { createAppStats } from "@pegasus/stats/app-stats.ts";
import type { AppStats } from "@pegasus/stats/app-stats.ts";

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
