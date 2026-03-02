/**
 * Tests for spawn_task interception in Agent._runAct().
 *
 * Verifies that when an Agent's task calls spawn_task:
 * 1. A real child task is created via agent.submit()
 * 2. The parent task blocks until the child completes
 * 3. The child's result is returned as the tool result to the parent
 * 4. Failed child tasks propagate the error correctly
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { TaskNotification } from "@pegasus/agents/agent.ts";
import type { LanguageModel, Message } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { spawn_task } from "@pegasus/tools/builtins/index.ts";
import { rm } from "node:fs/promises";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";

const testDataDir = "/tmp/pegasus-test-agent-spawn-task";

const testPersona: Persona = {
  name: "SpawnBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createTestSettings() {
  return SettingsSchema.parse({
    llm: { maxConcurrentCalls: 5 },
    agent: { maxActiveTasks: 10, taskTimeout: 30 },
    logLevel: "warn",
    dataDir: testDataDir,
    authDir: "/tmp/pegasus-test-auth",
  });
}

describe("Agent spawn_task interception", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("spawn_task creates real child task and returns its result", async () => {
    /**
     * Flow:
     * 1. Parent LLM call → returns spawn_task tool call
     * 2. Agent intercepts → creates child task via submit()
     * 3. Child LLM call → returns "Child completed" text
     * 4. Child completes → result returned to parent as tool result
     * 5. Parent LLM call with tool result → returns final text
     */
    const callLog: string[] = [];

    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "spawn-test-model",
      async generate(options) {
        // Determine which task is calling based on messages content
        const userMsg = options.messages.find((m: Message) => m.role === "user");
        const hasToolResult = options.messages.some((m: Message) => m.role === "tool");
        const inputText = userMsg?.content ?? "";

        // Child task: input contains "Do research on topic X"
        if (typeof inputText === "string" && inputText.includes("Do research on topic X")) {
          callLog.push("child");
          return {
            text: "Research complete: Topic X is about testing.",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }

        // Parent task, first call: no tool result yet → spawn a task
        if (!hasToolResult) {
          callLog.push("parent-spawn");
          return {
            text: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{
              id: "call_spawn_1",
              name: "spawn_task",
              arguments: {
                description: "Research topic X",
                input: "Do research on topic X",
                type: "general",
              },
            }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        // Parent task, second call: has tool result → summarize
        callLog.push("parent-final");
        return {
          text: "Based on the research, Topic X is about testing.",
          finishReason: "stop" as const,
          usage: { promptTokens: 20, completionTokens: 15 },
        };
      },
    };

    const agent = new Agent({
      model: mockModel,
      persona: testPersona,
      settings: createTestSettings(),
      additionalTools: [spawn_task],
      storePaths: buildMainAgentPaths(testDataDir),
    });

    await agent.start();

    try {
      const parentTaskId = await agent.submit("Tell me about topic X");
      expect(parentTaskId).toBeTruthy();

      const parentTask = await agent.waitForTask(parentTaskId, 15_000);
      expect(parentTask.state).toBe(TaskState.COMPLETED);

      // Verify call sequence: parent-spawn → child → parent-final
      expect(callLog).toContain("parent-spawn");
      expect(callLog).toContain("child");
      expect(callLog).toContain("parent-final");

      // Verify spawn_task tool result was overridden with child's real result
      const toolActions = parentTask.context.actionsDone.filter(
        (a) => a.actionType === "tool_call",
      );
      expect(toolActions.length).toBeGreaterThanOrEqual(1);
      const spawnAction = toolActions[0]!;
      expect(spawnAction.success).toBe(true);

      // The tool result should contain the child's actual result
      const result = spawnAction.result as Record<string, unknown>;
      expect(result.status).toBe("completed");
      expect(result.taskId).toBeTruthy();

      // Child's result should include the response
      const childResult = result.result as Record<string, unknown>;
      expect(childResult.response).toBe("Research complete: Topic X is about testing.");

      // Verify parent's final result
      expect(parentTask.context.finalResult).toBeDefined();

      // Verify child task was actually created in the registry
      const allTasks = agent.taskRegistry.listAll();
      const childTasks = allTasks.filter(
        (t) => t.context.inputText === "Do research on topic X",
      );
      expect(childTasks.length).toBe(1);
      expect(childTasks[0]!.state).toBe(TaskState.COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 20_000);

  test("spawn_task propagates child task failure", async () => {
    /**
     * Flow:
     * 1. Parent LLM call → returns spawn_task tool call
     * 2. Agent intercepts → creates child task
     * 3. Child LLM call → throws error → child fails
     * 4. Parent receives failure as tool result → handles gracefully
     */
    let isChildCall = false;

    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "spawn-fail-model",
      async generate(options) {
        const userMsg = options.messages.find((m: Message) => m.role === "user");
        const hasToolResult = options.messages.some((m: Message) => m.role === "tool");
        const inputText = userMsg?.content ?? "";

        // Child task: always fails
        if (typeof inputText === "string" && inputText.includes("Fail this task")) {
          isChildCall = true;
          throw new Error("LLM crashed during child task");
        }

        // Parent task, first call: spawn a task that will fail
        if (!hasToolResult) {
          return {
            text: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{
              id: "call_spawn_fail",
              name: "spawn_task",
              arguments: {
                description: "Doomed task",
                input: "Fail this task immediately",
                type: "general",
              },
            }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        // Parent task, second call: has failed tool result → recover
        return {
          text: "The child task failed, but I handled it.",
          finishReason: "stop" as const,
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new Agent({
      model: mockModel,
      persona: testPersona,
      settings: createTestSettings(),
      additionalTools: [spawn_task],
      storePaths: buildMainAgentPaths(testDataDir),
    });

    await agent.start();

    try {
      const parentTaskId = await agent.submit("Try a failing task");
      expect(parentTaskId).toBeTruthy();

      const parentTask = await agent.waitForTask(parentTaskId, 15_000);

      // Parent should complete (it recovers from child failure)
      expect(parentTask.isDone).toBe(true);

      // The child LLM was called
      expect(isChildCall).toBe(true);

      // Verify spawn_task result indicates failure
      const toolActions = parentTask.context.actionsDone.filter(
        (a) => a.actionType === "tool_call",
      );
      expect(toolActions.length).toBeGreaterThanOrEqual(1);
      const spawnAction = toolActions[0]!;

      // The spawn_task result should indicate the child failed
      const result = spawnAction.result as Record<string, unknown>;
      expect(result.status).toBe("failed");
    } finally {
      await agent.stop();
    }
  }, 20_000);

  test("spawn_task notifyCallback fires for child task", async () => {
    /**
     * Verify that onNotify is still called for both parent and child tasks.
     */
    const notifications: TaskNotification[] = [];

    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "spawn-notify-model",
      async generate(options) {
        const userMsg = options.messages.find((m: Message) => m.role === "user");
        const hasToolResult = options.messages.some((m: Message) => m.role === "tool");
        const inputText = userMsg?.content ?? "";

        if (typeof inputText === "string" && inputText.includes("notify-child-work")) {
          return {
            text: "Child work done.",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }

        if (!hasToolResult) {
          return {
            text: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{
              id: "call_spawn_notify",
              name: "spawn_task",
              arguments: {
                description: "Notify test child",
                input: "notify-child-work: do something",
                type: "general",
              },
            }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        return {
          text: "Parent done after child completed.",
          finishReason: "stop" as const,
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new Agent({
      model: mockModel,
      persona: testPersona,
      settings: createTestSettings(),
      additionalTools: [spawn_task],
      storePaths: buildMainAgentPaths(testDataDir),
    });

    agent.onNotify((n) => notifications.push(n));
    await agent.start();

    try {
      const parentTaskId = await agent.submit("Do work with notify");
      expect(parentTaskId).toBeTruthy();

      const parentTask = await agent.waitForTask(parentTaskId, 15_000);
      expect(parentTask.state).toBe(TaskState.COMPLETED);

      // Both parent and child should have triggered notifications
      const completedNotifs = notifications.filter((n) => n.type === "completed");
      expect(completedNotifs.length).toBeGreaterThanOrEqual(2);

      // Parent notification should exist
      const parentNotif = completedNotifs.find((n) => n.taskId === parentTaskId);
      expect(parentNotif).toBeDefined();
    } finally {
      await agent.stop();
    }
  }, 20_000);
});
