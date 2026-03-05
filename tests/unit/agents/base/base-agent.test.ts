/**
 * Tests for BaseAgent — abstract base class for all Pegasus agents.
 *
 * Uses a concrete TestAgent subclass to exercise:
 *   - Constructor wiring (agentId, model, toolRegistry)
 *   - Lifecycle (start/stop, isRunning)
 *   - State manager accessibility
 *   - Event queue (immediate processing, queuing when BUSY, drain on complete)
 *   - processStep event-driven engine (non-blocking tool dispatch, task completion)
 */

import { describe, test, expect, mock } from "bun:test";
import { BaseAgent, type BaseAgentDeps } from "../../../../src/agents/base/base-agent.ts";
import { AgentState } from "../../../../src/agents/base/agent-state.ts";
import type { Event } from "../../../../src/events/types.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import type { LanguageModel, Message } from "../../../../src/infra/llm-types.ts";
import type { TaskExecutionState, CreateTaskStateOptions } from "../../../../src/agents/base/task-execution-state.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";
import { z } from "zod";

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

/** Concrete TestAgent for testing BaseAgent's behavior. */
class TestAgent extends BaseAgent {
  public handleEventMock = mock(async (_event: Event) => {});
  public subscribeEventsMock = mock(() => {});
  public onTaskCompleteMock = mock(
    async (_taskId: string, _text: string, _reason: string) => {},
  );

  protected buildSystemPrompt(_taskId?: string): string {
    return "test prompt";
  }

  protected subscribeEvents(): void {
    this.subscribeEventsMock();
  }

  protected async handleEvent(event: Event): Promise<void> {
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
}

function createTestAgent(overrides?: Partial<BaseAgentDeps>): TestAgent {
  return new TestAgent({
    agentId: "test-agent-1",
    model: createMockModel(),
    toolRegistry: createMockRegistry(),
    ...overrides,
  });
}

function makeEvent(type: number = EventType.MESSAGE_RECEIVED): Event {
  return createEvent(type as any, { source: "test" });
}

// ── Tests ────────────────────────────────────────────

describe("BaseAgent", () => {
  describe("constructor", () => {
    test("sets agentId, model, toolRegistry", () => {
      const model = createMockModel();
      const registry = createMockRegistry();
      const agent = new TestAgent({
        agentId: "my-agent",
        model,
        toolRegistry: registry,
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
      });

      // Should not throw — error is caught and logged
      agent.testQueueEvent(makeEvent());
      await new Promise((r) => setTimeout(r, 50));
      // No assertion needed — just verify no uncaught exception
    });
  });

  describe("default getTools and onToolCall", () => {
    test("getTools returns toLLMTools from registry", () => {
      const registry = createMockRegistry();
      const agent = createTestAgent({ toolRegistry: registry });
      const tools = (agent as any).getTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(0); // empty registry
    });

    test("default onToolCall returns execute action", async () => {
      const agent = createTestAgent();
      const result = await (agent as any).onToolCall({ id: "tc-1", name: "some_tool", arguments: {} });
      expect(result).toEqual({ action: "execute" });
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
      await new Promise((r) => setTimeout(r, 200));

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

      // Agent that skips all tool calls
      class SkipToolAgent extends TestAgent {
        protected override async onToolCall(tc: any) {
          return {
            action: "skip" as const,
            result: {
              toolCallId: tc.id,
              content: JSON.stringify({ ok: true }),
            },
          };
        }
      }
      const agent = new SkipToolAgent({
        agentId: "test-agent-1",
        model,
        toolRegistry: createMockRegistry(),
        eventBus: bus,
      });
      agent.testCreateTaskState("task-1", [{ role: "user", content: "hi" }]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 200));

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

      // Skip all tool calls (simulate instant execution)
      class ParallelToolAgent extends TestAgent {
        protected override async onToolCall(tc: any) {
          return {
            action: "skip" as const,
            result: {
              toolCallId: tc.id,
              content: JSON.stringify({ result: `${tc.name}_done` }),
            },
          };
        }
      }

      const agent = new ParallelToolAgent({
        agentId: "test-agent-1",
        model,
        toolRegistry: createMockRegistry(),
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "run two tools" },
      ]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 200));

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

      class AbortDuringToolAgent extends TestAgent {
        protected override async onToolCall(tc: any) {
          // Set aborted flag during tool execution
          const state = this.getTaskStates().get("task-1");
          if (state) state.aborted = true;

          return {
            action: "skip" as const,
            result: {
              toolCallId: tc.id,
              content: JSON.stringify({ done: true }),
            },
          };
        }
      }

      const agent = new AbortDuringToolAgent({
        agentId: "test-agent-1",
        model,
        toolRegistry: createMockRegistry(),
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "start" },
      ]);

      await agent.testProcessStep("task-1");
      await new Promise((r) => setTimeout(r, 200));

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

      // Skip all tool calls (simulate instant execution)
      class MultiIterAgent extends TestAgent {
        protected override async onToolCall(tc: any) {
          return {
            action: "skip" as const,
            result: {
              toolCallId: tc.id,
              content: JSON.stringify({ result: `${tc.name}_result` }),
            },
          };
        }
      }

      const agent = new MultiIterAgent({
        agentId: "test-agent-1",
        model,
        toolRegistry: createMockRegistry(),
      });
      agent.testCreateTaskState("task-1", [
        { role: "user", content: "do a 3-step task" },
      ]);

      await agent.testProcessStep("task-1");
      // Wait for async tool execution chains to complete
      await new Promise((r) => setTimeout(r, 500));

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

      // Create an agent that lets tool calls go through to execute,
      // but the toolExecutor will throw
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
      await new Promise((r) => setTimeout(r, 500));

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
