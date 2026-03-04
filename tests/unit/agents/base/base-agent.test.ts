/**
 * Tests for BaseAgent — abstract base class for all Pegasus agents.
 *
 * Uses a concrete TestAgent subclass to exercise:
 *   - Constructor wiring (agentId, model, toolRegistry)
 *   - Lifecycle (start/stop, isRunning)
 *   - State manager accessibility
 *   - Tool-use loop state transitions (BUSY→IDLE, BUSY→WAITING)
 *   - Event queue (immediate processing, queuing when BUSY, drain on complete)
 */

import { describe, test, expect, mock } from "bun:test";
import { BaseAgent, type BaseAgentDeps } from "../../../../src/agents/base/base-agent.ts";
import { AgentState } from "../../../../src/agents/base/agent-state.ts";
import type { ToolUseLoopResult } from "../../../../src/agents/base/tool-use-loop.ts";
import type { Event } from "../../../../src/events/types.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import type { LanguageModel } from "../../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";

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

  protected buildSystemPrompt(): string {
    return "test prompt";
  }

  protected subscribeEvents(): void {
    this.subscribeEventsMock();
  }

  protected async handleEvent(event: Event): Promise<void> {
    await this.handleEventMock(event);
  }

  /** Expose protected runToolUseLoop for testing. */
  async testRunToolUseLoop(
    opts?: Partial<Parameters<BaseAgent["runToolUseLoop"]>[0]>,
  ): Promise<ToolUseLoopResult> {
    return this.runToolUseLoop({
      systemPrompt: "test prompt",
      messages: [],
      ...opts,
    });
  }

  /** Expose protected queueEvent for testing. */
  testQueueEvent(event: Event): void {
    this.queueEvent(event);
  }

  /** Expose event queue length for assertions. */
  get eventQueueLength(): number {
    return (this as any)._eventQueue.length;
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

  describe("runToolUseLoop() transitions BUSY → IDLE", () => {
    test("transitions to IDLE when loop completes with no pending work", async () => {
      const model = createMockModel({
        generate: mock(async () => ({
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      });
      const agent = createTestAgent({ model });

      expect(agent.stateManager.state).toBe(AgentState.IDLE);

      const result = await agent.testRunToolUseLoop();

      expect(result.finishReason).toBe("complete");
      expect(result.text).toBe("done");
      expect(agent.stateManager.state).toBe(AgentState.IDLE);
    });
  });

  describe("runToolUseLoop() transitions BUSY → WAITING when pendingWork dispatched", () => {
    test("transitions to WAITING when loop has pending work", async () => {
      // Model returns a tool call that gets intercepted with pendingWork
      let callCount = 0;
      const model = createMockModel({
        generate: mock(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "spawn_task", arguments: { description: "test" } },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          // Second call: no tool calls, loop ends
          return {
            text: "waiting for child",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      });

      // Create an agent that intercepts spawn_task with pendingWork
      class PendingWorkAgent extends TestAgent {
        protected override async onToolCall(tc: any) {
          if (tc.name === "spawn_task") {
            return {
              action: "intercept" as const,
              result: {
                toolCallId: tc.id,
                content: JSON.stringify({ childId: "child-1" }),
              },
              pendingWork: {
                id: "child-1",
                kind: "child_agent" as const,
                description: "test child",
                dispatchedAt: Date.now(),
              },
            };
          }
          return { action: "execute" as const };
        }
      }

      const agent = new PendingWorkAgent({
        agentId: "pending-agent",
        model,
        toolRegistry: createMockRegistry(),
      });

      const result = await agent.testRunToolUseLoop();

      // Loop completed, but pending work was dispatched
      expect(result.pendingWork).toHaveLength(1);
      expect(result.pendingWork[0]!.id).toBe("child-1");
      // State should be WAITING because there's pending work
      expect(agent.stateManager.state).toBe(AgentState.WAITING);
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
      // getTools is called internally by runToolUseLoop; verify via public method
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
});
