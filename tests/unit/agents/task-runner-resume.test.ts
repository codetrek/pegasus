/**
 * Tests for TaskRunner.resume() — resumes a previously-submitted task
 * by appending new user input and re-running from persisted session.
 *
 * Also tests _loadIndex() internals via the public resume() surface.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TaskRunner, type TaskRunnerDeps } from "../../../src/agents/task-runner.ts";
import type { TaskNotification } from "../../../src/agents/task-runner.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { AITaskTypeRegistry } from "../../../src/aitask-types/registry.ts";
import { Agent } from "../../../src/agents/agent.ts";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
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

function createDeps(overrides?: Partial<TaskRunnerDeps>): TaskRunnerDeps {
  return {
    model: createMockModel(),
    taskTypeRegistry: new AITaskTypeRegistry(),
    tasksDir: tempDir,
    onNotification: mock((_n: TaskNotification) => {}),
    ...overrides,
  };
}

/** Write an index.jsonl with given entries. */
async function writeIndex(
  tasksDir: string,
  entries: Array<{ taskId: string; date: string }>,
): Promise<void> {
  await mkdir(tasksDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path.join(tasksDir, "index.jsonl"), content, "utf-8");
}

/** Write a minimal session file so Agent.run() can load it. */
async function writeSession(
  tasksDir: string,
  date: string,
  taskId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  const sessionDir = path.join(tasksDir, date, taskId);
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

describe("TaskRunner.resume", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-resume-test-"));
  });

  describe("resume with valid taskId", () => {
    test("loads session, appends new input, and returns taskId", async () => {
      const taskId = "abc123def456";
      const date = "2026-03-06";

      // Set up index and existing session
      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
        { role: "user", content: "original input" },
        { role: "assistant", content: "original response" },
      ]);

      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      const result = await runner.resume(taskId, "follow up input");

      expect(result).toBe(taskId);
      expect(runner.activeCount).toBe(1);

      // Verify the new message was appended to session
      const sessionPath = path.join(tempDir, date, taskId, "current.jsonl");
      const content = await readFile(sessionPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(3); // original user + assistant + new user
      const lastEntry = JSON.parse(lines[2]!);
      expect(lastEntry.role).toBe("user");
      expect(lastEntry.content).toBe("follow up input");
    }, 5000);

    test("sends completed notification after agent finishes", async () => {
      const taskId = "task123running1";
      const date = "2026-03-06";

      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
        { role: "user", content: "original" },
      ]);

      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      const runner = new TaskRunner(createDeps({ onNotification }));
      await runner.resume(taskId, "continue please");

      await waitForNotifications();

      const completed = notifications.find((n) => n.type === "completed");
      expect(completed).toBeDefined();
      expect(completed!.taskId).toBe(taskId);
    }, 5000);
  });

  describe("resume with unknown taskId", () => {
    test("throws when taskId not in index", async () => {
      // Empty index
      await writeIndex(tempDir, []);
      const runner = new TaskRunner(createDeps());

      await expect(
        runner.resume("nonexistent-id", "some input"),
      ).rejects.toThrow("Task nonexistent-id not found in task index");
    }, 5000);

    test("throws when index file does not exist", async () => {
      // No index file at all
      const runner = new TaskRunner(createDeps());

      await expect(
        runner.resume("missing-id", "some input"),
      ).rejects.toThrow("Task missing-id not found in task index");
    }, 5000);
  });

  describe("resume creates Agent and calls run()", () => {
    test("creates agent with correct sessionDir and fires run()", async () => {
      const taskId = "agent-run-test1";
      const date = "2026-03-05";

      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
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
          toolCallCount: 0,
        };
      };

      try {
        const runner = new TaskRunner(createDeps());
        await runner.resume(taskId, "new instruction");

        await waitForNotifications();

        expect(runCalled).toBe(true);
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);

    test("uses provided taskType and description", async () => {
      const taskId = "custom-type-test";
      const date = "2026-03-04";

      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
        { role: "user", content: "start" },
      ]);

      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      await runner.resume(taskId, "do more", "explore", "Exploration task");

      const status = runner.getStatus(taskId);
      expect(status).not.toBeNull();
      expect(status!.taskType).toBe("explore");
      expect(status!.description).toBe("Exploration task");
      expect(status!.source).toBe("resume");
    }, 5000);

    test("defaults taskType to 'general' when not provided", async () => {
      const taskId = "default-type-tst";
      const date = "2026-03-03";

      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
        { role: "user", content: "start" },
      ]);

      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      await runner.resume(taskId, "continue");

      const status = runner.getStatus(taskId);
      expect(status).not.toBeNull();
      expect(status!.taskType).toBe("general");
    }, 5000);
  });

  describe("_loadIndex", () => {
    test("parses index.jsonl correctly with multiple entries", async () => {
      await writeIndex(tempDir, [
        { taskId: "task-aaa", date: "2026-03-01" },
        { taskId: "task-bbb", date: "2026-03-02" },
        { taskId: "task-ccc", date: "2026-03-03" },
      ]);

      // We test _loadIndex indirectly: resume succeeds for known IDs,
      // throws for unknown ones
      await writeSession(tempDir, "2026-03-02", "task-bbb", [
        { role: "user", content: "hello" },
      ]);

      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      // Should find task-bbb
      const result = await runner.resume("task-bbb", "follow up");
      expect(result).toBe("task-bbb");

      // Should not find task-zzz
      await expect(
        runner.resume("task-zzz", "nope"),
      ).rejects.toThrow("Task task-zzz not found in task index");
    }, 5000);

    test("returns empty map when index file is missing", async () => {
      // No index file written — _loadIndex should return empty map,
      // causing resume to throw "not found"
      const runner = new TaskRunner(createDeps());

      await expect(
        runner.resume("any-id", "input"),
      ).rejects.toThrow("Task any-id not found in task index");
    }, 5000);

    test("handles index with single entry", async () => {
      await writeIndex(tempDir, [{ taskId: "solo-task", date: "2026-01-15" }]);
      await writeSession(tempDir, "2026-01-15", "solo-task", [
        { role: "user", content: "original" },
      ]);

      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      const result = await runner.resume("solo-task", "more input");
      expect(result).toBe("solo-task");
      expect(runner.activeCount).toBe(1);
    }, 5000);
  });

  describe("resume agent failure handling", () => {
    test("sends failed notification when agent.run() rejects", async () => {
      const taskId = "fail-resume-tst";
      const date = "2026-03-06";

      await writeIndex(tempDir, [{ taskId, date }]);
      await writeSession(tempDir, date, taskId, [
        { role: "user", content: "start" },
      ]);

      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      // Monkeypatch to simulate failure
      const originalRun = Agent.prototype.run;
      Agent.prototype.run = async function () {
        throw new Error("agent crashed on resume");
      };

      try {
        const runner = new TaskRunner(createDeps({ onNotification }));
        await runner.resume(taskId, "continue");

        await waitForNotifications();

        const failedCall = notifications.find((n) => n.type === "failed");
        expect(failedCall).toBeDefined();
        expect(failedCall!.taskId).toBe(taskId);
        expect((failedCall as any).error).toBe("agent crashed on resume");
        expect(runner.activeCount).toBe(0);
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);
  });
});
