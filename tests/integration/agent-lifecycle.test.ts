import { describe, expect, test } from "bun:test";
import { Agent } from "@pegasus/agent.ts";
import type { AgentDeps } from "@pegasus/agent.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "ai";
import type { Persona } from "@pegasus/identity/persona.ts";

/** Minimal mock LanguageModel that returns stub text. */
function createMockModel(): LanguageModel {
  const responseText = JSON.stringify({
    taskType: "conversation",
    intent: "test",
    urgency: "normal",
    keyEntities: [],
  });
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-model",
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      text: responseText,
      content: [{ type: "text" as const, text: responseText }],
      finishReason: "stop" as const,
      usage: { inputTokens: 10, outputTokens: 10 },
      rawCall: { rawPrompt: "", rawSettings: {} },
      response: { id: "test", timestamp: new Date(), modelId: "test-model" },
    }),
    doStream: async () => {
      throw new Error("Not implemented");
    },
  } as unknown as LanguageModel;
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
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Agent lifecycle", () => {
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
      expect(task.context.perception).not.toBeNull();
      expect(task.context.reasoning).not.toBeNull();
      expect(task.context.plan).not.toBeNull();
      expect(task.context.actionsDone.length).toBeGreaterThan(0);
      expect(task.context.reflections.length).toBeGreaterThan(0);
      expect(task.context.finalResult).not.toBeNull();
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
      expect(types).toContain(EventType.PERCEIVE_DONE);
      expect(types).toContain(EventType.THINK_DONE);
      expect(types).toContain(EventType.PLAN_DONE);
      expect(types).toContain(EventType.ACT_DONE);
      expect(types).toContain(EventType.REFLECT_DONE);
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
});
