/**
 * Tests for Agent + PendingTracker integration:
 * - PendingTracker correctly persists/recovers subagent and bg_run entries
 * - Agent.onStart() recovers pending entries and injects session messages
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PendingTracker } from "../../../src/agents/pending-tracker.ts";
import { Agent } from "../../../src/agents/agent.ts";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import { SubAgentTypeRegistry } from "../../../src/agents/subagents/registry.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";

const testDir = "/tmp/pegasus-test-agent-recovery";
const sessionDir = path.join(testDir, "session");

// ── Helpers ──────────────────────────────────────────

function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    generate: mock(async () => ({
      text: "done",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    })),
  };
}

function createAgentWithSubagentConfig(): Agent {
  return new Agent({
    agentId: "test-recovery",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    systemPrompt: "test",
    sessionDir,
    subagentConfig: {
      subagentTypeRegistry: new SubAgentTypeRegistry(),
      subagentsDir: path.join(testDir, "subagents"),
      onNotification: () => {},
    },
  });
}

// ── Tests ────────────────────────────────────────────

describe("Agent pending recovery", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("PendingTracker data shapes", () => {
    let tracker: PendingTracker;

    beforeEach(() => {
      tracker = new PendingTracker(sessionDir);
    });

    it("recover() should return subagent entries with correct fields", async () => {
      tracker.add({
        id: "sub-abc123",
        kind: "subagent",
        ts: 1000,
        description: "Explore auth",
        agentType: "explore",
      });
      await tracker.flush();

      const tracker2 = new PendingTracker(sessionDir);
      const recovered = await tracker2.recover();

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toEqual({
        id: "sub-abc123",
        kind: "subagent",
        ts: 1000,
        description: "Explore auth",
        agentType: "explore",
      });
    });

    it("recover() should return bg_run entries with correct fields", async () => {
      tracker.add({
        id: "bg-xyz789",
        kind: "bg_run",
        ts: 2000,
        tool: "shell_exec",
      });
      await tracker.flush();

      const tracker2 = new PendingTracker(sessionDir);
      const recovered = await tracker2.recover();

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toEqual({
        id: "bg-xyz789",
        kind: "bg_run",
        ts: 2000,
        tool: "shell_exec",
      });
    });

    it("recover() should return mixed entries in order", async () => {
      tracker.add({ id: "sub-1", kind: "subagent", ts: 1, description: "a" });
      tracker.add({ id: "bg-2", kind: "bg_run", ts: 2, tool: "shell_exec" });
      tracker.add({ id: "sub-3", kind: "subagent", ts: 3, description: "c" });
      await tracker.flush();

      const tracker2 = new PendingTracker(sessionDir);
      const recovered = await tracker2.recover();

      expect(recovered).toHaveLength(3);
      expect(recovered.map((e) => e.id)).toEqual(["sub-1", "bg-2", "sub-3"]);
    });
  });

  describe("Agent.onStart() recovery integration", () => {
    it("should inject recovery messages into session on startup", async () => {
      // Simulate a crash: write pending.json with remnant entries
      await writeFile(
        path.join(sessionDir, "pending.json"),
        JSON.stringify([
          { id: "sub-crashed", kind: "subagent", ts: 1000, description: "Analyze data", agentType: "general" },
          { id: "bg-crashed", kind: "bg_run", ts: 2000, tool: "shell_exec" },
        ]),
        "utf-8",
      );

      // Create agent and start it — onStart() should recover
      const agent = createAgentWithSubagentConfig();
      await agent.start();

      // Session messages should contain recovery notifications
      const messages = (agent as any).sessionMessages as Array<{ role: string; content: string }>;

      // Find recovery messages
      const recoveryMsgs = messages.filter((m) => m.content.includes("[Recovery]"));
      expect(recoveryMsgs).toHaveLength(2);

      // Verify subagent recovery message
      expect(recoveryMsgs[0]!.content).toContain("sub-crashed");
      expect(recoveryMsgs[0]!.content).toContain("general");
      expect(recoveryMsgs[0]!.content).toContain("Analyze data");
      expect(recoveryMsgs[0]!.content).toContain("resume_subagent");

      // Verify bg_run recovery message
      expect(recoveryMsgs[1]!.content).toContain("bg-crashed");
      expect(recoveryMsgs[1]!.content).toContain("shell_exec");
      expect(recoveryMsgs[1]!.content).toContain("no longer exists");

      await agent.stop();
    }, 10_000);

    it("should clear pending.json after recovery", async () => {
      await writeFile(
        path.join(sessionDir, "pending.json"),
        JSON.stringify([
          { id: "sub-old", kind: "subagent", ts: 1000, description: "Old task", agentType: "explore" },
        ]),
        "utf-8",
      );

      const agent = createAgentWithSubagentConfig();
      await agent.start();

      // pending.json should be cleared
      const { readFile } = await import("node:fs/promises");
      const content = JSON.parse(await readFile(path.join(sessionDir, "pending.json"), "utf-8"));
      expect(content).toEqual([]);

      await agent.stop();
    }, 10_000);

    it("should not inject messages when pending.json is empty", async () => {
      const agent = createAgentWithSubagentConfig();
      await agent.start();

      const messages = (agent as any).sessionMessages as Array<{ role: string; content: string }>;
      const recoveryMsgs = messages.filter((m) => m.content.includes("[Recovery]"));
      expect(recoveryMsgs).toHaveLength(0);

      await agent.stop();
    }, 10_000);
  });
});
