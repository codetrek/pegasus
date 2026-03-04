/**
 * Tests for OrchestratorAgent — decomposes tasks and coordinates child execution.
 *
 * Exercises:
 *   - run() returns success with text from LLM
 *   - spawn_task interception adds to childTaskIds
 *   - handleEvent processes child completion
 *   - all children done triggers synthesis
 *   - notify interception works
 *   - subscribeEvents registers correct events
 *   - handleEvent TASK_SUSPENDED sets abort flag
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  OrchestratorAgent,
  type OrchestratorAgentDeps,
  type ExecutionHandle,
  type OrchestratorNotification,
} from "../../../../src/agents/base/orchestrator-agent.ts";
import type { LanguageModel } from "../../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ──────────────────────────────────────────

/** Create a mock LanguageModel with configurable generate behavior. */
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
  return mkdtemp(path.join(os.tmpdir(), "pegasus-orch-test-"));
}

/** Create a deferred promise for child execution handles. */
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

function createOrchestratorDeps(
  overrides?: Partial<OrchestratorAgentDeps>,
): OrchestratorAgentDeps {
  return {
    agentId: "orch-agent-1",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    taskDescription: "Coordinate the test tasks",
    input: "Process these items",
    sessionDir: tempDir,
    onSpawnExecution: mock(() => ({
      id: "child-1",
      promise: Promise.resolve({ success: true, result: "child done" }),
    })),
    onNotify: mock(() => {}),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────

describe("OrchestratorAgent", () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  describe("run() returns success", () => {
    test("returns success result with text from LLM", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "orchestration result: all done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ model, onNotify: notifyCb }),
      );
      const result = await agent.run();

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
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ model, onNotify: notifyCb }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(notifyCb).toHaveBeenCalled();

      // Find the "completed" notification
      const completedCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "completed",
      );
      expect(completedCalls.length).toBe(1);
    }, 5000);

    test("returns failure on LLM error", async () => {
      const model = createMockModel(
        mock(async () => {
          throw new Error("LLM down");
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ model, onNotify: notifyCb }),
      );
      const result = await agent.run();

      expect(result.success).toBe(false);
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
          // After spawn, LLM finishes (no more tool calls)
          return {
            text: "spawned tasks",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({
          model,
          onSpawnExecution: spawnMock,
          onNotify: notifyCb,
        }),
      );

      // Access private childTaskIds for verification
      const agentAny = agent as any;

      // Start run but don't await yet — we need to check childTaskIds during execution
      const runPromise = agent.run();

      // Wait for spawn to happen
      await new Promise((r) => setTimeout(r, 200));

      // Child should be tracked
      expect(agentAny.childTaskIds.has("child-spawn-1")).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Now resolve child and trigger synthesis
      deferred.resolve({ success: true, result: "A done" });

      // Emit child TASK_COMPLETED event to trigger synthesis
      const completedEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-spawn-1",
        taskId: "child-spawn-1",
        payload: { result: "A done", finishReason: "complete" },
      });
      await agentAny.handleEvent(completedEvent);

      await runPromise;
      // Result may vary (synthesis may or may not happen before resolve)
      // The important assertion is that spawnMock was called
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]![0].description).toBe("sub-task A");
    }, 5000);
  });

  describe("handleEvent processes child completion", () => {
    test("TASK_COMPLETED for child stores result and removes from tracking", async () => {
      const model = createMockModel();
      const agent = new OrchestratorAgent(createOrchestratorDeps({ model }));
      const agentAny = agent as any;

      // Manually set up state as if we had spawned children
      agentAny.childTaskIds.add("child-A");
      agentAny.childTaskIds.add("child-B");

      // Also create task execution state so synthesis can work
      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      // Process child-A completion
      const eventA = createEvent(EventType.TASK_COMPLETED, {
        source: "child-A",
        taskId: "child-A",
        payload: { result: "result A", finishReason: "complete" },
      });
      await agentAny.handleEvent(eventA);

      // child-A should be removed, child-B still tracked
      expect(agentAny.childTaskIds.has("child-A")).toBe(false);
      expect(agentAny.childTaskIds.has("child-B")).toBe(true);
      expect(agentAny.childResults.get("child-A")).toEqual({
        success: true,
        result: "result A",
        error: undefined,
      });
    }, 5000);

    test("TASK_FAILED for child stores failure result", async () => {
      const model = createMockModel();
      const agent = new OrchestratorAgent(createOrchestratorDeps({ model }));
      const agentAny = agent as any;

      agentAny.childTaskIds.add("child-fail");

      // Also create task execution state so handleEvent works
      agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      const failEvent = createEvent(EventType.TASK_FAILED, {
        source: "child-fail",
        taskId: "child-fail",
        payload: { result: "timeout exceeded", finishReason: "error" },
      });
      await agentAny.handleEvent(failEvent);

      expect(agentAny.childTaskIds.has("child-fail")).toBe(false);
      expect(agentAny.childResults.get("child-fail")).toEqual({
        success: false,
        result: undefined,
        error: "timeout exceeded",
      });
    }, 5000);

    test("ignores events for unknown child IDs", async () => {
      const model = createMockModel();
      const agent = new OrchestratorAgent(createOrchestratorDeps({ model }));
      const agentAny = agent as any;

      agentAny.childTaskIds.add("child-known");

      const unknownEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-unknown",
        taskId: "child-unknown",
        payload: { result: "something", finishReason: "complete" },
      });
      await agentAny.handleEvent(unknownEvent);

      // Should not have stored anything for unknown child
      expect(agentAny.childResults.has("child-unknown")).toBe(false);
      // Known child still tracked
      expect(agentAny.childTaskIds.has("child-known")).toBe(true);
    }, 5000);
  });

  describe("all children done triggers synthesis", () => {
    test("synthesis runs processStep when all children complete", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          // Synthesis call (will be called after child results injected)
          return {
            text: `synthesis result call ${callIndex}`,
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_n: OrchestratorNotification) => {});
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ model, onNotify: notifyCb }),
      );
      const agentAny = agent as any;

      // Set up as if we're mid-orchestration with 2 children spawned
      agentAny.childTaskIds.add("child-1");
      agentAny.childTaskIds.add("child-2");

      // Create task state
      const state = agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "coordinate tasks" },
      ], {
        onComplete: () => {},
      });

      // Subscribe events for child tracking
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

      // child-2 still pending — synthesis should NOT have run yet
      expect(agentAny.childTaskIds.size).toBe(1);

      // Complete child-2 — this should trigger synthesis
      const event2 = createEvent(EventType.TASK_COMPLETED, {
        source: "child-2",
        taskId: "child-2",
        payload: { result: "child 2 done", finishReason: "complete" },
      });
      await agentAny.handleEvent(event2);

      // Wait for async processStep
      await new Promise((r) => setTimeout(r, 300));

      // All children done
      expect(agentAny.childTaskIds.size).toBe(0);

      // Model should have been called for synthesis
      expect(callIndex).toBeGreaterThanOrEqual(1);

      // Check that child results were injected into messages
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

  describe("notify interception works", () => {
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
      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ model, onNotify: notifyCb }),
      );

      const result = await agent.run();

      expect(result.success).toBe(true);

      // Should have received a progress notification
      const progressCalls = notifyCb.mock.calls.filter(
        (call: any) => call[0].type === "progress",
      );
      expect(progressCalls.length).toBe(1);
      expect((progressCalls[0]![0] as { type: "progress"; message: string }).message).toBe("progress: 50% done");
    }, 5000);
  });

  describe("subscribeEvents registers correct events", () => {
    test("subscribes to TASK_CREATED, TASK_COMPLETED, TASK_FAILED, TASK_SUSPENDED", async () => {
      const eventBus = new EventBus();

      // Track subscribe calls
      const subscribedTypes: (number | null)[] = [];
      const originalSubscribe = eventBus.subscribe.bind(eventBus);
      eventBus.subscribe = (type: any, handler: any) => {
        subscribedTypes.push(type);
        return originalSubscribe(type, handler);
      };

      const agent = new OrchestratorAgent(
        createOrchestratorDeps({ eventBus }),
      );

      // start() calls subscribeEvents()
      await agent.start();

      expect(subscribedTypes).toContain(EventType.TASK_CREATED);
      expect(subscribedTypes).toContain(EventType.TASK_COMPLETED);
      expect(subscribedTypes).toContain(EventType.TASK_FAILED);
      expect(subscribedTypes).toContain(EventType.TASK_SUSPENDED);

      await agent.stop();
    }, 5000);
  });

  describe("handleEvent TASK_SUSPENDED sets abort", () => {
    test("sets aborted flag on task state when TASK_SUSPENDED received", async () => {
      const agent = new OrchestratorAgent(createOrchestratorDeps());
      const agentAny = agent as any;

      // Create task state
      const state = agentAny.createTaskExecutionState("orch-agent-1", [
        { role: "user", content: "test" },
      ]);

      expect(state.aborted).toBe(false);

      // Simulate TASK_SUSPENDED event
      const suspendEvent = createEvent(EventType.TASK_SUSPENDED, {
        source: "orch-agent-1",
        taskId: "orch-agent-1",
        payload: { reason: "user requested" },
      });

      await agentAny.handleEvent(suspendEvent);

      expect(state.aborted).toBe(true);
    }, 5000);
  });
});
