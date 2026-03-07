/**
 * Tests for Agent orchestration mode — when orchestration config is set,
 * Agent intercepts spawn_task, tracks children, synthesizes results.
 *
 * Mirrors the OrchestratorAgent test suite but exercises Agent directly.
 *
 * Exercises:
 *   - run() with orchestration returns success with text from LLM
 *   - spawn_task interception adds to childTaskIds
 *   - handleEvent processes child completion
 *   - all children done triggers synthesis
 *   - notify self-executes via ToolContext.onNotify (orchestration injects it)
 *   - onTaskComplete waits for children before completing
 *   - onTaskComplete notifies parent on completion/failure
 *   - imageRefs collection in onTaskComplete
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  Agent,
  type AgentDeps,
  type ExecutionHandle,
  type OrchestratorNotification,
} from "../../../src/agents/agent.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { EventType, createEvent } from "../../../src/events/types.ts";
import { notify } from "../../../src/tools/builtins/notify-tool.ts";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ──────────────────────────────────────────

function createMockModel(
  generateFn?: LanguageModel["generate"],
): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    generate:
      generateFn ??
      mock(async () => ({
        text: "orchestration complete",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      })),
  };
}

let tempDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pegasus-agent-orch-test-"));
}

function createDeferredHandle(id: string): {
  handle: ExecutionHandle;
  resolve: (result: { success: boolean; result?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (result: { success: boolean; result?: unknown; error?: string }) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<{ success: boolean; result?: unknown; error?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { handle: { id, promise }, resolve, reject };
}

function createOrchestrationDeps(
  overrides?: Partial<AgentDeps>,
): AgentDeps {
  return {
    agentId: "orch-agent-1",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    systemPrompt: "You are an orchestrator agent.",
    sessionDir: tempDir,
    orchestration: {
      onSpawnExecution: mock(() => ({
        id: "child-1",
        promise: Promise.resolve({ success: true, result: "child done" }),
      })),
      onNotify: mock(() => {}),
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────

describe("Agent orchestration mode", () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  describe("run() with orchestration returns success", () => {
    test("returns success result with text from LLM", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "orchestration result: all done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const result = await agent.run("Process these items");

      expect(result.success).toBe(true);
      expect(result.result).toBe("orchestration result: all done");
    }, 5000);

    test("notifies parent on completion", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "final result",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const result = await agent.run("Do something");

      expect(result.success).toBe(true);
      expect(notifyCb).toHaveBeenCalled();

      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(1);
    }, 5000);

    test("notifies parent on failure", async () => {
      const model = createMockModel(
        mock(async () => {
          throw new Error("LLM down");
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const result = await agent.run("Do something");

      expect(result.success).toBe(false);

      const failedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "failed",
      );
      expect(failedCalls.length).toBe(1);
    }, 5000);
  });

  describe("spawn_task interception adds to childTaskIds", () => {
    test("spawn_task tool call adds child ID to tracking", async () => {
      const deferred = createDeferredHandle("child-spawn-1");
      const spawnMock = mock((_config: any) => deferred.handle);

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
                  id: "tc-spawn-1",
                  name: "spawn_task",
                  arguments: {
                    description: "sub-task A",
                    input: "do A",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "spawned tasks",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: spawnMock,
            onNotify: notifyCb,
          },
        }),
      );

      const agentAny = agent as any;
      const runPromise = agent.run("Process items");

      // Wait for spawn to happen
      await new Promise((r) => setTimeout(r, 50));

      expect(agentAny._childTaskIds.has("child-spawn-1")).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Resolve child and trigger synthesis
      deferred.resolve({ success: true, result: "A done" });

      const completedEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-spawn-1",
        taskId: "child-spawn-1",
        payload: { result: "A done", finishReason: "complete" },
      });
      await agentAny.handleEvent(completedEvent);

      await runPromise;
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]![0].description).toBe("sub-task A");
    }, 5000);
  });

  describe("handleEvent processes child completion", () => {
    test("TASK_COMPLETED for child stores result and removes from tracking", async () => {
      const model = createMockModel();
      const agent = new Agent(createOrchestrationDeps({ model }));
      const agentAny = agent as any;

      agentAny._childTaskIds.add("child-A");
      agentAny._childTaskIds.add("child-B");

      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      const eventA = createEvent(EventType.TASK_COMPLETED, {
        source: "child-A",
        taskId: "child-A",
        payload: { result: "result A", finishReason: "complete" },
      });
      await agentAny.handleEvent(eventA);

      expect(agentAny._childTaskIds.has("child-A")).toBe(false);
      expect(agentAny._childTaskIds.has("child-B")).toBe(true);
      expect(agentAny._childResults.get("child-A")).toEqual({
        success: true,
        result: "result A",
        error: undefined,
      });
    }, 5000);

    test("TASK_FAILED for child stores failure result", async () => {
      const model = createMockModel();
      const agent = new Agent(createOrchestrationDeps({ model }));
      const agentAny = agent as any;

      agentAny._childTaskIds.add("child-fail");

      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      const failEvent = createEvent(EventType.TASK_FAILED, {
        source: "child-fail",
        taskId: "child-fail",
        payload: { result: "timeout exceeded", finishReason: "error" },
      });
      await agentAny.handleEvent(failEvent);

      expect(agentAny._childTaskIds.has("child-fail")).toBe(false);
      expect(agentAny._childResults.get("child-fail")).toEqual({
        success: false,
        result: undefined,
        error: "timeout exceeded",
      });
    }, 5000);

    test("ignores events for unknown child IDs", async () => {
      const model = createMockModel();
      const agent = new Agent(createOrchestrationDeps({ model }));
      const agentAny = agent as any;

      agentAny._childTaskIds.add("child-known");

      const unknownEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-unknown",
        taskId: "child-unknown",
        payload: { result: "something", finishReason: "complete" },
      });
      await agentAny.handleEvent(unknownEvent);

      expect(agentAny._childResults.has("child-unknown")).toBe(false);
      expect(agentAny._childTaskIds.has("child-known")).toBe(true);
    }, 5000);
  });

  describe("all children done triggers synthesis", () => {
    test("synthesis runs processStep when all children complete", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          return {
            text: `synthesis result call ${callIndex}`,
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const agentAny = agent as any;

      agentAny._childTaskIds.add("child-1");
      agentAny._childTaskIds.add("child-2");

      const state = agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "coordinate tasks" },
      ], {
        onComplete: () => {},
      });

      const eventBus = agentAny.eventBus;
      if (!eventBus.isRunning) {
        await eventBus.start();
      }

      // Complete child-1
      const event1 = createEvent(EventType.TASK_COMPLETED, {
        source: "child-1",
        taskId: "child-1",
        payload: { result: "child 1 done", finishReason: "complete" },
      });
      await agentAny.handleEvent(event1);

      expect(agentAny._childTaskIds.size).toBe(1);

      // Complete child-2 → should trigger synthesis
      const event2 = createEvent(EventType.TASK_COMPLETED, {
        source: "child-2",
        taskId: "child-2",
        payload: { result: "child 2 done", finishReason: "complete" },
      });
      await agentAny.handleEvent(event2);

      await new Promise((r) => setTimeout(r, 50));

      expect(agentAny._childTaskIds.size).toBe(0);
      expect(callIndex).toBeGreaterThanOrEqual(1);

      const messages = state.messages;
      const synthesisMsg = messages.find(
        (m: any) => m.role === "user" && m.content.includes("All child tasks completed"),
      );
      expect(synthesisMsg).toBeDefined();
      expect(synthesisMsg!.content).toContain("child 1 done");
      expect(synthesisMsg!.content).toContain("child 2 done");

      await eventBus.stop();
    }, 5000);
  });

  describe("notify self-executes via ToolContext.onNotify", () => {
    test("notify tool triggers onNotify callback with progress", async () => {
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
                  arguments: { message: "progress: 50% done" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "all done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const registry = new ToolRegistry();
      registry.register(notify);
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          toolRegistry: registry,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );

      const result = await agent.run("Do something");

      expect(result.success).toBe(true);

      const progressCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "progress",
      );
      expect(progressCalls.length).toBe(1);
      expect((progressCalls[0]![0] as { type: "progress"; message: string }).message).toBe("progress: 50% done");
    }, 5000);
  });

  describe("onTaskComplete waits for children", () => {
    test("does not complete when children are pending", async () => {
      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const agentAny = agent as any;

      agentAny._childTaskIds.add("child-pending");

      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ], {
        onComplete: () => {},
      });

      // Call onTaskComplete with "complete" — should NOT complete (children pending)
      await agentAny.onTaskComplete("orch-agent-1", "result text", "complete");

      // The completed notification should NOT have been sent
      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(0);

      // Task state should still exist (not cleaned up)
      expect(agentAny.taskStates.has("orch-agent-1")).toBe(true);
    }, 5000);
  });

  describe("imageRefs collection in onTaskComplete", () => {
    test("collects imageRefs from messages and includes in completed notification", async () => {
      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const agentAny = agent as any;

      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "take screenshot" },
        {
          role: "tool",
          content: "Screenshot taken",
          toolCallId: "call_1",
          images: [{ id: "img_abc123", mimeType: "image/png" }],
        },
      ], {
        onComplete: () => {},
      });

      await agentAny.onTaskComplete("orch-agent-1", "screenshot done", "complete");

      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(1);
      const completedNotif = completedCalls[0]![0] as OrchestratorNotification & { type: "completed" };
      expect(completedNotif.imageRefs).toEqual([{ id: "img_abc123", mimeType: "image/png" }]);
    }, 5000);

    test("deduplicates imageRefs across multiple messages", async () => {
      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );
      const agentAny = agent as any;

      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "do screenshots" },
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
          content: "Second screenshot with duplicate",
          toolCallId: "call_2",
          images: [
            { id: "img_aaa", mimeType: "image/png" }, // duplicate
            { id: "img_ccc", mimeType: "image/webp" },
          ],
        },
      ], {
        onComplete: () => {},
      });

      await agentAny.onTaskComplete("orch-agent-1", "done", "complete");

      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(1);
      const completedNotif = completedCalls[0]![0] as OrchestratorNotification & { type: "completed" };
      expect(completedNotif.imageRefs).toEqual([
        { id: "img_aaa", mimeType: "image/png" },
        { id: "img_bbb", mimeType: "image/jpeg" },
        { id: "img_ccc", mimeType: "image/webp" },
      ]);
    }, 5000);

    test("does not include imageRefs when no messages have images", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "no images here",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: mock(() => ({
              id: "c1",
              promise: Promise.resolve({ success: true }),
            })),
            onNotify: notifyCb,
          },
        }),
      );

      const result = await agent.run("Do something");

      expect(result.success).toBe(true);

      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(1);
      const completedNotif = completedCalls[0]![0] as OrchestratorNotification & { type: "completed" };
      expect(completedNotif.imageRefs).toBeUndefined();
    }, 5000);
  });

  describe("handle.promise rejection in _interceptSpawnTask", () => {
    test("captures error when child handle.promise rejects", async () => {
      const deferred = createDeferredHandle("child-reject-1");
      const spawnMock = mock((_config: any) => deferred.handle);

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
                  id: "tc-spawn-reject",
                  name: "spawn_task",
                  arguments: {
                    description: "failing sub-task",
                    input: "do something that fails",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done with spawn",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new Agent(
        createOrchestrationDeps({
          model,
          orchestration: {
            onSpawnExecution: spawnMock,
            onNotify: notifyCb,
          },
        }),
      );

      const agentAny = agent as any;
      const runPromise = agent.run("Test rejection");

      await new Promise((r) => setTimeout(r, 50));

      deferred.reject(new Error("child crashed hard"));
      await new Promise((r) => setTimeout(r, 50));

      // Complete child via event so run() can finish
      const completedEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-reject-1",
        taskId: "child-reject-1",
        payload: { result: "fallback", finishReason: "complete" },
      });
      await agentAny.handleEvent(completedEvent);

      await runPromise;

      expect(agentAny._childResults.has("child-reject-1")).toBe(true);
      const childResult = agentAny._childResults.get("child-reject-1");
      expect(childResult).toBeDefined();
    }, 10000);
  });

  describe("TASK_SUSPENDED sets abort flag", () => {
    test("sets aborted flag on task state when TASK_SUSPENDED received", async () => {
      const agent = new Agent(createOrchestrationDeps());
      const agentAny = agent as any;

      const state = agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      expect(state.aborted).toBe(false);

      const suspendEvent = createEvent(EventType.TASK_SUSPENDED, {
        source: "orch-agent-1",
        taskId: "orch-agent-1",
        payload: { reason: "user requested" },
      });

      await agentAny.handleEvent(suspendEvent);

      expect(state.aborted).toBe(true);
    }, 5000);
  });

  describe("non-orchestration mode unaffected", () => {
    test("Agent without orchestration does not intercept spawn_task", async () => {
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
                  id: "tc-spawn-1",
                  name: "spawn_task",
                  arguments: {
                    description: "sub-task",
                    input: "do something",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      // Agent WITHOUT orchestration — spawn_task goes through normal tool execution
      const agent = new Agent({
        agentId: "no-orch",
        model,
        toolRegistry: new ToolRegistry(),
        systemPrompt: "You are a test agent.",
        sessionDir: tempDir,
      });

      const agentAny = agent as any;
      // No _orchestration set
      expect(agentAny._orchestration).toBeUndefined();

      // onToolCall should return execute action for spawn_task
      const result = await agentAny.onToolCall({
        id: "tc-1",
        name: "spawn_task",
        arguments: { description: "test", input: "test" },
      });
      expect(result.action).toBe("execute");
    }, 5000);
  });
});
