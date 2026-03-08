/**
 * Tests for Agent's subagent management — submit(), resume(), getStatus(),
 * listAll(), activeCount, setAdditionalTools().
 *
 * Replaces the former task-runner.test.ts. Now that Agent owns subagent
 * management directly (TaskRunner was deleted), we test the same functionality
 * through Agent with subagentConfig.
 *
 * Exercises:
 *   - submit returns taskId and increments activeCount
 *   - submit runs agent and notifies "completed" on success
 *   - submit notifies "failed" on LLM error
 *   - activeCount decrements after task completion
 *   - getStatus returns running task info
 *   - getStatus returns null for unknown taskId
 *   - listAll returns all active tasks
 *   - per-type tool registry uses allTaskTools by default
 *   - concurrent tasks — submit 2 tasks, both complete independently
 *   - onNotify callback forwarded from Agent
 *   - setAdditionalTools clears tool registry cache
 *   - run() promise rejection triggers failed notification (.catch branch)
 *   - storeImage propagates to ToolContext
 *   - imageRefs flow through notification
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { Agent, type TaskNotification } from "../../../src/agents/agent.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { SubAgentTypeRegistry } from "../../../src/agents/subagents/registry.ts";
import { allTaskTools } from "../../../src/agents/tools/builtins/index.ts";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import type { Tool, ToolContext, ToolResult } from "../../../src/agents/tools/types.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
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

interface CreateAgentOpts {
  model?: LanguageModel;
  onNotification?: (n: TaskNotification) => void;
  storeImage?: ToolContext["storeImage"];
  resolveModel?: (tierOrSpec: string) => LanguageModel;
  subagentTypeRegistry?: SubAgentTypeRegistry;
}

function createAgentWithSubagents(overrides?: CreateAgentOpts): Agent {
  return new Agent({
    agentId: "test-agent",
    model: overrides?.model ?? createMockModel(),
    toolRegistry: new ToolRegistry(),
    systemPrompt: "test",
    sessionDir: path.join(tempDir, "session"),
    subagentConfig: {
      subagentTypeRegistry: overrides?.subagentTypeRegistry ?? new SubAgentTypeRegistry(),
      tasksDir: path.join(tempDir, "tasks"),
      onNotification: overrides?.onNotification ?? (() => {}),
      storeImage: overrides?.storeImage,
      resolveModel: overrides?.resolveModel,
    },
  });
}

/** Wait for notifications to arrive (fire-and-forget needs a tick). */
async function waitForNotifications(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────

describe("Agent subagent management", () => {
  const allTempDirs: string[] = [];
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-agent-subagent-test-"));
    allTempDirs.push(tempDir);
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
  afterAll(async () => {
    // Final sweep: blocking-model tests may recreate dirs after afterEach
    await Bun.sleep(100);
    await Promise.all(allTempDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  describe("submit returns taskId and increments activeCount", () => {
    test("returns a non-empty taskId string", () => {
      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      const taskId = agent.submit("do stuff", "user", "general", "Test task");

      expect(taskId).toBeTruthy();
      expect(typeof taskId).toBe("string");
      expect(taskId.length).toBe(16); // shortId returns 16-char hex
    }, 5000);

    test("increments activeCount after submit", () => {
      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      expect(agent.activeCount).toBe(0);

      agent.submit("do stuff", "user", "general", "Task 1");
      expect(agent.activeCount).toBe(1);

      agent.submit("do more", "user", "general", "Task 2");
      expect(agent.activeCount).toBe(2);
    }, 5000);
  });

  describe("submit runs agent and notifies completed on success", () => {
    test("sends completed notification with result", async () => {
      const onNotification = mock((_n: TaskNotification) => {});
      const model = createMockModel(
        mock(async () => ({
          text: "result: 42",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = createAgentWithSubagents({ model, onNotification });
      const taskId = agent.submit("compute", "user", "general", "Compute task");

      await waitForNotifications();

      expect(onNotification).toHaveBeenCalled();
      const calls = (onNotification as any).mock.calls as TaskNotification[][];
      const completedCall = calls.find((c) => c[0]!.type === "completed");
      expect(completedCall).toBeDefined();
      expect(completedCall![0]!.taskId).toBe(taskId);
      expect((completedCall![0] as any).result).toBe("result: 42");
    }, 5000);
  });

  describe("submit notifies failed on LLM error", () => {
    test("sends failed notification with error message", async () => {
      const onNotification = mock((_n: TaskNotification) => {});
      const model = createMockModel(
        mock(async () => {
          throw new Error("LLM connection refused");
        }),
      );

      const agent = createAgentWithSubagents({ model, onNotification });
      const taskId = agent.submit("do stuff", "user", "general", "Failing task");

      await waitForNotifications();

      expect(onNotification).toHaveBeenCalled();
      const calls = (onNotification as any).mock.calls as TaskNotification[][];
      const failedCall = calls.find((c) => c[0]!.type === "failed");
      expect(failedCall).toBeDefined();
      expect(failedCall![0]!.taskId).toBe(taskId);
      expect((failedCall![0] as any).error).toBeTruthy();
    }, 5000);
  });

  describe("activeCount decrements after task completion", () => {
    test("activeCount returns to 0 after task completes", async () => {
      const agent = createAgentWithSubagents();

      agent.submit("do stuff", "user", "general", "Task");
      expect(agent.activeCount).toBe(1);

      await waitForNotifications();

      expect(agent.activeCount).toBe(0);
    }, 5000);
  });

  describe("getStatus returns running task info", () => {
    test("returns TaskInfo for active task", () => {
      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      const taskId = agent.submit("analyze data", "api", "explore", "Explore task");
      const status = agent.getStatus(taskId);

      expect(status).not.toBeNull();
      expect(status!.taskId).toBe(taskId);
      expect(status!.input).toBe("analyze data");
      expect(status!.taskType).toBe("explore");
      expect(status!.description).toBe("Explore task");
      expect(status!.source).toBe("api");
      expect(status!.startedAt).toBeGreaterThan(0);
    }, 5000);
  });

  describe("getStatus returns null for unknown taskId", () => {
    test("returns null for nonexistent taskId", () => {
      const agent = createAgentWithSubagents();
      expect(agent.getStatus("nonexistent-id")).toBeNull();
    }, 5000);
  });

  describe("listAll returns all active tasks", () => {
    test("lists multiple active tasks", () => {
      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      const id1 = agent.submit("task 1", "user", "general", "First");
      const id2 = agent.submit("task 2", "user", "plan", "Second");

      const all = agent.listAll();
      expect(all.length).toBe(2);

      const ids = all.map((t) => t.taskId);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    }, 5000);

    test("returns empty array when no tasks", () => {
      const agent = createAgentWithSubagents();
      expect(agent.listAll()).toEqual([]);
    }, 5000);
  });

  describe("per-type tool registry uses allTaskTools by default", () => {
    test("unknown task type gets all task tools", () => {
      const [model] = createBlockingModel();
      const registry = new SubAgentTypeRegistry();
      // No types registered — getToolNames("unknown") returns all tool names
      const agent = createAgentWithSubagents({ model, subagentTypeRegistry: registry });

      agent.submit("test", "user", "unknown_type", "Test");

      // Access the cached tool registry to verify tool count
      // Cache key is now "type:dDEPTH" — default depth is 0
      const cachedRegistry = (agent as any)._subagentToolRegistryCache.get("unknown_type:d0");
      expect(cachedRegistry).toBeDefined();

      const registeredTools = cachedRegistry.list();
      // depth=0 adds spawn_subagent + resume_subagent to the base allTaskTools
      expect(registeredTools.length).toBe(allTaskTools.length + 2);
    }, 5000);

    test("registered type with specific tools only gets those tools", () => {
      const [model] = createBlockingModel();
      const registry = new SubAgentTypeRegistry();
      registry.registerMany([
        {
          name: "readonly",
          description: "Read-only task",
          tools: ["read_file", "list_files"],
          prompt: "You can only read files.",
          source: "builtin",
        },
      ]);

      const agent = createAgentWithSubagents({ model, subagentTypeRegistry: registry });
      agent.submit("read something", "user", "readonly", "Read task");

      // Cache key is now "type:dDEPTH" — default depth is 0
      const cachedRegistry = (agent as any)._subagentToolRegistryCache.get("readonly:d0");
      expect(cachedRegistry).toBeDefined();

      const registeredTools = cachedRegistry.list();
      // depth=0 adds spawn_subagent + resume_subagent to the type-specific tools
      expect(registeredTools.length).toBe(4); // read_file + list_files + spawn_subagent + resume_subagent
      const toolNames = registeredTools.map((t: any) => t.name);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("list_files");
      expect(toolNames).toContain("spawn_subagent");
      expect(toolNames).toContain("resume_subagent");
    }, 5000);
  });

  describe("concurrent tasks complete independently", () => {
    test("submit 2 tasks, both complete with correct notifications", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      let callCount = 0;
      const model = createMockModel(
        mock(async () => {
          callCount++;
          return {
            text: `result-${callCount}`,
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = createAgentWithSubagents({ model, onNotification });

      const id1 = agent.submit("task A", "user", "general", "First task");
      const id2 = agent.submit("task B", "user", "general", "Second task");

      expect(agent.activeCount).toBeGreaterThanOrEqual(1);

      await waitForNotifications();

      // Both should have completed
      expect(agent.activeCount).toBe(0);

      const completedNotifs = notifications.filter((n) => n.type === "completed");
      expect(completedNotifs.length).toBe(2);

      const completedIds = completedNotifs.map((n) => n.taskId);
      expect(completedIds).toContain(id1);
      expect(completedIds).toContain(id2);
    }, 5000);
  });

  describe("onNotify callback forwarded from Agent", () => {
    test("sends notify notification when LLM returns notify tool call", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-notify-1",
                  name: "notify",
                  arguments: { message: "progress 50%" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = createAgentWithSubagents({ model, onNotification });
      agent.submit("do work", "user", "general", "Notify test");

      await waitForNotifications(100);

      const notifyCall = notifications.find((n) => n.type === "notify");
      expect(notifyCall).toBeDefined();
      expect(notifyCall!.type).toBe("notify");
      expect((notifyCall as any).message).toBe("progress 50%");
    }, 5000);
  });

  describe("setAdditionalTools clears tool registry cache", () => {
    test("clears cache so next submit builds fresh registry", () => {
      const [model] = createBlockingModel();
      const agent = createAgentWithSubagents({ model });

      // Submit a task to populate the cache for "general" type
      agent.submit("task", "user", "general", "First");

      const cacheBefore = (agent as any)._subagentToolRegistryCache as Map<string, unknown>;
      expect(cacheBefore.size).toBeGreaterThan(0);

      // setAdditionalTools should clear the cache
      agent.setAdditionalTools([]);

      expect(cacheBefore.size).toBe(0);
    }, 5000);
  });

  describe("run() promise rejection triggers failed notification", () => {
    test("catches thrown error from agent.run() in the .catch() branch", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      // Monkeypatch Agent.prototype.run to reject its promise,
      // simulating an unhandled exception escaping run() itself.
      const originalRun = Agent.prototype.run;
      Agent.prototype.run = async function () {
        throw new Error("run() blew up");
      };

      try {
        const agent = createAgentWithSubagents({ onNotification });
        agent.submit("do stuff", "user", "general", "Failing task");

        await waitForNotifications(100);

        // The .catch() branch should fire, producing a "failed" notification
        const failedCall = notifications.find((n) => n.type === "failed");
        expect(failedCall).toBeDefined();
        expect(failedCall!.type).toBe("failed");
        expect((failedCall as any).error).toBe("run() blew up");

        // activeCount should be back to 0
        expect(agent.activeCount).toBe(0);
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);

    test("handles non-Error thrown from run() via String(err) path", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      const originalRun = Agent.prototype.run;
      Agent.prototype.run = async function () {
        throw "string error from run";
      };

      try {
        const agent = createAgentWithSubagents({ onNotification });
        agent.submit("do stuff", "user", "general", "String error task");

        await waitForNotifications(100);

        const failedCall = notifications.find((n) => n.type === "failed");
        expect(failedCall).toBeDefined();
        expect((failedCall as any).error).toBe("string error from run");
      } finally {
        Agent.prototype.run = originalRun;
      }
    }, 5000);
  });

  describe("storeImage propagates from Agent to subagent ToolContext", () => {
    test("tool receives storeImage callback via ToolContext when provided", async () => {
      let capturedContext: ToolContext | null = null;

      // Create a spy tool that captures its ToolContext
      const spyTool: Tool = {
        name: "test_spy_tool",
        description: "Captures ToolContext for testing",
        category: ToolCategory.SYSTEM,
        parameters: z.object({}),
        execute: async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
          capturedContext = context;
          return { success: true, result: "spied", startedAt: Date.now() };
        },
      };

      // Mock storeImage function
      const mockStoreImage = mock(async (_buf: Buffer, _mime: string, _src: string) => {
        return { id: "img-123", mimeType: "image/png" };
      });

      // Model: first call returns a tool call for our spy, second call finishes
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-spy-1", name: "test_spy_tool", arguments: {} },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = createAgentWithSubagents({ model, storeImage: mockStoreImage });

      // Register the spy tool as additional so agent picks it up
      agent.setAdditionalTools([spyTool]);

      agent.submit("run spy", "user", "general", "Spy task");

      await waitForNotifications(100);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.storeImage).toBe(mockStoreImage);
    }, 5000);

    test("tool receives no storeImage when not provided to Agent", async () => {
      let capturedContext: ToolContext | null = null;

      const spyTool: Tool = {
        name: "test_spy_tool",
        description: "Captures ToolContext for testing",
        category: ToolCategory.SYSTEM,
        parameters: z.object({}),
        execute: async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
          capturedContext = context;
          return { success: true, result: "spied", startedAt: Date.now() };
        },
      };

      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-spy-2", name: "test_spy_tool", arguments: {} },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      // No storeImage provided
      const agent = createAgentWithSubagents({ model });
      agent.setAdditionalTools([spyTool]);
      agent.submit("run spy", "user", "general", "No image task");

      await waitForNotifications(100);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.storeImage).toBeUndefined();
    }, 5000);
  });

  describe("imageRefs flow from subagent through notification", () => {
    test("completed notification includes imageRefs when tool returns images", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      // Tool that returns images in ToolResult
      const imageTool: Tool = {
        name: "test_image_tool",
        description: "Returns images in ToolResult",
        category: ToolCategory.SYSTEM,
        parameters: z.object({}),
        execute: async (): Promise<ToolResult> => ({
          success: true,
          result: "screenshot taken",
          images: [
            { id: "img-abc123", mimeType: "image/png", data: "base64data" },
            { id: "img-def456", mimeType: "image/jpeg", data: "base64data2" },
          ],
          startedAt: Date.now(),
        }),
      };

      // Model: first call returns tool call, second call finishes
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-img-1", name: "test_image_tool", arguments: {} },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done with image",
            finishReason: "stop",
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = createAgentWithSubagents({ model, onNotification });
      agent.setAdditionalTools([imageTool]);
      agent.submit("take screenshot", "user", "general", "Image task");

      await waitForNotifications(100);

      const completed = notifications.find((n) => n.type === "completed");
      expect(completed).toBeDefined();
      expect(completed!.type).toBe("completed");
      // imageRefs should be present on the notification
      const imageRefs = (completed as any).imageRefs as Array<{ id: string; mimeType: string }> | undefined;
      expect(imageRefs).toBeDefined();
      expect(imageRefs!.length).toBe(2);
      expect(imageRefs![0]!.id).toBe("img-abc123");
      expect(imageRefs![0]!.mimeType).toBe("image/png");
      expect(imageRefs![1]!.id).toBe("img-def456");
      expect(imageRefs![1]!.mimeType).toBe("image/jpeg");
    }, 5000);

    test("completed notification has no imageRefs when no images produced", async () => {
      const notifications: TaskNotification[] = [];
      const onNotification = mock((n: TaskNotification) => {
        notifications.push(n);
      });

      const agent = createAgentWithSubagents({ onNotification });
      agent.submit("no images", "user", "general", "Plain task");

      await waitForNotifications(100);

      const completed = notifications.find((n) => n.type === "completed");
      expect(completed).toBeDefined();
      const imageRefs = (completed as any).imageRefs;
      expect(imageRefs).toBeUndefined();
    }, 5000);
  });

  // ── storeImage propagation via SubagentConfig ──

  describe("storeImage via SubagentConfig", () => {
    test("subagent receives storeImage from SubagentConfig", async () => {
      let storedImage = false;
      const mockStoreImage = mock(async (_buf: Buffer, _mime: string, _src: string) => {
        storedImage = true;
        return { id: "img-1", mimeType: "image/png" };
      });

      // Create a model that triggers a tool call to store_test_image
      const storeTestTool: Tool = {
        name: "store_test_image",
        description: "Test tool that stores an image",
        category: ToolCategory.MEDIA,
        parameters: z.object({}),
        async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
          const startedAt = Date.now();
          if (context.storeImage) {
            await context.storeImage(Buffer.from("fake"), "image/png", "test");
            return { success: true, result: "stored", startedAt };
          }
          return { success: true, result: "no_storeImage", startedAt };
        },
      };

      // Model that calls store_test_image tool
      const toolCallingModel = createMockModel(async (_opts: any) => {
        // First call: invoke tool; second call: return final text
        if (!storedImage) {
          return {
            text: "",
            finishReason: "tool-calls" as const,
            toolCalls: [{ id: "tc1", name: "store_test_image", arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }
        return {
          text: "done",
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      });

      // Register the test tool in a SubAgentType
      const registry = new SubAgentTypeRegistry();
      registry.registerMany([{
        name: "general",
        description: "test",
        tools: ["store_test_image"],
        prompt: "",
        source: "builtin" as const,
      }]);

      const agent = createAgentWithSubagents({
        model: toolCallingModel,
        storeImage: mockStoreImage,
        subagentTypeRegistry: registry,
      });
      // Add store_test_image to parent's inheritable tools
      agent.setAdditionalTools([storeTestTool]);

      agent.submit("store an image", "user", "general", "Store test");
      await waitForNotifications(200);

      expect(mockStoreImage).toHaveBeenCalled();
      expect(storedImage).toBe(true);
    }, 5000);

    test("subagent works without storeImage (undefined)", async () => {
      const notifications: TaskNotification[] = [];
      const agent = createAgentWithSubagents({
        onNotification: (n) => notifications.push(n),
        // storeImage not provided
      });

      agent.submit("no image needed", "user", "general", "Plain task");
      await waitForNotifications(100);

      const completed = notifications.find(n => n.type === "completed");
      expect(completed).toBeDefined();
    }, 5000);
  });

  // ── resolveModel via SubagentConfig ──

  describe("resolveModel via SubagentConfig", () => {
    test("subagent uses model from SubAgentType when resolveModel is provided", async () => {
      let usedModelId = "";
      const fastModel = createMockModel(async () => {
        usedModelId = "fast-model";
        return {
          text: "fast result",
          finishReason: "stop" as const,
          usage: { promptTokens: 5, completionTokens: 3 },
        };
      });
      (fastModel as any).modelId = "fast-model";

      const registry = new SubAgentTypeRegistry();
      registry.registerMany([{
        name: "explore",
        description: "exploration",
        tools: ["*"],
        prompt: "",
        source: "builtin" as const,
        model: "fast",  // SubAgentType declares model tier
      }]);

      const notifications: TaskNotification[] = [];
      const agent = createAgentWithSubagents({
        onNotification: (n) => notifications.push(n),
        subagentTypeRegistry: registry,
        resolveModel: (tier: string) => {
          expect(tier).toBe("fast");
          return fastModel;
        },
      });

      agent.submit("explore something", "user", "explore", "Explore task");
      await waitForNotifications(100);

      expect(usedModelId).toBe("fast-model");
    }, 5000);

    test("subagent falls back to parent model when SubAgentType has no model", async () => {
      let usedParentModel = false;
      const parentModel = createMockModel(async () => {
        usedParentModel = true;
        return {
          text: "parent model result",
          finishReason: "stop" as const,
          usage: { promptTokens: 5, completionTokens: 3 },
        };
      });

      const registry = new SubAgentTypeRegistry();
      registry.registerMany([{
        name: "general",
        description: "general",
        tools: ["*"],
        prompt: "",
        source: "builtin" as const,
        // No model field — should use parent's model
      }]);

      const resolveModel = mock((_tier: string) => parentModel);

      const notifications: TaskNotification[] = [];
      const agent = createAgentWithSubagents({
        model: parentModel,
        onNotification: (n) => notifications.push(n),
        subagentTypeRegistry: registry,
        resolveModel,
      });

      agent.submit("do work", "user", "general", "General task");
      await waitForNotifications(100);

      // resolveModel should NOT be called since SubAgentType has no model
      expect(resolveModel).not.toHaveBeenCalled();
      expect(usedParentModel).toBe(true);
    }, 5000);
  });
});
