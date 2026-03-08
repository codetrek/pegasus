/**
 * Tests for Agent.resume() — resumes a previously-submitted subagent
 * by appending new user input and re-running from persisted session.
 *
 * Replaces the former task-runner-resume.test.ts. Now that Agent owns
 * subagent management directly (TaskRunner was deleted), we test the
 * same functionality through Agent with subagentConfig.
 *
 * Also tests _loadSubagentIndex() internals via the public resume() surface.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Agent, type SubagentNotification } from "../../../src/agents/agent.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { SubAgentTypeRegistry } from "../../../src/agents/subagents/registry.ts";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ──────────────────────────────────────────

/** Create a mock LanguageModel that resolves immediately. */
function createMockModel(
  generateFn?: LanguageModel["generate"],
): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    generate:
      generateFn ??
      mock(async () => ({
        text: "task done",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      })),
  };
}

/**
 * Create a mock model whose generate() blocks on a promise.
 * Returns [model, resolve] — call resolve() to let the LLM call complete.
 */
function createBlockingModel(): [LanguageModel, () => void] {
  let resolver: () => void;
  const gate = new Promise<void>((r) => { resolver = r; });

  const model: LanguageModel = {
    provider: "test",
    modelId: "test-blocking",
    generate: mock(async () => {
      await gate;
      return {
        text: "blocking done",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    }),
  };

  return [model, resolver!];
}

let tempDir: string;

interface CreateAgentOpts {
  model?: LanguageModel;
  onNotification?: (n: SubagentNotification) => void;
}

function createAgentWithSubagents(overrides?: CreateAgentOpts): Agent {
  return new Agent({
    agentId: "test-agent",
    model: overrides?.model ?? createMockModel(),
    toolRegistry: new ToolRegistry(),
    systemPrompt: "test",
    sessionDir: path.join(tempDir, "session"),
    subagentConfig: {
      subagentTypeRegistry: new SubAgentTypeRegistry(),
      subagentsDir: tempDir,
      onNotification: overrides?.onNotification ?? mock((_n: SubagentNotification) => {}),
    },
  });
}

/** Write an index.jsonl with given entries. */
async function writeIndex(
  subagentsDir: string,
  entries: Array<{ subagentId: string; date: string }>,
): Promise<void> {
  await mkdir(subagentsDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path.join(subagentsDir, "index.jsonl"), content, "utf-8");
}

/** Write a minimal session file so Agent.run() can load it. */
async function writeSession(
  subagentsDir: string,
  date: string,
  agentId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  const sessionDir = path.join(subagentsDir, date, agentId);
  await mkdir(sessionDir, { recursive: true });
  const lines = messages
    .map((m) => JSON.stringify({ ts: Date.now(), role: m.role, content: m.content }))
    .join("\n") + "\n";
  await writeFile(path.join(sessionDir, "current.jsonl"), lines, "utf-8");
}

/** Wait for notifications to arrive (fire-and-forget needs a tick). */
async function waitForNotifications(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────

describe("Agent.resume", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-resume-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("resume with valid agentId", () => {
    test("loads session, appends new input, and returns agentId", async () => {
      const agentId = "abc123def456";
      const date = "2026-03-06";

      // Set up index and existing session
      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "original input" },
        { role: "assistant", content: "original response" },
      ]);

      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      const result = await agent.resume(agentId, "follow up input");

      expect(result).toBe(agentId);
      expect(agent.activeCount).toBe(1);

      // Verify the new message was appended to session
      const sessionPath = path.join(tempDir, date, agentId, "current.jsonl");
      const content = await readFile(sessionPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(3); // original user + assistant + new user
      const lastEntry = JSON.parse(lines[2]!);
      expect(lastEntry.role).toBe("user");
      expect(lastEntry.content).toBe("follow up input");
    }, 5000);

    test("sends completed notification after agent finishes", async () => {
      const agentId = "task123running1";
      const date = "2026-03-06";

      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "original" },
      ]);

      const notifications: SubagentNotification[] = [];
      const onNotification = mock((n: SubagentNotification) => {
        notifications.push(n);
      });

      const agent = createAgentWithSubagents({ onNotification });
      await agent.resume(agentId, "continue please");

      await waitForNotifications();

      const completed = notifications.find((n) => n.type === "completed");
      expect(completed).toBeDefined();
      expect(completed!.subagentId).toBe(agentId);
    }, 5000);
  });

  describe("resume with unknown agentId", () => {
    test("throws when agentId not in index", async () => {
      // Empty index
      await writeIndex(tempDir, []);
      const agent = createAgentWithSubagents();

      await expect(
        agent.resume("nonexistent-id", "some input"),
      ).rejects.toThrow("Subagent nonexistent-id not found in subagent index");
    }, 5000);

    test("throws when index file does not exist", async () => {
      // No index file at all
      const agent = createAgentWithSubagents();

      await expect(
        agent.resume("missing-id", "some input"),
      ).rejects.toThrow("Subagent missing-id not found in subagent index");
    }, 5000);
  });

  describe("resume creates Agent and calls run()", () => {
    test("creates agent with correct sessionDir and fires run()", async () => {
      const agentId = "agent-run-test1";
      const date = "2026-03-05";

      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "first message" },
      ]);

      // Spy on Agent.prototype.run
      const originalRun = Agent.prototype.run;
      let runCalled = false;
      Agent.prototype.run = async function () {
        runCalled = true;
        return {
          success: true,
          result: "resumed result",
          llmCallCount: 1,
        };
      };

      try {
        const agent = createAgentWithSubagents();
        await agent.resume(agentId, "new instruction");

        await waitForNotifications();

        expect(runCalled).toBe(true);
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);

    test("uses provided agentType and description", async () => {
      const agentId = "custom-type-test";
      const date = "2026-03-04";

      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "start" },
      ]);

      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      await agent.resume(agentId, "do more", "explore", "Exploration task");

      const status = agent.getStatus(agentId);
      expect(status).not.toBeNull();
      expect(status!.agentType).toBe("explore");
      expect(status!.description).toBe("Exploration task");
      expect(status!.source).toBe("resume");
    }, 5000);

    test("defaults agentType to 'general' when not provided", async () => {
      const agentId = "default-type-tst";
      const date = "2026-03-03";

      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "start" },
      ]);

      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      await agent.resume(agentId, "continue");

      const status = agent.getStatus(agentId);
      expect(status).not.toBeNull();
      expect(status!.agentType).toBe("general");
    }, 5000);
  });

  describe("_loadSubagentIndex", () => {
    test("parses index.jsonl correctly with multiple entries", async () => {
      await writeIndex(tempDir, [
        { subagentId: "task-aaa", date: "2026-03-01" },
        { subagentId: "task-bbb", date: "2026-03-02" },
        { subagentId: "task-ccc", date: "2026-03-03" },
      ]);

      // We test _loadSubagentIndex indirectly: resume succeeds for known IDs,
      // throws for unknown ones
      await writeSession(tempDir, "2026-03-02", "task-bbb", [
        { role: "user", content: "hello" },
      ]);

      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      // Should find task-bbb
      const result = await agent.resume("task-bbb", "follow up");
      expect(result).toBe("task-bbb");

      // Should not find task-zzz
      await expect(
        agent.resume("task-zzz", "nope"),
      ).rejects.toThrow("Subagent task-zzz not found in subagent index");
    }, 5000);

    test("returns empty map when index file is missing", async () => {
      // No index file written — _loadSubagentIndex should return empty map,
      // causing resume to throw "not found"
      const agent = createAgentWithSubagents();

      await expect(
        agent.resume("any-id", "input"),
      ).rejects.toThrow("Subagent any-id not found in subagent index");
    }, 5000);

    test("handles index with single entry", async () => {
      await writeIndex(tempDir, [{ subagentId: "solo-task", date: "2026-01-15" }]);
      await writeSession(tempDir, "2026-01-15", "solo-task", [
        { role: "user", content: "original" },
      ]);

      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      const result = await agent.resume("solo-task", "more input");
      expect(result).toBe("solo-task");
      expect(agent.activeCount).toBe(1);
    }, 5000);
  });

  describe("resume agent failure handling", () => {
    test("sends failed notification when agent.run() rejects", async () => {
      const agentId = "fail-resume-tst";
      const date = "2026-03-06";

      await writeIndex(tempDir, [{ subagentId: agentId, date }]);
      await writeSession(tempDir, date, agentId, [
        { role: "user", content: "start" },
      ]);

      const notifications: SubagentNotification[] = [];
      const onNotification = mock((n: SubagentNotification) => {
        notifications.push(n);
      });

      // Monkeypatch to simulate failure
      const originalRun = Agent.prototype.run;
      Agent.prototype.run = async function () {
        throw new Error("agent crashed on resume");
      };

      try {
        const agent = createAgentWithSubagents({ onNotification });
        await agent.resume(agentId, "continue");

        await waitForNotifications();

        const failedCall = notifications.find((n) => n.type === "failed");
        expect(failedCall).toBeDefined();
        expect(failedCall!.subagentId).toBe(agentId);
        expect((failedCall as any).error).toBe("agent crashed on resume");
        expect(agent.activeCount).toBe(0);
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);
  });
});
