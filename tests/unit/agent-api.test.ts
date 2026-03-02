import { afterAll, describe, expect, test } from "bun:test";
import { Agent, context_pushToolResult } from "@pegasus/agents/agent.ts";
import type { AgentDeps, TaskNotification } from "@pegasus/agents/agent.ts";
import { EventType, createEvent } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import type { ToolResult } from "@pegasus/tools/types.ts";
import { rm } from "node:fs/promises";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";

const testDataDir = "/tmp/pegasus-test-agent-api";

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

describe("Agent.onNotify", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("callback fires with completed notification when task completes", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      // Wait for task to finish
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);

      // Verify notification was received
      const completedNotif = notifications.find(
        (n) => n.taskId === taskId && n.type === "completed",
      );
      expect(completedNotif).toBeDefined();
      expect(completedNotif!.type).toBe("completed");
      expect(completedNotif!.taskId).toBe(taskId);
      expect((completedNotif as { type: "completed"; result: unknown }).result).not.toBeNull();
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("callback fires with failed notification on task failure", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      // Emit TASK_FAILED to force failure
      await agent.eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "test",
          taskId,
          payload: { error: "forced failure" },
        }),
      );

      // Wait for task to reach done state
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.isDone).toBe(true);

      // Verify at least one notification was received for this task
      const taskNotifs = notifications.filter((n) => n.taskId === taskId);
      expect(taskNotifs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("multiple tasks each produce notifications", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId1 = await agent.submit("Task A");
      const taskId2 = await agent.submit("Task B");

      await agent.waitForTask(taskId1, 5000);
      await agent.waitForTask(taskId2, 5000);

      const ids = new Set(notifications.map((n) => n.taskId));
      expect(ids.has(taskId1)).toBe(true);
      expect(ids.has(taskId2)).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 10_000);
});

describe("Agent.resume", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("resumed task completes with new instructions (not infinite loop)", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      // 1. Submit and complete a task
      const taskId = await agent.submit("original task");
      const completedTask = await agent.waitForTask(taskId, 5000);
      expect(completedTask.state).toBe(TaskState.COMPLETED);

      // 2. Resume with new instructions
      const resumedId = await agent.resume(taskId, "follow-up instructions");
      expect(resumedId).toBe(taskId);

      // 3. The resumed task should complete (not fail with max iterations)
      const resumedTask = await agent.waitForTask(taskId, 5000);
      expect(resumedTask.state).toBe(TaskState.COMPLETED);
      expect(resumedTask.context.inputText).toBe("follow-up instructions");
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("resumed task updates inputText in context", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("first task");
      await agent.waitForTask(taskId, 5000);

      await agent.resume(taskId, "second task");
      const task = await agent.waitForTask(taskId, 5000);

      // inputText should reflect the new input, not the original
      expect(task.context.inputText).toBe("second task");
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("resumed task preserves conversation history", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("first message");
      await agent.waitForTask(taskId, 5000);

      // After resume, messages should contain the new input
      await agent.resume(taskId, "second message");
      await agent.waitForTask(taskId, 5000);

      const task = agent.taskRegistry.get(taskId);
      // The new input should appear in messages
      const hasNewInput = task.context.messages.some(
        (m) => m.role === "user" && m.content === "second message",
      );
      expect(hasNewInput).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("resume rejects non-completed task", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("hello");
      // Don't wait — task might still be in progress
      // But even if it completes quickly, let's test the error path
      // by creating a task and forcing it to a non-completed state
      const task = agent.taskRegistry.get(taskId);
      await agent.waitForTask(taskId, 5000);

      // Force to FAILED state for testing
      task.state = TaskState.FAILED as any;

      await expect(agent.resume(taskId, "try again")).rejects.toThrow(
        /can only resume COMPLETED tasks/,
      );
    } finally {
      await agent.stop();
    }
  }, 10_000);
});

describe("context_pushToolResult", () => {
  test("prepends timestamp with duration to successful tool result", () => {
    const context = createTaskContext({ id: "test-1" });

    const toolResult: ToolResult = {
      success: true,
      result: { answer: 42 },
      startedAt: 1709136600000,
      completedAt: 1709136602300,
      durationMs: 2300,
    };

    context_pushToolResult(context, "call_1", toolResult, 128_000);

    expect(context.messages).toHaveLength(1);
    const msg = context.messages[0]!;
    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("call_1");
    // Should start with bracketed timestamp containing "took"
    expect(msg.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| took 2\.3s\]/);
    // Should contain the original JSON result after the timestamp line
    expect(msg.content).toContain(JSON.stringify({ answer: 42 }));
  });

  test("prepends timestamp to error tool result", () => {
    const context = createTaskContext({ id: "test-2" });

    const toolResult: ToolResult = {
      success: false,
      error: "file not found",
      startedAt: 1709136600000,
      completedAt: 1709136600500,
      durationMs: 500,
    };

    context_pushToolResult(context, "call_2", toolResult, 128_000);

    const msg = context.messages[0]!;
    expect(msg.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| took 0\.5s\]/);
    expect(msg.content).toContain("Error: file not found");
  });

  test("uses Date.now() fallback when completedAt is missing", () => {
    const context = createTaskContext({ id: "test-3" });

    const toolResult: ToolResult = {
      success: true,
      result: "ok",
      startedAt: Date.now(),
      // completedAt intentionally omitted
      // durationMs intentionally omitted
    };

    context_pushToolResult(context, "call_3", toolResult, 128_000);

    const msg = context.messages[0]!;
    // Should have timestamp without duration
    expect(msg.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    expect(msg.content).toContain('"ok"');
  });

  test("truncates oversized tool results based on context window", () => {
    const context = createTaskContext({ id: "test-trunc" });

    // With 128k context window, max chars = 128_000 * 0.25 * 3.5 = 112_000
    // Create a result that exceeds this limit
    const hugeContent = "x".repeat(120_000);
    const toolResult: ToolResult = {
      success: true,
      result: { content: hugeContent },
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 10,
    };

    context_pushToolResult(context, "call_huge", toolResult, 128_000);

    const msg = context.messages[0]!;
    // Should be truncated — max is 112k chars for 128k context window
    expect(msg.content.length).toBeLessThan(120_000);
    expect(msg.content).toContain("[RESULT TRUNCATED");
    expect(msg.content).toContain("more specific queries");
  });

  test("does not truncate tool results under 50k chars", () => {
    const context = createTaskContext({ id: "test-no-trunc" });

    const smallContent = "y".repeat(1_000);
    const toolResult: ToolResult = {
      success: true,
      result: { content: smallContent },
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 5,
    };

    context_pushToolResult(context, "call_small", toolResult, 128_000);

    const msg = context.messages[0]!;
    expect(msg.content).not.toContain("[RESULT TRUNCATED");
    expect(msg.content).toContain(smallContent);
  });
});
