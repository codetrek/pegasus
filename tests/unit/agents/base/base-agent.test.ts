/**
 * Tests for Agent — unified concrete agent class for Pegasus.
 *
 * Uses a TestAgent subclass to exercise:
 *   - Constructor wiring (agentId, model, toolRegistry)
 *   - Lifecycle (start/stop, isRunning)
 *   - State manager accessibility
 *   - Event queue (immediate processing, queuing when BUSY, drain on complete)
 *   - processStep event-driven engine (non-blocking tool dispatch, task completion)
 *   - Compaction (beforeLLMCall, onLLMError, mechanicalSummary)
 */

import { describe, test, expect, mock, afterEach } from "bun:test";
import { Agent, type AgentDeps } from "../../../../src/agents/agent.ts";
import { AgentState } from "../../../../src/agents/base/agent-state.ts";
import type { Event } from "../../../../src/events/types.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import type { LanguageModel, Message } from "../../../../src/infra/llm-types.ts";
import type { TaskExecutionState, CreateTaskStateOptions } from "../../../../src/agents/base/task-execution-state.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MAX_OVERFLOW_COMPACT_RETRIES,
} from "../../../../src/context/index.ts";

// ── Helpers ──────────────────────────────────────────

/** Minimal mock LanguageModel that returns text with no tool calls. */
function createMockModel(overrides?: Partial<LanguageModel>): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    generate: mock(async () => ({
      text: "mock response",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    })),
    ...overrides,
  };
}

/** Create a ToolRegistry with no tools registered. */
function createMockRegistry(): ToolRegistry {
  return new ToolRegistry();
}

/** Concrete TestAgent subclass for testing Agent's behavior. */
class TestAgent extends Agent {
  public handleEventMock = mock(async (_event: Event) => {});
  public subscribeEventsMock = mock(() => {});
  public onTaskCompleteMock = mock(
    async (_taskId: string, _text: string, _reason: string) => {},
  );

  protected override subscribeEvents(): void {
    this.subscribeEventsMock();
    // Call super to get the default child task event handling
    super.subscribeEvents();
  }

  protected override async handleEvent(event: Event): Promise<void> {
    await this.handleEventMock(event);
  }

  protected override async onTaskComplete(
    taskId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    await this.onTaskCompleteMock(taskId, text, finishReason);
  }

  /** Expose protected queueEvent for testing. */
  testQueueEvent(event: Event): void {
    this.queueEvent(event);
  }

  /** Expose event queue length for assertions. */
  get eventQueueLength(): number {
    return (this as any)._eventQueue.length;
  }

  /** Expose protected processStep for testing. */
  testProcessStep(taskId: string): Promise<void> {
    return this.processStep(taskId);
  }

  /** Expose protected createTaskExecutionState for testing. */
  testCreateTaskState(
    taskId: string,
    messages: Message[],
    opts?: CreateTaskStateOptions,
  ): TaskExecutionState {
    return this.createTaskExecutionState(taskId, messages, opts);
  }

  /** Expose protected removeTaskState for testing. */
  testRemoveTaskState(taskId: string): void {
    this.removeTaskState(taskId);
  }

  /** Expose taskStates for assertions. */
  getTaskStates(): Map<string, TaskExecutionState> {
    return this.taskStates;
  }

  /** Expose sessionStore for assertions. */
  getSessionStore() {
    return this.sessionStore;
  }

  /** Expose beforeLLMCall for testing. */
  testBeforeLLMCall(taskId: string): Promise<void> {
    return this.beforeLLMCall(taskId);
  }

  /** Expose onLLMError for testing. */
  testOnLLMError(taskId: string, error: unknown): Promise<boolean> {
    return this.onLLMError(taskId, error);
  }
}

function createTestAgent(overrides?: Partial<AgentDeps>): TestAgent {
  return new TestAgent({
    agentId: "test-agent-1",
    model: createMockModel(),
    toolRegistry: createMockRegistry(),
    systemPrompt: "test prompt",
    sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
    ...overrides,
  });
}

function makeEvent(type: number = EventType.MESSAGE_RECEIVED): Event {
  return createEvent(type as any, { source: "test" });
}

// ── Tests ────────────────────────────────────────────

describe("Agent", () => {
  describe("constructor", () => {
    test("sets agentId, model, toolRegistry", () => {
      const model = createMockModel();
      const registry = createMockRegistry();
      const agent = new TestAgent({
        agentId: "my-agent",
        model,
        toolRegistry: registry,
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });

      expect(agent.agentId).toBe("my-agent");
      // model and toolRegistry are protected; verify indirectly via stateManager existing
      expect(agent.stateManager).toBeDefined();
      expect(agent.eventBus).toBeInstanceOf(EventBus);
    });

    test("creates a new EventBus when none provided", () => {
      const agent = createTestAgent();
      expect(agent.eventBus).toBeInstanceOf(EventBus);
    });

    test("uses provided EventBus when given", () => {
      const bus = new EventBus();
      const agent = createTestAgent({ eventBus: bus });
      expect(agent.eventBus).toBe(bus);
    });

    test("defaults maxIterations to 25", () => {
      const agent = createTestAgent();
      expect((agent as any).maxIterations).toBe(25);
    });

    test("accepts custom maxIterations", () => {
      const agent = createTestAgent({ maxIterations: 10 });
      expect((agent as any).maxIterations).toBe(10);
    });
  });

  describe("start() and stop() lifecycle", () => {
    test("start() sets isRunning to true and calls subscribeEvents", async () => {
      const agent = createTestAgent();
      expect(agent.isRunning).toBe(false);

      await agent.start();
      expect(agent.isRunning).toBe(true);
      expect(agent.subscribeEventsMock).toHaveBeenCalledTimes(1);

      await agent.stop();
    });

    test("stop() sets isRunning to false", async () => {
      const agent = createTestAgent();
      await agent.start();
      expect(agent.isRunning).toBe(true);

      await agent.stop();
      expect(agent.isRunning).toBe(false);
    });
  });

  describe("isRunning flag", () => {
    test("is false before start", () => {
      const agent = createTestAgent();
      expect(agent.isRunning).toBe(false);
    });

    test("is true after start, false after stop", async () => {
      const agent = createTestAgent();
      await agent.start();
      expect(agent.isRunning).toBe(true);
      await agent.stop();
      expect(agent.isRunning).toBe(false);
    });
  });

  describe("state manager accessibility", () => {
    test("stateManager is accessible and starts IDLE", () => {
      const agent = createTestAgent();
      expect(agent.stateManager).toBeDefined();
      expect(agent.stateManager.state).toBe(AgentState.IDLE);
    });

    test("stateManager tracks canAcceptWork", () => {
      const agent = createTestAgent();
      expect(agent.stateManager.canAcceptWork).toBe(true);

      agent.stateManager.markBusy();
      expect(agent.stateManager.canAcceptWork).toBe(false);

      agent.stateManager.markIdle();
      expect(agent.stateManager.canAcceptWork).toBe(true);
    });
  });

  describe("queueEvent() processes immediately when IDLE", () => {
    test("calls handleEvent directly when agent can accept work", async () => {
      const agent = createTestAgent();
      const event = makeEvent();

      // Agent is IDLE (canAcceptWork = true), so handleEvent should be called
      agent.testQueueEvent(event);

      // Allow microtask to run (fire-and-forget)
      await new Promise((r) => setTimeout(r, 50));

      expect(agent.handleEventMock).toHaveBeenCalledTimes(1);
      expect(agent.handleEventMock).toHaveBeenCalledWith(event);
      expect(agent.eventQueueLength).toBe(0);
    });
  });

  describe("queueEvent() queues when BUSY", () => {
    test("adds event to queue when agent is BUSY", () => {
      const agent = createTestAgent();
      // Force BUSY state
      agent.stateManager.markBusy();

      const event = makeEvent();
      agent.testQueueEvent(event);

      // Event should be queued, not handled
      expect(agent.handleEventMock).not.toHaveBeenCalled();
      expect(agent.eventQueueLength).toBe(1);

      // Reset to avoid dangling state
      agent.stateManager.markIdle();
    });

    test("queues multiple events when BUSY", () => {
      const agent = createTestAgent();
      agent.stateManager.markBusy();

      agent.testQueueEvent(makeEvent());
      agent.testQueueEvent(makeEvent());
      agent.testQueueEvent(makeEvent());

      expect(agent.eventQueueLength).toBe(3);
      expect(agent.handleEventMock).not.toHaveBeenCalled();

      agent.stateManager.markIdle();
    });
  });

  describe("completePendingWork() removes work and drains queue", () => {
    test("removes pending work and transitions from WAITING to IDLE", async () => {
      const agent = createTestAgent();

      // Simulate: markBusy → add pending work → markIdle (→ WAITING)
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "work-1",
        kind: "child_agent",
        description: "test work",
        dispatchedAt: Date.now(),
      });
      // addPendingWork auto-transitions BUSY → WAITING
      expect(agent.stateManager.state).toBe(AgentState.WAITING);

      // Complete the pending work
      await agent.completePendingWork({
        id: "work-1",
        success: true,
        result: "done",
      });

      // Should be IDLE now (no more pending work)
      expect(agent.stateManager.state).toBe(AgentState.IDLE);
      expect(agent.stateManager.pendingCount).toBe(0);
    });

    test("drains queued events after pending work completes", async () => {
      const agent = createTestAgent();

      // Simulate BUSY with pending work and queued events
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "work-2",
        kind: "child_agent",
        description: "test work",
        dispatchedAt: Date.now(),
      });

      // Queue some events while agent was BUSY
      // Note: markBusy → addPendingWork makes it WAITING, which canAcceptWork.
      // We need events queued while BUSY — queue them before addPendingWork.
      const agent2 = createTestAgent();
      agent2.stateManager.markBusy();

      const ev1 = makeEvent();
      const ev2 = makeEvent();
      agent2.testQueueEvent(ev1);
      agent2.testQueueEvent(ev2);
      expect(agent2.eventQueueLength).toBe(2);

      // Add pending work (transitions to WAITING)
      agent2.stateManager.addPendingWork({
        id: "work-3",
        kind: "child_agent",
        description: "test work",
        dispatchedAt: Date.now(),
      });

      // Complete pending work → should drain queued events
      await agent2.completePendingWork({
        id: "work-3",
        success: true,
        result: "done",
      });

      // Wait for drain
      await new Promise((r) => setTimeout(r, 50));

      expect(agent2.eventQueueLength).toBe(0);
      expect(agent2.handleEventMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("queueEvent error handling", () => {
    test("logs error when handleEvent throws during immediate processing", async () => {
      class ErrorAgent extends TestAgent {
        protected override async handleEvent(_event: Event): Promise<void> {
          throw new Error("handler boom");
        }
      }
      const agent = new ErrorAgent({
        agentId: "error-agent",
        model: createMockModel(),
        toolRegistry: createMockRegistry(),
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });

      // Should not throw — error is caught and logged
      agent.testQueueEvent(makeEvent());
      await new Promise((r) => setTimeout(r, 50));
      // No assertion needed — just verify no uncaught exception
    });
  });

  describe("default getTools", () => {
    test("getTools returns toLLMTools from registry", () => {
      const registry = createMockRegistry();
      const agent = createTestAgent({ toolRegistry: registry });
      const tools = (agent as any).getTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(0); // empty registry
    });
  });

  describe("drainEventQueue error handling", () => {
    test("continues draining after one event handler throws", async () => {
      let callCount = 0;
      class PartialErrorAgent extends TestAgent {
        protected override async handleEvent(_event: Event): Promise<void> {
          callCount++;
          if (callCount === 1) throw new Error("first event fails");
          // second event succeeds
        }
      }
      const agent = new PartialErrorAgent({
        agentId: "partial-error-agent",
        model: createMockModel(),
        toolRegistry: createMockRegistry(),
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });

      // Queue two events while BUSY
      agent.stateManager.markBusy();
      agent.testQueueEvent(makeEvent());
      agent.testQueueEvent(makeEvent());
      expect(agent.eventQueueLength).toBe(2);

      // Trigger drain by going IDLE
      agent.stateManager.markIdle();
      await (agent as any).drainEventQueue();

      // Both should have been attempted
      expect(callCount).toBe(2);
      expect(agent.eventQueueLength).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════
  // processStep Engine Tests
  // ═══════════════════════════════════════════════════

  describe("processStep — no tool calls → task complete", () => {
    test("calls onTaskComplete with 'complete' when LLM returns text only", async () => {
      const model = createMockModel({
        generate: mock(async () => ({
          text: "final answer",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      });
      const agent = createTestAgent({ model });

      agent.testCreateTaskState("task-1", [
        { role: "user", content: "hello" },
      ]);

      await agent.testProcessStep("task-1");

      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "final answer",
        "complete",
      );

      // Assistant message should have been appended
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.messages).toHaveLength(2); // user + assistant
      expect(state.messages[1]!.role).toBe("assistant");
      expect(state.messages[1]!.content).toBe("final answer");
      expect(state.iteration).toBe(1);
    });

    test("agent returns to IDLE after completing with no tool calls", async () => {
      const model = createMockModel({
        generate: mock(async () => ({
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      });
      const agent = createTestAgent({ model });
      agent.testCreateTaskState("task-1", [{ role: "user", content: "hi" }]);

      await agent.testProcessStep("task-1");

      expect(agent.stateManager.state).toBe(AgentState.IDLE);
    });
  });

  describe("processStep — dispatches tools fire-and-forget", () => {
    test("dispatches tools and returns before tools complete, then _onAllToolsDone triggers next LLM call", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "thinking",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "test_tool", arguments: { x: 1 } },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          // Second call: no more tool calls
          return {
            text: "final",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      });

      // Register a tool so getTools() is non-empty
      const registry = createMockRegistry();
      registry.register({
        name: "test_tool",
        description: "test",
        category: "system" as any,
        parameters: z.object({ x: z.number().optional() }),
        execute: mock(async () => ({
          success: true,
          result: "tool result",
          startedAt: Date.now(),
        })),
      });

      const agent = createTestAgent({ model, toolRegistry: registry });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "do something" },
      ]);

      await agent.testProcessStep("task-1");

      // Wait for async tool execution and next processStep
      await new Promise((r) => setTimeout(r, 50));

      // Should have called LLM twice: first with tool calls, second with final answer
      expect(llmCallCount).toBe(2);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith("task-1", "final", "complete");

      // Messages should contain: user, assistant(tool_calls), tool_result, assistant(final)
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.messages).toHaveLength(4);
      expect(state.messages[0]!.role).toBe("user");
      expect(state.messages[1]!.role).toBe("assistant");
      expect(state.messages[1]!.toolCalls).toHaveLength(1);
      expect(state.messages[2]!.role).toBe("tool");
      expect(state.messages[3]!.role).toBe("assistant");
      expect(state.messages[3]!.content).toBe("final");
    }, 5000);
  });

  describe("processStep — emits STEP_COMPLETED event", () => {
    test("emits STEP_COMPLETED with hasToolCalls=false when no tools", async () => {
      const bus = new EventBus();
      const emittedEvents: Event[] = [];
      bus.subscribe(EventType.STEP_COMPLETED, async (e) => {
        emittedEvents.push(e);
      });
      await bus.start();

      const model = createMockModel({
        generate: mock(async () => ({
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      });
      const agent = createTestAgent({ model, eventBus: bus });
      agent.testCreateTaskState("task-1", [{ role: "user", content: "hi" }]);

      await agent.testProcessStep("task-1");

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]!.type).toBe(EventType.STEP_COMPLETED);
      expect(emittedEvents[0]!.taskId).toBe("task-1");
      expect(emittedEvents[0]!.payload.hasToolCalls).toBe(false);
      expect(emittedEvents[0]!.payload.iteration).toBe(1);

      await bus.stop();
    });

    test("emits STEP_COMPLETED with hasToolCalls=true and toolCount when tools present", async () => {
      const bus = new EventBus();
      const emittedEvents: Event[] = [];
      bus.subscribe(EventType.STEP_COMPLETED, async (e) => {
        emittedEvents.push(e);
      });
      await bus.start();

      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "test_tool", arguments: {} },
                { id: "tc-2", name: "test_tool2", arguments: {} },
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
      });

      // Register tools so they can be executed (no onToolCall intercept anymore)
      const registry = createMockRegistry();
      registry.register({
        name: "test_tool",
        description: "test",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ ok: true }),
          startedAt: Date.now(),
        })),
      });
      registry.register({
        name: "test_tool2",
        description: "test2",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ ok: true }),
          startedAt: Date.now(),
        })),
      });

      const agent = createTestAgent({
        model,
        toolRegistry: registry,
        eventBus: bus,
      });
      agent.testCreateTaskState("task-1", [{ role: "user", content: "hi" }]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 50));

      // First event should have hasToolCalls=true, toolCount=2
      expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
      expect(emittedEvents[0]!.payload.hasToolCalls).toBe(true);
      expect(emittedEvents[0]!.payload.toolCount).toBe(2);

      await bus.stop();
    }, 5000);
  });

  describe("processStep — max iterations", () => {
    test("calls onTaskComplete with 'max_iterations' when limit reached", async () => {
      const model = createMockModel();
      const agent = createTestAgent({ model });

      // Create state with maxIterations already at limit
      const state = agent.testCreateTaskState("task-1", [
        { role: "user", content: "hi" },
      ], { maxIterations: 3 });
      state.iteration = 3; // Already at max

      await agent.testProcessStep("task-1");

      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "",
        "max_iterations",
      );

      // LLM should NOT have been called
      expect(model.generate).not.toHaveBeenCalled();
    });
  });

  describe("processStep — respects aborted flag", () => {
    test("returns immediately when state is aborted", async () => {
      const model = createMockModel();
      const agent = createTestAgent({ model });

      const state = agent.testCreateTaskState("task-1", [
        { role: "user", content: "hi" },
      ]);
      state.aborted = true;

      await agent.testProcessStep("task-1");

      // LLM should NOT have been called
      expect(model.generate).not.toHaveBeenCalled();
      // onTaskComplete should NOT have been called (just returns)
      expect(agent.onTaskCompleteMock).not.toHaveBeenCalled();
    });

    test("returns immediately when taskState is missing", async () => {
      const model = createMockModel();
      const agent = createTestAgent({ model });

      // No task state created
      await agent.testProcessStep("nonexistent-task");

      expect(model.generate).not.toHaveBeenCalled();
      expect(agent.onTaskCompleteMock).not.toHaveBeenCalled();
    });
  });

  describe("processStep — parallel tool execution", () => {
    test("LLM returns 2 tool_calls, both execute, _onAllToolsDone fires once both complete", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "running two tools",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "tool_a", arguments: {} },
                { id: "tc-2", name: "tool_b", arguments: {} },
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
      });

      // Register tools so they can be executed
      const registry = createMockRegistry();
      registry.register({
        name: "tool_a",
        description: "tool a",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ result: "tool_a_done" }),
          startedAt: Date.now(),
        })),
      });
      registry.register({
        name: "tool_b",
        description: "tool b",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ result: "tool_b_done" }),
          startedAt: Date.now(),
        })),
      });

      const agent = createTestAgent({ model, toolRegistry: registry });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "run two tools" },
      ]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 50));

      expect(llmCallCount).toBe(2);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith("task-1", "all done", "complete");

      // Messages: user, assistant(2 tool_calls), tool_result_1, tool_result_2, assistant(final)
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.messages).toHaveLength(5);
      expect(state.messages[2]!.role).toBe("tool");
      expect(state.messages[3]!.role).toBe("tool");
    }, 5000);
  });

  describe("processStep — _onAllToolsDone checks abort", () => {
    test("_onAllToolsDone calls onTaskComplete with 'interrupted' when aborted during tool execution", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "tc-1", name: "slow_tool", arguments: {} },
            ],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      });

      // Register a tool that sets aborted flag during execution
      const registry = createMockRegistry();
      const agent = createTestAgent({ model, toolRegistry: registry });
      registry.register({
        name: "slow_tool",
        description: "a tool that aborts",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => {
          // Set aborted flag during tool execution
          const state = agent.getTaskStates().get("task-1");
          if (state) state.aborted = true;
          return {
            success: true,
            result: JSON.stringify({ done: true }),
            startedAt: Date.now(),
          };
        }),
      });

      agent.testCreateTaskState("task-1", [
        { role: "user", content: "start" },
      ]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 50));

      // LLM should only be called once (second processStep should not fire)
      expect(llmCallCount).toBe(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith("task-1", "", "interrupted");
    }, 5000);
  });

  describe("processStep — LLM error", () => {
    test("calls onTaskComplete with 'error' when LLM throws", async () => {
      const model = createMockModel({
        generate: mock(async () => {
          throw new Error("LLM API error");
        }),
      });
      const agent = createTestAgent({ model });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "hi" },
      ]);

      await agent.testProcessStep("task-1");

      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "",
        "error",
      );

      // Agent should be back to IDLE
      expect(agent.stateManager.state).toBe(AgentState.IDLE);
    });
  });

  describe("onLLMError hook", () => {
    test("onLLMError returns true → processStep retries and succeeds", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            throw new Error("transient error");
          }
          return {
            text: "recovered",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      });

      let onLLMErrorCallCount = 0;
      class RetryAgent extends TestAgent {
        protected override async onLLMError(_taskId: string, _error: unknown): Promise<boolean> {
          onLLMErrorCallCount++;
          // Retry on first call, fail on second
          return onLLMErrorCallCount === 1;
        }
      }

      const agent = new RetryAgent({
        agentId: "retry-agent",
        model,
        toolRegistry: createMockRegistry(),
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "hi" },
      ]);

      await agent.testProcessStep("task-1");

      // LLM should have been called twice: first fails, retry succeeds
      expect(llmCallCount).toBe(2);
      expect(onLLMErrorCallCount).toBe(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "recovered",
        "complete",
      );
    }, 5000);
  });

  describe("onMessagesAppended hook", () => {
    test("onMessagesAppended called with assistant message (no tools)", async () => {
      const model = createMockModel({
        generate: mock(async () => ({
          text: "hello response",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      });

      const appendedCalls: { taskId: string; messages: Message[] }[] = [];
      class HookAgent extends TestAgent {
        protected override async onMessagesAppended(taskId: string, newMessages: Message[]): Promise<void> {
          appendedCalls.push({ taskId, messages: [...newMessages] });
        }
      }

      const agent = new HookAgent({
        agentId: "hook-agent",
        model,
        toolRegistry: createMockRegistry(),
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "hi" },
      ]);

      await agent.testProcessStep("task-1");

      expect(appendedCalls).toHaveLength(1);
      expect(appendedCalls[0]!.taskId).toBe("task-1");
      expect(appendedCalls[0]!.messages).toHaveLength(1);
      expect(appendedCalls[0]!.messages[0]!.role).toBe("assistant");
      expect(appendedCalls[0]!.messages[0]!.content).toBe("hello response");
    });

    test("onMessagesAppended called with tool results in _onAllToolsDone", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "thinking",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "test_tool", arguments: {} },
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
      });

      const appendedCalls: { taskId: string; messages: Message[] }[] = [];

      // Register tool so it can be executed
      const registry = createMockRegistry();
      registry.register({
        name: "test_tool",
        description: "test",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ ok: true }),
          startedAt: Date.now(),
        })),
      });

      class HookToolAgent extends TestAgent {
        protected override async onMessagesAppended(taskId: string, newMessages: Message[]): Promise<void> {
          appendedCalls.push({ taskId, messages: [...newMessages] });
        }
      }

      const agent = new HookToolAgent({
        agentId: "hook-tool-agent",
        model,
        toolRegistry: registry,
        systemPrompt: "test prompt",
        sessionDir: `/tmp/pegasus-test-agent-${Date.now()}`,
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "do something" },
      ]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 50));

      // Should be called 3 times:
      // 1. assistant message with tool calls
      // 2. tool result messages from _onAllToolsDone
      // 3. final assistant message (no tools)
      expect(appendedCalls).toHaveLength(3);

      // First call: assistant with tool calls
      expect(appendedCalls[0]!.messages[0]!.role).toBe("assistant");
      expect(appendedCalls[0]!.messages[0]!.toolCalls).toHaveLength(1);

      // Second call: tool results
      expect(appendedCalls[1]!.messages[0]!.role).toBe("tool");

      // Third call: final assistant message
      expect(appendedCalls[2]!.messages[0]!.role).toBe("assistant");
      expect(appendedCalls[2]!.messages[0]!.content).toBe("done");
    }, 5000);
  });

  describe("createTaskExecutionState and removeTaskState", () => {
    test("creates and registers a task state", () => {
      const agent = createTestAgent();
      const state = agent.testCreateTaskState("task-1", [
        { role: "user", content: "hello" },
      ]);

      expect(state.taskId).toBe("task-1");
      expect(state.messages).toHaveLength(1);
      expect(state.iteration).toBe(0);
      expect(state.maxIterations).toBe(25); // from agent default
      expect(agent.getTaskStates().has("task-1")).toBe(true);
    });

    test("uses provided maxIterations override", () => {
      const agent = createTestAgent();
      const state = agent.testCreateTaskState("task-1", [], {
        maxIterations: 5,
      });
      expect(state.maxIterations).toBe(5);
    });

    test("removeTaskState removes the state", () => {
      const agent = createTestAgent();
      agent.testCreateTaskState("task-1", []);
      expect(agent.getTaskStates().has("task-1")).toBe(true);

      agent.testRemoveTaskState("task-1");
      expect(agent.getTaskStates().has("task-1")).toBe(false);
    });
  });

  describe("processStep — multi-iteration tool cycle", () => {
    test("3-step cycle: LLM→tools→LLM→tools→LLM→done", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "step 1",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "tool_a", arguments: { step: 1 } },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          if (llmCallCount === 2) {
            return {
              text: "step 2",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-2", name: "tool_b", arguments: { step: 2 } },
              ],
              usage: { promptTokens: 15, completionTokens: 8 },
            };
          }
          // Third call: no tools, task complete
          return {
            text: "Done!",
            finishReason: "stop",
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }),
      });

      // Register tools
      const registry = createMockRegistry();
      registry.register({
        name: "tool_a",
        description: "tool a",
        category: "system" as any,
        parameters: z.object({ step: z.number().optional() }),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ result: "tool_a_result" }),
          startedAt: Date.now(),
        })),
      });
      registry.register({
        name: "tool_b",
        description: "tool b",
        category: "system" as any,
        parameters: z.object({ step: z.number().optional() }),
        execute: mock(async () => ({
          success: true,
          result: JSON.stringify({ result: "tool_b_result" }),
          startedAt: Date.now(),
        })),
      });

      const agent = createTestAgent({ model, toolRegistry: registry });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "do a 3-step task" },
      ]);

      await agent.testProcessStep("task-1");
      // Wait for async tool execution chains to complete
      await new Promise((r) => setTimeout(r, 100));

      // Verify: LLM called 3 times
      expect(llmCallCount).toBe(3);

      // Verify: iteration count is 3
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.iteration).toBe(3);

      // Verify: onTaskComplete called once with "complete"
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "Done!",
        "complete",
      );

      // Verify: messages contain the full cycle
      // user, assistant(tc-1), tool(tc-1), assistant(tc-2), tool(tc-2), assistant(Done!)
      expect(state.messages).toHaveLength(6);
      expect(state.messages[0]!.role).toBe("user");
      expect(state.messages[1]!.role).toBe("assistant");
      expect(state.messages[1]!.toolCalls).toHaveLength(1);
      expect(state.messages[2]!.role).toBe("tool");
      expect(state.messages[3]!.role).toBe("assistant");
      expect(state.messages[3]!.toolCalls).toHaveLength(1);
      expect(state.messages[4]!.role).toBe("tool");
      expect(state.messages[5]!.role).toBe("assistant");
      expect(state.messages[5]!.content).toBe("Done!");
    }, 5000);
  });

  describe("processStep — _executeToolAsync catch branch", () => {
    test("when toolExecutor.execute() throws, error is caught and added to collector as JSON error result", async () => {
      let llmCallCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          llmCallCount++;
          if (llmCallCount === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-err-1", name: "failing_tool", arguments: {} },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          // Second call after error result: complete
          return {
            text: "handled error",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      });

      // Create an agent with a tool that throws
      const registry = createMockRegistry();
      registry.register({
        name: "failing_tool",
        description: "a tool that fails",
        category: "system" as any,
        parameters: z.object({}),
        execute: mock(async () => {
          throw new Error("connection reset");
        }),
      });

      const agent = createTestAgent({ model, toolRegistry: registry });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "call the failing tool" },
      ]);

      await agent.testProcessStep("task-1");
      // Wait for async tool execution and next processStep
      await new Promise((r) => setTimeout(r, 100));

      // Collector should have completed despite the error
      expect(llmCallCount).toBe(2);

      // The tool result message should contain the error
      const state = agent.getTaskStates().get("task-1")!;
      const toolMsg = state.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("connection reset");

      // Agent should have completed successfully after handling the error
      expect(agent.onTaskCompleteMock).toHaveBeenCalledTimes(1);
      expect(agent.onTaskCompleteMock).toHaveBeenCalledWith(
        "task-1",
        "handled error",
        "complete",
      );
    }, 5000);
  });
});

// ═══════════════════════════════════════════════════
// Compaction Tests
// ═══════════════════════════════════════════════════

describe("Agent — compaction", () => {
  const tempDirs: string[] = [];
  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pegasus-test-compaction-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
    tempDirs.length = 0;
  });

  /**
   * Build messages that exceed the default compactTrigger.
   * Default model "test-model" uses DEFAULT_MODEL_LIMITS → 128k context.
   * compactTrigger ≈ 128000 * (1/1.2) * 0.7 ≈ 74666 tokens.
   * Need chars ≈ 74666 * 3.5 ≈ 261333. Generate plenty.
   */
  function buildLargeMessages(count: number, charsPerMsg: number): Message[] {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i}: ${"x".repeat(charsPerMsg)}`,
      });
    }
    return msgs;
  }

  describe("beforeLLMCall triggers compaction when estimated tokens exceed budget", () => {
    test("compacts state when messages exceed token budget", async () => {
      const sessionDir = await createTempDir();
      const generateMock = mock(async () => ({
        text: "summary of conversation",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel({ generate: generateMock });
      const agent = createTestAgent({ model, sessionDir });

      // Build messages that exceed default compactTrigger
      const messages = buildLargeMessages(20, 20000);
      const originalLength = messages.length;
      agent.testCreateTaskState("task-1", messages);

      await agent.testBeforeLLMCall("task-1");

      // After compaction, messages should be replaced (loaded from session store)
      const state = agent.getTaskStates().get("task-1")!;
      // The session store would have 1 compact entry (summary) loaded back
      expect(state.messages.length).toBeLessThan(originalLength);
    }, 10000);
  });

  describe("beforeLLMCall does NOT compact when under threshold", () => {
    test("does not compact when estimated tokens are below budget", async () => {
      const sessionDir = await createTempDir();
      const model = createMockModel();
      const agent = createTestAgent({ model, sessionDir });

      // Small messages — well under any threshold
      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "fine" },
        { role: "user", content: "great" },
        { role: "assistant", content: "yes" },
        { role: "user", content: "ok" },
        { role: "assistant", content: "ok" },
      ];
      agent.testCreateTaskState("task-1", messages);

      await agent.testBeforeLLMCall("task-1");

      // Messages should be unchanged — no compaction
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.messages.length).toBe(8);
      expect(state.messages[0]!.content).toBe("hello");
    }, 5000);
  });

  describe("beforeLLMCall does NOT compact when < 8 messages", () => {
    test("skips compaction when fewer than 8 messages", async () => {
      const sessionDir = await createTempDir();
      const model = createMockModel();
      const agent = createTestAgent({ model, sessionDir });

      // Only 5 messages — even if they were huge, should skip
      const messages: Message[] = [
        { role: "user", content: "x".repeat(100000) },
        { role: "assistant", content: "x".repeat(100000) },
        { role: "user", content: "x".repeat(100000) },
        { role: "assistant", content: "x".repeat(100000) },
        { role: "user", content: "x".repeat(100000) },
      ];
      agent.testCreateTaskState("task-1", messages);

      await agent.testBeforeLLMCall("task-1");

      // Messages should be unchanged
      const state = agent.getTaskStates().get("task-1")!;
      expect(state.messages.length).toBe(5);
    }, 5000);
  });

  describe("onLLMError returns true and compacts on context overflow", () => {
    test("returns true and triggers compaction on context overflow error", async () => {
      const sessionDir = await createTempDir();
      const generateMock = mock(async () => ({
        text: "summary",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel({ generate: generateMock });
      const agent = createTestAgent({ model, sessionDir });

      const messages: Message[] = [
        { role: "user", content: "test message" },
        { role: "assistant", content: "response" },
      ];
      agent.testCreateTaskState("task-1", messages);

      const overflowError = new Error("context window length exceeded maximum");
      const shouldRetry = await agent.testOnLLMError("task-1", overflowError);

      expect(shouldRetry).toBe(true);
    }, 10000);
  });

  describe("onLLMError returns false for non-overflow errors", () => {
    test("returns false for generic errors", async () => {
      const sessionDir = await createTempDir();
      const agent = createTestAgent({ sessionDir });

      agent.testCreateTaskState("task-1", [
        { role: "user", content: "test" },
      ]);

      const genericError = new Error("network timeout");
      const shouldRetry = await agent.testOnLLMError("task-1", genericError);

      expect(shouldRetry).toBe(false);
    }, 5000);

    test("returns false for rate limit errors", async () => {
      const sessionDir = await createTempDir();
      const agent = createTestAgent({ sessionDir });

      agent.testCreateTaskState("task-1", [
        { role: "user", content: "test" },
      ]);

      const rateLimitError = new Error("rate limit exceeded");
      const shouldRetry = await agent.testOnLLMError("task-1", rateLimitError);

      expect(shouldRetry).toBe(false);
    }, 5000);
  });

  describe("onLLMError returns false after MAX_OVERFLOW_COMPACT_RETRIES", () => {
    test("stops retrying after max retries reached", async () => {
      const sessionDir = await createTempDir();
      const generateMock = mock(async () => ({
        text: "summary",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel({ generate: generateMock });
      const agent = createTestAgent({ model, sessionDir });

      agent.testCreateTaskState("task-1", [
        { role: "user", content: "test" },
        { role: "assistant", content: "response" },
      ]);

      const overflowError = new Error("context window length exceeded maximum");

      // First MAX_OVERFLOW_COMPACT_RETRIES calls should return true
      for (let i = 0; i < MAX_OVERFLOW_COMPACT_RETRIES; i++) {
        const shouldRetry = await agent.testOnLLMError("task-1", overflowError);
        expect(shouldRetry).toBe(true);
      }

      // Next call should return false (exceeded limit)
      const shouldRetry = await agent.testOnLLMError("task-1", overflowError);
      expect(shouldRetry).toBe(false);
    }, 10000);
  });

  describe("_compactState uses mechanicalSummary when LLM summarize fails", () => {
    test("falls back to mechanical summary when LLM call throws", async () => {
      const sessionDir = await createTempDir();
      const generateMock = mock(async () => {
        throw new Error("LLM unavailable for summarization");
      });
      const model = createMockModel({ generate: generateMock });
      const agent = createTestAgent({ model, sessionDir });

      // Build enough messages to trigger compaction
      const messages = buildLargeMessages(20, 20000);
      const originalLength = messages.length;
      agent.testCreateTaskState("task-1", messages);

      // Trigger compaction via beforeLLMCall (messages exceed budget)
      await agent.testBeforeLLMCall("task-1");

      // After compaction with fallback, state should have compact summary
      const state = agent.getTaskStates().get("task-1")!;
      // Mechanical summary is stored as system message via sessionStore.compact()
      expect(state.messages.length).toBeLessThan(originalLength);
      // The first message should be the compact system message
      expect(state.messages[0]!.content).toContain("[Session compacted");
    }, 10000);
  });

  describe("mechanicalSummary produces correct output", () => {
    test("generates correct summary structure via _compactState fallback", async () => {
      const sessionDir = await createTempDir();
      const generateMock = mock(async () => {
        throw new Error("LLM unavailable");
      });
      const model = createMockModel({ generate: generateMock });
      const agent = createTestAgent({ model, sessionDir });

      // Create messages with specific content to verify mechanical summary
      const messages: Message[] = [
        { role: "user", content: "first user message" },
        { role: "assistant", content: "first response", toolCalls: [{ id: "tc1", name: "read_file", arguments: {} }] },
        { role: "tool", content: "file contents", toolCallId: "tc1" },
        { role: "user", content: "second user message" },
        { role: "assistant", content: "second response", toolCalls: [{ id: "tc2", name: "write_file", arguments: {} }] },
        { role: "tool", content: "done", toolCallId: "tc2" },
        { role: "user", content: "third user message" },
        { role: "assistant", content: "third response" },
        // Add more to reach >= 8 messages and exceed token budget
        ...buildLargeMessages(16, 20000),
      ];
      agent.testCreateTaskState("task-1", messages);

      await agent.testBeforeLLMCall("task-1");

      const state = agent.getTaskStates().get("task-1")!;
      const summary = state.messages[0]!.content;

      expect(summary).toContain("[Session compacted");
      expect(summary).toContain("messages archived");
      expect(summary).toContain("Recent user messages:");
      expect(summary).toContain("Tools used:");
      expect(summary).toContain("read_file");
      expect(summary).toContain("write_file");
      expect(summary).toContain("Total exchanges:");
    }, 10000);
  });
});
