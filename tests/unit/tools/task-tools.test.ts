/**
 * Tests for task tools — task_list, task_replay.
 *
 * Uses the new SessionStore format (current.jsonl with messages)
 * and enriched index.jsonl (with description, taskType, source).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { task_list, task_replay } from "../../../src/agents/tools/builtins/task-tools.ts";
import { rm, mkdir, appendFile } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-task-tools";
const tasksDir = `${testDir}/tasks`;

/** Write an index.jsonl entry. */
async function writeIndex(entry: {
  taskId: string;
  date: string;
  description?: string;
  taskType?: string;
  source?: string;
}): Promise<void> {
  await mkdir(tasksDir, { recursive: true });
  await appendFile(
    `${tasksDir}/index.jsonl`,
    JSON.stringify(entry) + "\n",
    "utf-8",
  );
}

/** Write session messages to {date}/{taskId}/current.jsonl in SessionStore format. */
async function writeSession(
  taskId: string,
  date: string,
  messages: Array<{ role: string; content: string; toolCalls?: unknown[]; toolCallId?: string }>,
): Promise<void> {
  const sessionDir = `${tasksDir}/${date}/${taskId}`;
  await mkdir(sessionDir, { recursive: true });
  const lines = messages
    .map((m, i) => JSON.stringify({ ts: Date.now() + i, ...m }))
    .join("\n") + "\n";
  await appendFile(`${sessionDir}/current.jsonl`, lines, "utf-8");
}

describe("task tools", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── task_list ─────────────────────────────────

  describe("task_list", () => {
    it("should list tasks for a date from enriched index", async () => {
      await writeIndex({ taskId: "t1", date: "2026-02-25", description: "Greeting task", taskType: "general", source: "user" });
      await writeIndex({ taskId: "t2", date: "2026-02-25", description: "Search task", taskType: "web_search", source: "main-agent" });

      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(true);
      const tasks = result.result as Array<{ taskId: string; description: string; taskType: string; source: string }>;
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.taskId).toBe("t1");
      expect(tasks[0]!.description).toBe("Greeting task");
      expect(tasks[0]!.taskType).toBe("general");
      expect(tasks[0]!.source).toBe("user");
      expect(tasks[1]!.taskId).toBe("t2");
      expect(tasks[1]!.description).toBe("Search task");
      expect(tasks[1]!.taskType).toBe("web_search");
    }, 5000);

    it("should handle legacy index entries without metadata", async () => {
      // Old entries only have taskId + date
      await writeIndex({ taskId: "old1", date: "2026-02-25" });

      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(true);
      const tasks = result.result as Array<{ taskId: string; description: string; taskType: string }>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.taskId).toBe("old1");
      expect(tasks[0]!.description).toBe("");
      expect(tasks[0]!.taskType).toBe("general");
    }, 5000);

    it("should return empty list when no tasks exist for date", async () => {
      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-26" }, context);

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    }, 5000);

    it("should return empty list when no index exists", async () => {
      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    }, 5000);

    it("should return error when tasksDir is missing from context", async () => {
      const context = { taskId: "test" };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("tasksDir is required but missing");
    }, 5000);

    it("should filter tasks by date correctly", async () => {
      await writeIndex({ taskId: "t1", date: "2026-02-25", description: "Day 1" });
      await writeIndex({ taskId: "t2", date: "2026-02-26", description: "Day 2" });

      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(true);
      const tasks = result.result as Array<{ taskId: string }>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.taskId).toBe("t1");
    }, 5000);

    it("should return error when index contains corrupted entries", async () => {
      // Write a JSON-valid null line — loadIndex parses it as [null],
      // then filter(e => e.date === ...) throws TypeError on null
      await mkdir(tasksDir, { recursive: true });
      await appendFile(`${tasksDir}/index.jsonl`, "null\n", "utf-8");

      const context = { taskId: "test", tasksDir };
      const result = await task_list.execute({ date: "2026-02-25" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    }, 5000);
  });

  // ── task_replay ─────────────────────────────────

  describe("task_replay", () => {
    it("should replay messages from SessionStore", async () => {
      await writeIndex({ taskId: "r1", date: "2026-02-25" });
      await writeSession("r1", "2026-02-25", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there!" },
      ]);

      const context = { taskId: "test", tasksDir };
      const result = await task_replay.execute({ taskId: "r1" }, context);

      expect(result.success).toBe(true);
      const messages = result.result as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toContain("hello");
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[1]!.content).toBe("hi there!");
    }, 5000);

    it("should replay messages with tool calls", async () => {
      await writeIndex({ taskId: "r2", date: "2026-02-25" });
      await writeSession("r2", "2026-02-25", [
        { role: "user", content: "search for info" },
        { role: "assistant", content: "", toolCalls: [{ id: "tc1", name: "web_search", arguments: { query: "info" } }] },
        { role: "tool", content: "found results", toolCallId: "tc1" },
        { role: "assistant", content: "Here is the info" },
      ]);

      const context = { taskId: "test", tasksDir };
      const result = await task_replay.execute({ taskId: "r2" }, context);

      expect(result.success).toBe(true);
      const messages = result.result as Array<{ role: string; content: string; toolCalls?: unknown[] }>;
      expect(messages).toHaveLength(4);
      expect(messages[1]!.toolCalls).toBeDefined();
      expect(messages[2]!.role).toBe("tool");
    }, 5000);

    it("should fail for unknown taskId", async () => {
      const context = { taskId: "test", tasksDir };
      const result = await task_replay.execute({ taskId: "nonexistent" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    }, 5000);

    it("should return empty messages for task with no session", async () => {
      await writeIndex({ taskId: "empty", date: "2026-02-25" });
      // No session file written — SessionStore.load() returns []

      const context = { taskId: "test", tasksDir };
      const result = await task_replay.execute({ taskId: "empty" }, context);

      expect(result.success).toBe(true);
      const messages = result.result as unknown[];
      expect(messages).toEqual([]);
    }, 5000);

    it("should return error when tasksDir is missing from context", async () => {
      const context = { taskId: "test" };
      const result = await task_replay.execute({ taskId: "r1" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("tasksDir is required but missing");
    }, 5000);

    it("should return error when index contains corrupted entries", async () => {
      // Write a JSON-valid null line — loadIndex parses it as [null],
      // then find(e => e.taskId === ...) throws TypeError on null
      await mkdir(tasksDir, { recursive: true });
      await appendFile(`${tasksDir}/index.jsonl`, "null\n", "utf-8");

      const context = { taskId: "test", tasksDir };
      const result = await task_replay.execute({ taskId: "some-id" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    }, 5000);
  });
});
