import { afterAll, describe, expect, test } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { LanguageModel, Message } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { rm } from "node:fs/promises";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";

const testDataDir = "/tmp/pegasus-test-agent-tool-loop";

const testPersona: Persona = {
  name: "ToolBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createToolTestSettings() {
  return SettingsSchema.parse({
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    logLevel: "warn",
    dataDir: testDataDir,
    authDir: "/tmp/pegasus-test-auth",
  });
}

describe("Agent tool use loop", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });
  test("executes tool and returns LLM summary", async () => {
    let callCount = 0;

    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "tool-test-model",
      async generate(options) {
        callCount++;

        if (callCount === 1) {
          // Thinker round 1: request current_time tool
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "current_time", arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        if (callCount === 2) {
          // Thinker round 2: summarize tool result
          // At this point, options.messages should contain the tool result
          const toolMsg = options.messages.find((m: Message) => m.role === "tool");
          const content = toolMsg?.content ?? "unknown time";
          return {
            text: `The current time is: ${content}`,
            finishReason: "stop",
            usage: { promptTokens: 20, completionTokens: 15 },
          };
        }

        // Fallback for any additional calls
        return {
          text: "Done.",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    };

    const agent = new Agent({
      model: mockModel,
      persona: testPersona,
      settings: createToolTestSettings(),
      storePaths: buildMainAgentPaths(testDataDir),
    });

    await agent.start();

    try {
      const taskId = await agent.submit("What time is it?");
      expect(taskId).toBeTruthy();

      const task = await agent.waitForTask(taskId, 10_000);
      expect(task.state).toBe(TaskState.COMPLETED);

      // Verify tool was called
      const toolActions = task.context.actionsDone.filter(
        (a) => a.actionType === "tool_call",
      );
      expect(toolActions.length).toBeGreaterThanOrEqual(1);
      expect(toolActions[0]!.success).toBe(true);

      // Verify messages contain tool result
      const toolMessages = task.context.messages.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);

      // Verify final result exists
      expect(task.context.finalResult).toBeDefined();
    } finally {
      await agent.stop();
    }
  }, 15_000);

  test("handles tool execution failure gracefully", async () => {
    let callCount = 0;

    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "tool-fail-model",
      async generate() {
        callCount++;

        if (callCount === 1) {
          // Thinker round 1: request a nonexistent tool
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "call_f", name: "nonexistent_tool_xyz", arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        // Fallback
        return {
          text: "I could not find that tool.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new Agent({
      model: mockModel,
      persona: testPersona,
      settings: createToolTestSettings(),
      storePaths: buildMainAgentPaths(testDataDir),
    });

    await agent.start();

    try {
      const taskId = await agent.submit("Use a nonexistent tool");
      expect(taskId).toBeTruthy();

      const task = await agent.waitForTask(taskId, 10_000);

      // Task should complete (not hang)
      expect(task.isDone).toBe(true);

      // Tool action should have failed
      const toolActions = task.context.actionsDone.filter(
        (a) => a.actionType === "tool_call",
      );
      expect(toolActions.length).toBeGreaterThanOrEqual(1);
      expect(toolActions[0]!.success).toBe(false);
    } finally {
      await agent.stop();
    }
  }, 15_000);
});
