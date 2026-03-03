import { describe, expect, test, afterAll } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { AgentDeps, TaskNotification } from "@pegasus/agents/agent.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { rm } from "node:fs/promises";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";

const testDataDir = "/tmp/pegasus-test-agent-lifecycle";

/** Minimal mock LanguageModel that returns stub text. */
function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: "Hello! I am a helpful assistant.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function testAgentDeps(): AgentDeps {
  return {
    model: createMockModel(),
    persona: testPersona,
    settings: SettingsSchema.parse({
      llm: { maxConcurrentCalls: 3 },
      agent: { maxActiveTasks: 10 },
      logLevel: "warn",
      dataDir: testDataDir,
      authDir: "/tmp/pegasus-test-auth",
    }),
    storePaths: buildMainAgentPaths(testDataDir),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Agent lifecycle", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });
  test("single task completes end-to-end", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      await agent.eventBus.emit(
        createEvent(EventType.MESSAGE_RECEIVED, {
          source: "user",
          payload: { text: "Hello world" },
        }),
      );

      await sleep(500);

      const tasks = agent.taskRegistry.listAll();
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      const completed = tasks.filter((t) => t.state === TaskState.COMPLETED);
      expect(completed.length).toBeGreaterThanOrEqual(1);

      const task = completed[0]!;
      expect(task.context.inputText).toBe("Hello world");
      expect(task.context.reasoning).not.toBeNull();
      expect(task.context.plan).not.toBeNull();
      expect(task.context.actionsDone.length).toBeGreaterThan(0);
      expect(task.context.reflections).toHaveLength(0);
      expect(task.context.finalResult).not.toBeNull();
      expect(task.context.iteration).toBeGreaterThan(0);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("concurrent tasks (3 simultaneous)", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      for (let i = 0; i < 3; i++) {
        await agent.eventBus.emit(
          createEvent(EventType.MESSAGE_RECEIVED, {
            source: "user",
            payload: { text: `Task ${i}` },
          }),
        );
      }

      await sleep(1500);

      const tasks = agent.taskRegistry.listAll();
      const completed = tasks.filter((t) => t.state === TaskState.COMPLETED);
      expect(completed).toHaveLength(3);

      const inputs = new Set(completed.map((t) => t.context.inputText));
      expect(inputs).toEqual(new Set(["Task 0", "Task 1", "Task 2"]));
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("event history recorded", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      await agent.eventBus.emit(
        createEvent(EventType.MESSAGE_RECEIVED, {
          source: "user",
          payload: { text: "test" },
        }),
      );

      await sleep(500);

      const history = agent.eventBus.history;
      const types = history.map((e) => e.type);

      expect(types).toContain(EventType.SYSTEM_STARTED);
      expect(types).toContain(EventType.MESSAGE_RECEIVED);
      expect(types).toContain(EventType.TASK_CREATED);
      expect(types).toContain(EventType.REASON_DONE);
      expect(types).toContain(EventType.STEP_COMPLETED);
      expect(types).toContain(EventType.TASK_COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("submit and waitForTask", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("do something");
      expect(taskId).toBeTruthy();

      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("onNotify fires for completed task", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId = await agent.submit("async callback test");
      expect(taskId).toBeTruthy();

      const completedTask = await agent.waitForTask(taskId, 5000);

      expect(completedTask.state).toBe(TaskState.COMPLETED);
      expect(completedTask.taskId).toBe(taskId);
      expect(completedTask.context.inputText).toBe("async callback test");
      expect(completedTask.context.finalResult).not.toBeNull();

      // Verify onNotify received the notification
      const completedNotif = notifications.find(
        (n) => n.taskId === taskId && n.type === "completed",
      );
      expect(completedNotif).toBeDefined();
      expect(completedNotif!.type).toBe("completed");
      expect(completedNotif!.taskId).toBe(taskId);

      const result = (completedNotif as { type: "completed"; taskId: string; result: unknown }).result as Record<string, unknown>;
      expect(result["taskId"]).toBe(taskId);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("LLM error triggers TASK_FAILED and onNotify", async () => {
    const errorModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate() {
        throw new Error("LLM API error: 400 Bad Request");
      },
    };

    const agent = new Agent({
      model: errorModel,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir: testDataDir,
        authDir: "/tmp/pegasus-test-auth",
      }),
      storePaths: buildMainAgentPaths(testDataDir),
    });
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];
      agent.onNotify((n) => notifications.push(n));

      const taskId = await agent.submit("This will fail");
      expect(taskId).toBeTruthy();

      // Wait for the error to propagate
      await sleep(500);

      // Task should be failed
      const task = agent.taskRegistry.getOrNull(taskId);
      expect(task).not.toBeNull();
      expect(task!.isTerminal).toBe(true);
      expect(task!.state).toBe(TaskState.FAILED);

      // onNotify should have fired with failure
      const failNotif = notifications.find(
        (n) => n.taskId === taskId && n.type === "failed",
      );
      expect(failNotif).toBeDefined();
      expect(failNotif!.type).toBe("failed");
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("overflow recovery: force compact and retry on context overflow", async () => {
    let callCount = 0;
    const overflowModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate() {
        callCount++;
        if (callCount === 1) {
          // First call: simulate context overflow error
          throw new Error("maximum context length exceeded");
        }
        // Subsequent calls: return normal response (compact summarize + retry)
        return {
          text: "Task completed after overflow recovery.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    // Create agent with many messages to make compact worthwhile
    const agent = new Agent({
      model: overflowModel,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 1 },
        agent: { maxActiveTasks: 5 },
        logLevel: "warn",
        dataDir: testDataDir,
        authDir: "/tmp/pegasus-test-auth",
      }),
      storePaths: buildMainAgentPaths(testDataDir),
    });
    await agent.start();

    try {
      const taskId = await agent.submit("test overflow recovery");

      // Wait for task to complete (overflow → compact → retry → succeed)
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);
      // Should have succeeded after overflow recovery
      expect(task.context.finalResult).not.toBeNull();
    } finally {
      await agent.stop();
    }
  }, 10_000);
});
