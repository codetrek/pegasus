/**
 * Tests for task tools — task_list, task_replay.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { task_list, task_replay } from "../../../src/tools/builtins/task-tools.ts";
import { TaskPersister } from "../../../src/task/persister.ts";
import { rm, mkdir, appendFile } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-task-tools";

describe("task tools", () => {
  let origDataDir: string | undefined;

  beforeEach(async () => {
    origDataDir = process.env.PEGASUS_DATA_DIR;
    process.env.PEGASUS_DATA_DIR = testDir;
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(`${testDir}/tasks/2026-02-25`, { recursive: true });
  });

  afterEach(async () => {
    if (origDataDir === undefined) {
      delete process.env.PEGASUS_DATA_DIR;
    } else {
      process.env.PEGASUS_DATA_DIR = origDataDir;
    }
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── task_list ─────────────────────────────────

  describe("task_list", () => {
    it("should list tasks for a date from index.jsonl", async () => {
      // Write index entries
      await appendFile(
        `${testDir}/tasks/index.jsonl`,
        '{"taskId":"t1","date":"2026-02-25"}\n{"taskId":"t2","date":"2026-02-25"}\n',
      );

      // Write minimal JSONL logs so we can extract inputText and description
      await appendFile(
        `${testDir}/tasks/2026-02-25/t1.jsonl`,
        '{"ts":1,"event":"TASK_CREATED","taskId":"t1","data":{"description":"Greeting task","inputText":"hello","source":"user"}}\n',
      );
      await appendFile(
        `${testDir}/tasks/2026-02-25/t2.jsonl`,
        '{"ts":2,"event":"TASK_CREATED","taskId":"t2","data":{"description":"Farewell task","inputText":"bye","source":"user"}}\n' +
          '{"ts":3,"event":"TASK_COMPLETED","taskId":"t2","data":{"finalResult":{},"iterations":1}}\n',
      );

      const context = { taskId: "test", memoryDir: `${testDir}/tasks` };
      const result = await task_list.execute(
        { date: "2026-02-25" },
        context,
      );

      expect(result.success).toBe(true);
      const tasks = result.result as Array<{
        taskId: string;
        description: string;
        inputText: string;
        status: string;
      }>;
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.taskId).toBe("t1");
      expect(tasks[0]!.description).toBe("Greeting task");
      expect(tasks[0]!.inputText).toBe("hello");
      expect(tasks[0]!.status).toBe("in_progress");
      expect(tasks[1]!.taskId).toBe("t2");
      expect(tasks[1]!.description).toBe("Farewell task");
      expect(tasks[1]!.inputText).toBe("bye");
      expect(tasks[1]!.status).toBe("completed");
    }, 5000);

    it("should return empty list when no tasks exist for date", async () => {
      const context = { taskId: "test" };
      const result = await task_list.execute(
        { date: "2026-02-26" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    }, 5000);

    it("should return empty list when no index exists", async () => {
      // testDir/tasks exists but no index.jsonl
      const context = { taskId: "test" };
      const result = await task_list.execute(
        { date: "2026-02-25" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    }, 5000);

    it("should handle corrupted index file gracefully", async () => {
      // Write invalid content to index.jsonl — loadIndex swallows parse
      // errors and returns an empty map, so task_list returns success with [].
      await appendFile(`${testDir}/tasks/index.jsonl`, "not valid json\n");

      const context = { taskId: "test" };
      const result = await task_list.execute(
        { date: "2026-02-25" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    }, 5000);

    it("should return error when loadIndex throws unexpectedly", async () => {
      // Temporarily make loadIndex throw to cover the outer catch block
      const original = TaskPersister.loadIndex;
      TaskPersister.loadIndex = async () => {
        throw new Error("disk read failure");
      };
      try {
        const context = { taskId: "test" };
        const result = await task_list.execute(
          { date: "2026-02-25" },
          context,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("disk read failure");
      } finally {
        TaskPersister.loadIndex = original;
      }
    }, 5000);
  });

  // ── task_replay ─────────────────────────────────

  describe("task_replay", () => {
    it("should return only messages from a task", async () => {
      // Write index
      await appendFile(
        `${testDir}/tasks/index.jsonl`,
        '{"taskId":"r1","date":"2026-02-25"}\n',
      );

      // Write event log with messages
      const lines =
        [
          '{"ts":1,"event":"TASK_CREATED","taskId":"r1","data":{"inputText":"hi","source":"user"}}',
          '{"ts":2,"event":"REASON_DONE","taskId":"r1","data":{"reasoning":{"response":"hello"},"plan":null,"newMessages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}}',
          '{"ts":3,"event":"TASK_COMPLETED","taskId":"r1","data":{"finalResult":{},"iterations":1,"newMessages":[]}}',
        ].join("\n") + "\n";
      await appendFile(`${testDir}/tasks/2026-02-25/r1.jsonl`, lines);

      const context = { taskId: "test" };
      const result = await task_replay.execute(
        { taskId: "r1" },
        context,
      );

      expect(result.success).toBe(true);
      const messages = result.result as Array<{
        role: string;
        content: string;
      }>;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("hi");
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[1]!.content).toBe("hello");
    }, 5000);

    it("should fail for unknown taskId", async () => {
      const context = { taskId: "test" };
      const result = await task_replay.execute(
        { taskId: "nonexistent" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    }, 5000);

    it("should handle corrupted JSONL file in replay gracefully", async () => {
      await appendFile(`${testDir}/tasks/index.jsonl`, '{"taskId":"bad","date":"2026-02-25"}\n');
      await appendFile(`${testDir}/tasks/2026-02-25/bad.jsonl`, "not valid json\n");

      const context = { taskId: "test" };
      const result = await task_replay.execute(
        { taskId: "bad" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 5000);

    it("should not expose internal state (reasoning, plan, reflections)", async () => {
      // Write index
      await appendFile(
        `${testDir}/tasks/index.jsonl`,
        '{"taskId":"r2","date":"2026-02-25"}\n',
      );

      // Write event log with reasoning, plan, and reflections
      const lines =
        [
          '{"ts":1,"event":"TASK_CREATED","taskId":"r2","data":{"inputText":"test","source":"user"}}',
          '{"ts":2,"event":"REASON_DONE","taskId":"r2","data":{"reasoning":{"response":"secret"},"plan":{"goal":"do stuff","steps":[],"reasoning":"internal"},"newMessages":[{"role":"user","content":"test"}]}}',
          '{"ts":3,"event":"TASK_COMPLETED","taskId":"r2","data":{"finalResult":{"response":"done"},"iterations":1,"newMessages":[{"role":"assistant","content":"done"}]}}',
        ].join("\n") + "\n";
      await appendFile(`${testDir}/tasks/2026-02-25/r2.jsonl`, lines);

      const context = { taskId: "test" };
      const result = await task_replay.execute(
        { taskId: "r2" },
        context,
      );

      expect(result.success).toBe(true);
      const messages = result.result as Array<{
        role: string;
        content: string;
      }>;
      // Should only contain messages, not reasoning/plan/reflections
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe("test");
      expect(messages[1]!.content).toBe("done");
      // Verify result is just the messages array, not the full context
      expect(Array.isArray(result.result)).toBe(true);
    }, 5000);
  });
});
