/**
 * Tests for TaskRunner — manages ExecutionAgent instances for AITask execution.
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
 */

import { describe, test, expect, mock } from "bun:test";
import { TaskRunner, type TaskRunnerDeps } from "../../../src/agents/task-runner.ts";
import type { TaskNotification } from "../../../src/agents/agent.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { AITaskTypeRegistry } from "../../../src/aitask-types/registry.ts";
import { allTaskTools } from "../../../src/tools/builtins/index.ts";

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

function createDeps(overrides?: Partial<TaskRunnerDeps>): TaskRunnerDeps {
  return {
    model: createMockModel(),
    taskTypeRegistry: new AITaskTypeRegistry(),
    onNotification: mock((_n: TaskNotification) => {}),
    ...overrides,
  };
}

/** Wait for notifications to arrive (fire-and-forget needs a tick). */
async function waitForNotifications(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────

describe("TaskRunner", () => {
  describe("submit returns taskId and increments activeCount", () => {
    test("returns a non-empty taskId string", () => {
      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      const taskId = runner.submit("do stuff", "user", "general", "Test task");

      expect(taskId).toBeTruthy();
      expect(typeof taskId).toBe("string");
      expect(taskId.length).toBe(16); // shortId returns 16-char hex
    }, 5000);

    test("increments activeCount after submit", () => {
      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      expect(runner.activeCount).toBe(0);

      runner.submit("do stuff", "user", "general", "Task 1");
      expect(runner.activeCount).toBe(1);

      runner.submit("do more", "user", "general", "Task 2");
      expect(runner.activeCount).toBe(2);
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

      const runner = new TaskRunner(createDeps({ model, onNotification }));
      const taskId = runner.submit("compute", "user", "general", "Compute task");

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

      const runner = new TaskRunner(createDeps({ model, onNotification }));
      const taskId = runner.submit("do stuff", "user", "general", "Failing task");

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
      const runner = new TaskRunner(createDeps());

      runner.submit("do stuff", "user", "general", "Task");
      expect(runner.activeCount).toBe(1);

      await waitForNotifications();

      expect(runner.activeCount).toBe(0);
    }, 5000);
  });

  describe("getStatus returns running task info", () => {
    test("returns TaskInfo for active task", () => {
      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      const taskId = runner.submit("analyze data", "api", "explore", "Explore task");
      const status = runner.getStatus(taskId);

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
      const runner = new TaskRunner(createDeps());
      expect(runner.getStatus("nonexistent-id")).toBeNull();
    }, 5000);
  });

  describe("listAll returns all active tasks", () => {
    test("lists multiple active tasks", () => {
      const [model] = createBlockingModel();
      const runner = new TaskRunner(createDeps({ model }));

      const id1 = runner.submit("task 1", "user", "general", "First");
      const id2 = runner.submit("task 2", "user", "plan", "Second");

      const all = runner.listAll();
      expect(all.length).toBe(2);

      const ids = all.map((t) => t.taskId);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    }, 5000);

    test("returns empty array when no tasks", () => {
      const runner = new TaskRunner(createDeps());
      expect(runner.listAll()).toEqual([]);
    }, 5000);
  });

  describe("per-type tool registry uses allTaskTools by default", () => {
    test("unknown task type gets all task tools", () => {
      const [model] = createBlockingModel();
      const registry = new AITaskTypeRegistry();
      // No types registered — getToolNames("unknown") returns all tool names
      const runner = new TaskRunner(createDeps({ model, taskTypeRegistry: registry }));

      runner.submit("test", "user", "unknown_type", "Test");

      // Access the cached tool registry to verify tool count
      const cachedRegistry = (runner as any).toolRegistryCache.get("unknown_type");
      expect(cachedRegistry).toBeDefined();

      const registeredTools = cachedRegistry.list();
      expect(registeredTools.length).toBe(allTaskTools.length);
    }, 5000);

    test("registered type with specific tools only gets those tools", () => {
      const [model] = createBlockingModel();
      const registry = new AITaskTypeRegistry();
      registry.registerMany([
        {
          name: "readonly",
          description: "Read-only task",
          tools: ["read_file", "list_files"],
          prompt: "You can only read files.",
          source: "builtin",
        },
      ]);

      const runner = new TaskRunner(createDeps({ model, taskTypeRegistry: registry }));
      runner.submit("read something", "user", "readonly", "Read task");

      const cachedRegistry = (runner as any).toolRegistryCache.get("readonly");
      expect(cachedRegistry).toBeDefined();

      const registeredTools = cachedRegistry.list();
      expect(registeredTools.length).toBe(2);
      const toolNames = registeredTools.map((t: any) => t.name);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("list_files");
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

      const runner = new TaskRunner(createDeps({ model, onNotification }));

      const id1 = runner.submit("task A", "user", "general", "First task");
      const id2 = runner.submit("task B", "user", "general", "Second task");

      expect(runner.activeCount).toBeGreaterThanOrEqual(1);

      await waitForNotifications();

      // Both should have completed
      expect(runner.activeCount).toBe(0);

      const completedNotifs = notifications.filter((n) => n.type === "completed");
      expect(completedNotifs.length).toBe(2);

      const completedIds = completedNotifs.map((n) => n.taskId);
      expect(completedIds).toContain(id1);
      expect(completedIds).toContain(id2);
    }, 5000);
  });
});
