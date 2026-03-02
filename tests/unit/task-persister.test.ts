import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskPersister } from "../../src/task/persister.ts";
import { EventBus } from "../../src/events/bus.ts";
import { TaskRegistry } from "../../src/task/registry.ts";
import { EventType, createEvent } from "../../src/events/types.ts";
import { TaskFSM } from "../../src/task/fsm.ts";
import { rm, mkdir } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-persister";
const tasksDir = `${testDir}/tasks`;

describe("TaskPersister", () => {
  let persister: TaskPersister;
  let bus: EventBus;
  let registry: TaskRegistry;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    bus = new EventBus();
    registry = new TaskRegistry();
    persister = new TaskPersister(bus, registry, tasksDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("_append", () => {
    it("should create date folder and write JSONL line", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("task1", createdAt, "TASK_CREATED", {
        inputText: "hello",
      });

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/task1.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("TASK_CREATED");
      expect(line.taskId).toBe("task1");
      expect(line.data.inputText).toBe("hello");
      expect(line.ts).toBeGreaterThan(0);
    });

    it("should append multiple lines to same file", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("task1", createdAt, "TASK_CREATED", {
        inputText: "hello",
      });
      await persister._appendForTest("task1", createdAt, "REASON_DONE", {
        reasoning: {},
      });

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/task1.jsonl`,
      ).text();
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).event).toBe("TASK_CREATED");
      expect(JSON.parse(lines[1]!).event).toBe("REASON_DONE");
    });
  });

  describe("_appendIndex", () => {
    it("should append taskId → date mapping to index.jsonl", async () => {
      await persister._appendIndexForTest("task1", "2026-02-25");

      const content = await Bun.file(`${testDir}/tasks/index.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.taskId).toBe("task1");
      expect(line.date).toBe("2026-02-25");
    });
  });

  describe("_updatePending", () => {
    it("should add task to pending.json", async () => {
      await persister._updatePendingForTest("add", "task1", 1740000000);

      const content = await Bun.file(`${testDir}/tasks/pending.json`).text();
      const arr = JSON.parse(content);
      expect(arr).toHaveLength(1);
      expect(arr[0].taskId).toBe("task1");
    });

    it("should remove task from pending.json", async () => {
      await persister._updatePendingForTest("add", "task1", 1740000000);
      await persister._updatePendingForTest("add", "task2", 1740000001);
      await persister._updatePendingForTest("remove", "task1");

      const content = await Bun.file(`${testDir}/tasks/pending.json`).text();
      const arr = JSON.parse(content);
      expect(arr).toHaveLength(1);
      expect(arr[0].taskId).toBe("task2");
    });
  });

  describe("event-driven persistence", () => {
    beforeEach(async () => {
      await bus.start();
    });

    afterEach(async () => {
      await bus.stop();
    });

    it("should persist TASK_CREATED with input and update index+pending", async () => {
      const task = new TaskFSM({ taskId: "evt-task" });
      task.context.inputText = "hello world";
      task.context.description = "Greet the user";
      task.context.source = "user";
      registry.register(task);

      // Manually set createdAt for deterministic date folder
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();

      await bus.emit(
        createEvent(EventType.TASK_CREATED, {
          source: "agent",
          taskId: "evt-task",
        }),
      );

      // Allow async handler to complete
      await Bun.sleep(100);

      // Check event log
      const logContent = await Bun.file(
        `${testDir}/tasks/2026-02-25/evt-task.jsonl`,
      ).text();
      const line = JSON.parse(logContent.trim());
      expect(line.event).toBe("TASK_CREATED");
      expect(line.data.inputText).toBe("hello world");
      expect(line.data.description).toBe("Greet the user");

      // Check index
      const indexContent = await Bun.file(
        `${testDir}/tasks/index.jsonl`,
      ).text();
      const indexLine = JSON.parse(indexContent.trim());
      expect(indexLine.taskId).toBe("evt-task");
      expect(indexLine.date).toBe("2026-02-25");

      // Check pending
      const pendingContent = await Bun.file(
        `${testDir}/tasks/pending.json`,
      ).text();
      const pending = JSON.parse(pendingContent);
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe("evt-task");
    });

    it("should persist REASON_DONE with reasoning and new messages", async () => {
      const task = new TaskFSM({ taskId: "reason-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.reasoning = { response: "thinking...", approach: "direct" };
      task.context.plan = { goal: "respond", steps: [], reasoning: "simple" };
      task.context.messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      registry.register(task);

      await bus.emit(
        createEvent(EventType.REASON_DONE, {
          source: "cognitive.reason",
          taskId: "reason-task",
        }),
      );
      await Bun.sleep(100);

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/reason-task.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("REASON_DONE");
      expect(line.data.reasoning).toBeDefined();
      expect(line.data.plan).toBeDefined();
      expect(line.data.newMessages).toHaveLength(2);
    });

    it("should persist NEED_MORE_INFO with reasoning", async () => {
      const task = new TaskFSM({ taskId: "info-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.reasoning = { needsClarification: true, question: "which file?" };
      registry.register(task);

      await bus.emit(createEvent(EventType.NEED_MORE_INFO, {
        source: "cognitive.reason", taskId: "info-task",
      }));
      await Bun.sleep(100);

      const content = await Bun.file(`${testDir}/tasks/2026-02-25/info-task.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("NEED_MORE_INFO");
      expect(line.data.reasoning.needsClarification).toBe(true);
    });

    it("should persist TASK_SUSPENDED with full context snapshot", async () => {
      const task = new TaskFSM({ taskId: "suspend-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.suspendedState = "reasoning";
      task.context.suspendReason = "awaiting user input";
      task.context.reasoning = { response: "I need more info", approach: "direct" };
      task.context.plan = { goal: "respond", steps: [], reasoning: "need clarification" };
      task.context.messages = [
        { role: "user", content: "do something" },
        { role: "assistant", content: "I need more info" },
      ];
      registry.register(task);

      await bus.emit(createEvent(EventType.TASK_SUSPENDED, {
        source: "agent", taskId: "suspend-task",
      }));
      await Bun.sleep(100);

      const content = await Bun.file(`${testDir}/tasks/2026-02-25/suspend-task.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("TASK_SUSPENDED");
      expect(line.data.suspendedState).toBe("reasoning");
      expect(line.data.suspendReason).toBe("awaiting user input");
      expect(line.data.reasoning).toBeDefined();
      expect(line.data.plan).toBeDefined();
      expect(line.data.newMessages).toHaveLength(2);
    });

    it("should persist REFLECTION_COMPLETE with reflection metadata", async () => {
      const task = new TaskFSM({ taskId: "reflect-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      registry.register(task);

      await bus.emit(createEvent(EventType.REFLECTION_COMPLETE, {
        source: "cognitive.reflect",
        taskId: "reflect-task",
        payload: { toolCallsCount: 3, assessment: "recorded 2 facts and 1 episode" },
      }));
      await Bun.sleep(100);

      const content = await Bun.file(`${testDir}/tasks/2026-02-25/reflect-task.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("REFLECTION_COMPLETE");
      expect(line.data.toolCallsCount).toBe(3);
      expect(line.data.assessment).toBe("recorded 2 facts and 1 episode");
    });

    it("should persist TASK_COMPLETED and remove from pending", async () => {
      const task = new TaskFSM({ taskId: "done-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.finalResult = { response: "done" };
      task.context.iteration = 1;
      registry.register(task);

      // Pre-populate pending
      await persister._updatePendingForTest("add", "done-task", Date.now());

      await bus.emit(
        createEvent(EventType.TASK_COMPLETED, {
          source: "agent",
          taskId: "done-task",
        }),
      );
      await Bun.sleep(100);

      // Check event log
      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/done-task.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("TASK_COMPLETED");
      expect(line.data.finalResult).toEqual({ response: "done" });
      expect(line.data.iterations).toBe(1);

      // Check pending is empty
      const pendingContent = await Bun.file(
        `${testDir}/tasks/pending.json`,
      ).text();
      expect(JSON.parse(pendingContent)).toHaveLength(0);
    });
  });

  describe("replay", () => {
    it("should reconstruct TaskContext from JSONL event log", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "replay-task";

      // Write a complete task lifecycle
      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        description: "Simple math question",
        inputText: "what is 2+2?",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "4", approach: "direct" },
        plan: {
          goal: "respond",
          steps: [
            {
              index: 0,
              description: "reply",
              actionType: "respond",
              actionParams: {},
              completed: false,
            },
          ],
          reasoning: "simple",
        },
        newMessages: [
          { role: "user", content: "what is 2+2?" },
          { role: "assistant", content: "4" },
        ],
      });
      await persister._appendForTest(taskId, createdAt, "TASK_COMPLETED", {
        finalResult: { response: "4" },
        iterations: 1,
        newMessages: [],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.description).toBe("Simple math question");
      expect(ctx.inputText).toBe("what is 2+2?");
      expect(ctx.source).toBe("user");
      expect(ctx.messages).toHaveLength(2);
      expect(ctx.messages[0]!.content).toBe("what is 2+2?");
      expect(ctx.messages[1]!.content).toBe("4");
      expect(ctx.reasoning).toBeDefined();
      expect(ctx.reasoning!.response).toBe("4");
      expect(ctx.plan).toBeDefined();
      expect(ctx.plan!.goal).toBe("respond");
      expect(ctx.reflections).toHaveLength(0);
      expect(ctx.finalResult).toEqual({ response: "4" });
      expect(ctx.iteration).toBe(1);
    });

    it("should handle tool call events in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "tool-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "search for info",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "need to search", approach: "tool_use" },
        plan: {
          goal: "search",
          steps: [
            {
              index: 0,
              description: "search",
              actionType: "tool_call",
              actionParams: {},
              completed: false,
            },
          ],
          reasoning: "needs data",
        },
        newMessages: [
          { role: "user", content: "search for info" },
          {
            role: "assistant",
            content: "I will search for that",
            toolCalls: [
              { toolName: "web_search", args: { query: "info" } },
            ],
          },
        ],
      });
      await persister._appendForTest(
        taskId,
        createdAt,
        "TOOL_CALL_COMPLETED",
        {
          newMessages: [
            { role: "tool", content: "found some info", toolCallId: "tc1" },
          ],
        },
      );
      await persister._appendForTest(taskId, createdAt, "TASK_COMPLETED", {
        finalResult: { response: "Here is the info" },
        iterations: 1,
        newMessages: [
          { role: "assistant", content: "Here is the info" },
        ],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.actionsDone).toHaveLength(0);
      // Messages: 2 from REASON_DONE + 1 from TOOL_CALL_COMPLETED + 1 from TASK_COMPLETED
      expect(ctx.messages).toHaveLength(4);
      expect(ctx.messages[2]!.role).toBe("tool");
      expect(ctx.reflections).toHaveLength(0);
      expect(ctx.finalResult).toEqual({ response: "Here is the info" });
    });

    it("should handle TASK_FAILED event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "failed-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "do something impossible",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "TASK_FAILED", {
        error: "Something went wrong",
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.inputText).toBe("do something impossible");
      expect(ctx.error).toBe("Something went wrong");
      expect(ctx.finalResult).toBeNull();
    });

    it("should handle NEED_MORE_INFO event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "needinfo-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "vague request",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "NEED_MORE_INFO", {
        reasoning: { question: "Can you clarify?" },
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.reasoning).toEqual({ question: "Can you clarify?" });
    });

    it("should handle TOOL_CALL_FAILED event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "toolfail-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "try something",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "TOOL_CALL_FAILED", {
        newMessages: [
          { role: "tool", content: "Error: tool not found", toolCallId: "tc2" },
        ],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.actionsDone).toHaveLength(0);
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.messages[0]!.role).toBe("tool");
    });
    it("should replay messages identical to original input (full tool-call round trip)", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "fidelity-task";

      // The exact messages as they would accumulate in context.messages during a real task
      const originalMessages = [
        // Round 1: user input + LLM response with tool call
        { role: "user" as const, content: "What time is it?" },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "tc_1", name: "current_time", arguments: {} }] },
        // Tool result
        { role: "tool" as const, content: "2026-02-25T10:00:00Z", toolCallId: "tc_1" },
        // Round 2: LLM summary after tool result
        { role: "assistant" as const, content: "The current time is 2026-02-25T10:00:00Z." },
      ];

      // Write events with the exact message deltas as persister would
      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "What time is it?", source: "user", inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "", approach: "tool_use" },
        plan: { goal: "get time", steps: [], reasoning: "need tool" },
        newMessages: [originalMessages[0], originalMessages[1]],
      });
      await persister._appendForTest(taskId, createdAt, "TOOL_CALL_COMPLETED", {
        newMessages: [originalMessages[2]],
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "The current time is 2026-02-25T10:00:00Z.", approach: "direct" },
        plan: { goal: "respond", steps: [], reasoning: "have answer" },
        newMessages: [originalMessages[3]],
      });
      await persister._appendForTest(taskId, createdAt, "TASK_COMPLETED", {
        finalResult: { response: "The current time is 2026-02-25T10:00:00Z." },
        iterations: 2,
        newMessages: [],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      // Core assertion: replayed messages match original exactly
      expect(ctx.messages).toHaveLength(originalMessages.length);
      for (let i = 0; i < originalMessages.length; i++) {
        expect(ctx.messages[i]!.role).toBe(originalMessages[i]!.role);
        expect(ctx.messages[i]!.content).toBe(originalMessages[i]!.content);
        if (originalMessages[i]!.toolCallId) {
          expect(ctx.messages[i]!.toolCallId).toBe(originalMessages[i]!.toolCallId);
        }
        if (originalMessages[i]!.toolCalls) {
          expect(ctx.messages[i]!.toolCalls).toEqual(originalMessages[i]!.toolCalls);
        }
      }
    });
  });

  describe("loadIndex", () => {
    it("should load taskId → date mapping from index.jsonl", async () => {
      // Write index entries
      await persister._appendIndexForTest("task-a", "2026-02-25");
      await persister._appendIndexForTest("task-b", "2026-02-25");
      await persister._appendIndexForTest("task-c", "2026-02-24");

      const map = await TaskPersister.loadIndex(`${testDir}/tasks`);

      expect(map.size).toBe(3);
      expect(map.get("task-a")).toBe("2026-02-25");
      expect(map.get("task-b")).toBe("2026-02-25");
      expect(map.get("task-c")).toBe("2026-02-24");
    });

    it("should return empty map when index doesn't exist", async () => {
      const map = await TaskPersister.loadIndex(
        "/tmp/pegasus-test-persister-nonexistent/tasks",
      );

      expect(map.size).toBe(0);
    });
  });

  describe("resolveTaskPath", () => {
    it("should return file path for known taskId", async () => {
      await persister._appendIndexForTest("task-x", "2026-02-25");

      const result = await TaskPersister.resolveTaskPath(
        `${testDir}/tasks`,
        "task-x",
      );

      expect(result).toBe(`${testDir}/tasks/2026-02-25/task-x.jsonl`);
    });

    it("should return null for unknown taskId", async () => {
      const result = await TaskPersister.resolveTaskPath(
        `${testDir}/tasks`,
        "nonexistent",
      );

      expect(result).toBeNull();
    });
  });

  describe("recoverPending", () => {
    it("should mark pending tasks as failed and return taskIds", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      // Create a task with TASK_CREATED event
      await persister._appendForTest("pending1", createdAt, "TASK_CREATED", {
        inputText: "test", source: "user", inputMetadata: {},
      });
      await persister._appendIndexForTest("pending1", "2026-02-25");
      await persister._updatePendingForTest("add", "pending1", createdAt);

      // Recover
      const recovered = await TaskPersister.recoverPending(`${testDir}/tasks`);

      expect(recovered).toEqual(["pending1"]);

      // TASK_FAILED should be appended to JSONL
      const content = await Bun.file(`${testDir}/tasks/2026-02-25/pending1.jsonl`).text();
      const lines = content.trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]!);
      expect(lastLine.event).toBe("TASK_FAILED");
      expect(lastLine.data.error).toContain("process restarted");

      // pending.json should be empty
      const pendingContent = await Bun.file(`${testDir}/tasks/pending.json`).text();
      expect(JSON.parse(pendingContent)).toEqual([]);
    });

    it("should handle multiple pending tasks", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("p1", createdAt, "TASK_CREATED", { inputText: "a", source: "user", inputMetadata: {} });
      await persister._appendForTest("p2", createdAt, "TASK_CREATED", { inputText: "b", source: "user", inputMetadata: {} });
      await persister._appendIndexForTest("p1", "2026-02-25");
      await persister._appendIndexForTest("p2", "2026-02-25");
      await persister._updatePendingForTest("add", "p1", createdAt);
      await persister._updatePendingForTest("add", "p2", createdAt);

      const recovered = await TaskPersister.recoverPending(`${testDir}/tasks`);
      expect(recovered).toHaveLength(2);
      expect(recovered).toContain("p1");
      expect(recovered).toContain("p2");
    });

    it("should return empty array when no pending.json exists", async () => {
      const recovered = await TaskPersister.recoverPending(`${testDir}/tasks`);
      expect(recovered).toEqual([]);
    });

    it("should return empty array when pending.json is empty", async () => {
      // pending.json already starts empty from _updatePendingForTest setup
      const recovered = await TaskPersister.recoverPending(`${testDir}/tasks`);
      expect(recovered).toEqual([]);
    });
  });

  describe("taskType persistence", () => {
    it("should persist taskType in TASK_CREATED event", async () => {
      const bus2 = new EventBus();
      const registry2 = new TaskRegistry();
      // Side-effect: subscribes to EventBus events
      void new TaskPersister(bus2, registry2, tasksDir);
      await bus2.start();

      const task = new TaskFSM({ taskId: "typed-task" });
      task.context.inputText = "explore something";
      task.context.source = "user";
      task.context.taskType = "explore";
      registry2.register(task);
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();

      await bus2.emit(createEvent(EventType.TASK_CREATED, {
        source: "agent", taskId: "typed-task",
      }));
      await Bun.sleep(100);

      const content = await Bun.file(`${testDir}/tasks/2026-02-25/typed-task.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.data.taskType).toBe("explore");

      await bus2.stop();
    });

    it("should replay taskType from TASK_CREATED event", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("type-replay", createdAt, "TASK_CREATED", {
        inputText: "plan something", source: "user", inputMetadata: {}, taskType: "plan",
      });

      const filePath = `${testDir}/tasks/2026-02-25/type-replay.jsonl`;
      const ctx = await TaskPersister.replay(filePath);
      expect(ctx.taskType).toBe("plan");
    });

    it("should default taskType to general for old JSONL without taskType", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      // Old format — no taskType field
      await persister._appendForTest("old-task", createdAt, "TASK_CREATED", {
        inputText: "old task", source: "user", inputMetadata: {},
      });

      const filePath = `${testDir}/tasks/2026-02-25/old-task.jsonl`;
      const ctx = await TaskPersister.replay(filePath);
      expect(ctx.taskType).toBe("general");
      // Old format also lacks description — should default to ""
      expect(ctx.description).toBe("");
    });
  });
});
