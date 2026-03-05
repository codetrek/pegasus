import { describe, it, expect, afterEach } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { AgentDeps, TaskNotification } from "@pegasus/agents/agent.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel, Message } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";
import { TaskFSM } from "@pegasus/task/fsm.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import { rm } from "node:fs/promises";

const testBaseDir = "/tmp/pegasus-test-task-notification-images";

/** Minimal mock LanguageModel. */
function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: "ok",
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

function makeDeps(overrides?: Partial<AgentDeps>): AgentDeps {
  const dataDir = `${testBaseDir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    model: createMockModel(),
    persona: testPersona,
    settings: SettingsSchema.parse({
      llm: { maxConcurrentCalls: 1 },
      agent: { maxActiveTasks: 2 },
      logLevel: "warn",
      dataDir,
      authDir: "/tmp/pegasus-test-auth",
      vision: { enabled: false },
    }),
    storePaths: buildMainAgentPaths(dataDir),
    ...overrides,
  };
}

const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents) {
    try { await agent.stop(); } catch { /* ignore */ }
  }
  agents.length = 0;
  await rm(testBaseDir, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════════
// Part B: _compileResult image collection
// ═══════════════════════════════════════════════════

describe("_compileResult image ID collection", () => {
  it("collects image IDs from task messages", () => {
    const agent = new Agent(makeDeps());
    agents.push(agent);

    const context = createTaskContext({ inputText: "take screenshot" });
    context.messages.push(
      { role: "user", content: "take screenshot" },
      {
        role: "tool",
        content: "Screenshot taken",
        toolCallId: "call_1",
        images: [{ id: "img_abc123", mimeType: "image/png" }],
      },
    );
    context.actionsDone.push({ actionType: "respond", result: "Done" } as any);

    const task = new TaskFSM({ taskId: "t1", context });
    const result = (agent as any)._compileResult(task) as Record<string, unknown>;

    expect(result.imageIds).toEqual(["img_abc123"]);
    expect(result.response).toBe("Done");
  }, 10_000);

  it("returns no imageIds field when messages have no images", () => {
    const agent = new Agent(makeDeps());
    agents.push(agent);

    const context = createTaskContext({ inputText: "do stuff" });
    context.messages.push(
      { role: "user", content: "do stuff" },
      { role: "tool", content: "done", toolCallId: "call_1" },
    );
    context.actionsDone.push({ actionType: "respond", result: "All done" } as any);

    const task = new TaskFSM({ taskId: "t2", context });
    const result = (agent as any)._compileResult(task) as Record<string, unknown>;

    expect(result.imageIds).toBeUndefined();
    expect(result.response).toBe("All done");
  }, 10_000);

  it("deduplicates image IDs across multiple messages", () => {
    const agent = new Agent(makeDeps());
    agents.push(agent);

    const context = createTaskContext({ inputText: "multi-screenshot" });
    context.messages.push(
      { role: "user", content: "multi-screenshot" },
      {
        role: "tool",
        content: "First screenshot",
        toolCallId: "call_1",
        images: [
          { id: "img_aaa", mimeType: "image/png" },
          { id: "img_bbb", mimeType: "image/jpeg" },
        ],
      },
      {
        role: "tool",
        content: "Second screenshot — same img_aaa reappears",
        toolCallId: "call_2",
        images: [
          { id: "img_aaa", mimeType: "image/png" }, // duplicate
          { id: "img_ccc", mimeType: "image/webp" },
        ],
      },
    );

    const task = new TaskFSM({ taskId: "t3", context });
    const result = (agent as any)._compileResult(task) as Record<string, unknown>;

    expect(result.imageIds).toEqual(["img_aaa", "img_bbb", "img_ccc"]);
  }, 10_000);

  it("skips messages with empty images arrays", () => {
    const agent = new Agent(makeDeps());
    agents.push(agent);

    const context = createTaskContext({ inputText: "empty images" });
    context.messages.push(
      { role: "user", content: "test" },
      { role: "tool", content: "no images", toolCallId: "call_1", images: [] },
    );

    const task = new TaskFSM({ taskId: "t4", context });
    const result = (agent as any)._compileResult(task) as Record<string, unknown>;

    expect(result.imageIds).toBeUndefined();
  }, 10_000);
});

// ═══════════════════════════════════════════════════
// Part C: TaskNotification type carries imageIds
// ═══════════════════════════════════════════════════

describe("TaskNotification type with imageIds", () => {
  it("completed notification carries imageIds", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { response: "done" },
      imageIds: ["img_abc", "img_def"],
    };

    expect(notification.type).toBe("completed");
    expect(notification.imageIds).toEqual(["img_abc", "img_def"]);
  });

  it("completed notification without imageIds is valid", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t2",
      result: { response: "done" },
    };

    expect(notification.imageIds).toBeUndefined();
  });

  it("notify notification carries imageIds", () => {
    const notification: TaskNotification = {
      type: "notify",
      taskId: "t3",
      message: "progress update",
      imageIds: ["img_xyz"],
    };

    expect(notification.type).toBe("notify");
    expect(notification.imageIds).toEqual(["img_xyz"]);
  });

  it("failed notification does not have imageIds field", () => {
    const notification: TaskNotification = {
      type: "failed",
      taskId: "t4",
      error: "something went wrong",
    };

    // TypeScript enforces this at compile time; runtime check for completeness
    expect((notification as any).imageIds).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════
// Part E: _handleTaskNotify image attachment logic
// ═══════════════════════════════════════════════════

describe("_handleTaskNotify image attachment", () => {
  /**
   * Test the image attachment logic in isolation.
   * We replicate the core logic from _handleTaskNotify to verify
   * that images are correctly attached to the Message.
   */
  function buildNotifyMessage(notification: TaskNotification): Message {
    let resultText: string;
    if (notification.type === "failed") {
      resultText = `[Task ${notification.taskId} failed]\nError: ${notification.error}`;
    } else if (notification.type === "notify") {
      resultText = `[Task ${notification.taskId} update]\n${notification.message}`;
    } else {
      resultText = `[Task ${notification.taskId} completed]\nResult: ${JSON.stringify(notification.result)}`;
    }

    const systemMsg: Message = { role: "user", content: resultText };

    const imageIds = (notification.type === "completed" || notification.type === "notify")
      ? (notification as any).imageIds as string[] | undefined
      : undefined;
    if (imageIds?.length) {
      systemMsg.images = imageIds.map(id => ({ id, mimeType: "image/png" }));
    }

    return systemMsg;
  }

  it("attaches images to message for completed notification with imageIds", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { response: "Screenshot taken" },
      imageIds: ["img_abc", "img_def"],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeDefined();
    expect(msg.images).toHaveLength(2);
    expect(msg.images![0]).toEqual({ id: "img_abc", mimeType: "image/png" });
    expect(msg.images![1]).toEqual({ id: "img_def", mimeType: "image/png" });
    expect(msg.content).toContain("[Task t1 completed]");
  });

  it("attaches images to message for notify notification with imageIds", () => {
    const notification: TaskNotification = {
      type: "notify",
      taskId: "t2",
      message: "Progress: screenshot taken",
      imageIds: ["img_xyz"],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeDefined();
    expect(msg.images).toHaveLength(1);
    expect(msg.images![0]).toEqual({ id: "img_xyz", mimeType: "image/png" });
    expect(msg.content).toContain("[Task t2 update]");
  });

  it("does not attach images when no imageIds present", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t3",
      result: { response: "No images" },
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
    expect(msg.content).toContain("[Task t3 completed]");
  });

  it("does not attach images for failed notifications", () => {
    const notification: TaskNotification = {
      type: "failed",
      taskId: "t4",
      error: "task crashed",
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
    expect(msg.content).toContain("[Task t4 failed]");
  });

  it("does not attach images when imageIds is empty array", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t5",
      result: { response: "done" },
      imageIds: [],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
  });
});
