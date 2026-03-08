/**
 * Tests for subagent_status tool — runtime subagent state query.
 */
import { describe, it, expect } from "bun:test";
import { subagent_status } from "../../../src/agents/tools/builtins/subagent-status-tool.ts";
import type { SubagentRegistryLike } from "../../../src/agents/tools/tool-context.ts";

describe("subagent_status", () => {
  it("should return error when subagentRegistry is not in context", async () => {
    const result = await subagent_status.execute({}, { agentId: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("subagent management not available");
  });

  describe("SubagentRegistry interface", () => {
    function createMockRegistry(subagents: Array<{
      subagentId: string;
      taskType: string;
      description: string;
      source: string;
      startedAt: number;
    }> = []): SubagentRegistryLike {
      return {
        getStatus(subagentId: string) {
          return subagents.find((s) => s.subagentId === subagentId) ?? null;
        },
        listAll() {
          return [...subagents];
        },
        get activeCount() {
          return subagents.length;
        },
        submit() { return "mock-id"; },
        async resume() { return "mock-result"; },
      };
    }

    it("should list all active subagents when no subagentId is specified", async () => {
      const registry = createMockRegistry([
        { subagentId: "tr-1", taskType: "web_search", description: "Search weather", source: "main-agent", startedAt: 1000 },
        { subagentId: "tr-2", taskType: "general", description: "Do something", source: "skill:test", startedAt: 2000 },
      ]);

      const result = await subagent_status.execute(
        {},
        { agentId: "test", subagentRegistry: registry },
      );
      expect(result.success).toBe(true);
      const data = result.result as { subagents: Array<{ subagentId: string; state: string; description: string; taskType: string }>; activeCount: number; totalCount: number };
      expect(data.activeCount).toBe(2);
      expect(data.totalCount).toBe(2);
      expect(data.subagents).toHaveLength(2);
      expect(data.subagents[0]!.subagentId).toBe("tr-1");
      expect(data.subagents[0]!.state).toBe("running");
      expect(data.subagents[0]!.description).toBe("Search weather");
      expect(data.subagents[0]!.taskType).toBe("web_search");
      expect(data.subagents[1]!.subagentId).toBe("tr-2");
    });

    it("should query a specific active subagent by subagentId", async () => {
      const registry = createMockRegistry([
        { subagentId: "tr-42", taskType: "general", description: "Active subagent", source: "main-agent", startedAt: 5000 },
      ]);

      const result = await subagent_status.execute(
        { subagentId: "tr-42" },
        { agentId: "test", subagentRegistry: registry },
      );
      expect(result.success).toBe(true);
      const data = result.result as { subagentId: string; state: string; description: string; taskType: string; source: string; startedAt: number };
      expect(data.subagentId).toBe("tr-42");
      expect(data.state).toBe("running");
      expect(data.description).toBe("Active subagent");
      expect(data.taskType).toBe("general");
      expect(data.source).toBe("main-agent");
      expect(data.startedAt).toBe(5000);
    });

    it("should return not_found for unknown subagentId", async () => {
      const registry = createMockRegistry([]);

      const result = await subagent_status.execute(
        { subagentId: "nonexistent" },
        { agentId: "test", subagentRegistry: registry },
      );
      expect(result.success).toBe(true);
      const data = result.result as { status: string };
      expect(data.status).toBe("not_found");
    });

    it("should show activeCount from registry", async () => {
      const registry = createMockRegistry([
        { subagentId: "tr-a", taskType: "general", description: "Subagent A", source: "main", startedAt: 100 },
      ]);

      const result = await subagent_status.execute(
        {},
        { agentId: "test", subagentRegistry: registry },
      );
      expect(result.success).toBe(true);
      const data = result.result as { activeCount: number; totalCount: number };
      expect(data.activeCount).toBe(1);
      expect(data.totalCount).toBe(1);
    });

    it("should return empty list when no subagents are active", async () => {
      const registry = createMockRegistry([]);

      const result = await subagent_status.execute(
        {},
        { agentId: "test", subagentRegistry: registry },
      );
      expect(result.success).toBe(true);
      const data = result.result as { subagents: unknown[]; activeCount: number; totalCount: number };
      expect(data.subagents).toHaveLength(0);
      expect(data.activeCount).toBe(0);
      expect(data.totalCount).toBe(0);
    });

    it("should handle registry errors gracefully", async () => {
      const brokenRegistry: SubagentRegistryLike = {
        getStatus() { throw new Error("Registry crashed"); },
        listAll() { throw new Error("Registry crashed"); },
        get activeCount() { return 0; },
        submit() { return "mock-id"; },
        async resume() { return "mock-result"; },
      };

      const result = await subagent_status.execute(
        {},
        { agentId: "test", subagentRegistry: brokenRegistry },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Registry crashed");
    });
  });
});
