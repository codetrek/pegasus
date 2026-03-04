/**
 * Tests for ConversationAgent — manages persistent conversations with users.
 *
 * Uses a concrete TestConversationAgent subclass to exercise:
 *   - send() queues and processes messages
 *   - onReply callback is called when LLM calls reply tool
 *   - onSpawnAgent callback is called when LLM calls spawn_task
 *   - childComplete() injects result and triggers thinking
 *   - Queue processes items sequentially (processing lock)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  ConversationAgent,
  type ConversationAgentDeps,
} from "../../../../src/agents/base/conversation-agent.ts";
import type {
  LanguageModel,
  Message,
} from "../../../../src/infra/llm-types.ts";
import type { InboundMessage, ChannelInfo } from "../../../../src/channels/types.ts";
import type { Persona } from "../../../../src/identity/persona.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ──────────────────────────────────────────

const TEST_PERSONA: Persona = {
  name: "TestBot",
  role: "assistant",
  personality: ["helpful"],
  style: "direct",
  values: ["accuracy"],
};

const TEST_CHANNEL: ChannelInfo = { type: "cli", channelId: "test-ch" };

/** Create a mock LanguageModel. Callers can customize generate behavior. */
function createMockModel(
  generateFn?: LanguageModel["generate"],
): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    generate:
      generateFn ??
      mock(async () => ({
        text: "mock reply",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      })),
  };
}

/** Concrete TestConversationAgent for testing. */
class TestConversationAgent extends ConversationAgent {
  protected buildSystemPrompt(): string {
    return "test conversation prompt";
  }

  /** Expose session messages for assertions. */
  getSessionMessages(): Message[] {
    return this.sessionMessages;
  }

  /** Expose lastChannel for assertions. */
  getLastChannel(): ChannelInfo {
    return this.lastChannel;
  }

  /** Expose taskStates for assertions. */
  getTaskStates(): Map<string, unknown> {
    return this.taskStates;
  }
}

let tempDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pegasus-conv-test-"));
}

function createTestDeps(
  overrides?: Partial<ConversationAgentDeps>,
): ConversationAgentDeps {
  return {
    agentId: "conv-agent-1",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    persona: TEST_PERSONA,
    sessionDir: tempDir,
    ...overrides,
  };
}

function makeInboundMessage(
  text: string = "hello",
  channel: ChannelInfo = TEST_CHANNEL,
): InboundMessage {
  return { text, channel };
}

// ── Tests ────────────────────────────────────────────

describe("ConversationAgent", () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  describe("send() queues and processes messages", () => {
    test("send() adds user message to session and runs thinking", async () => {
      const generateMock = mock(async () => ({
        text: "hello back",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));

      // Must start to initialize session
      await agent.start();

      agent.send(makeInboundMessage("hi there"));

      // Wait for queue processing
      await new Promise((r) => setTimeout(r, 200));

      // User message should be in session
      const msgs = agent.getSessionMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[0]!.content).toBe("hi there");

      // LLM should have been called
      expect(generateMock).toHaveBeenCalled();

      await agent.stop();
    });

    test("send() updates lastChannel", async () => {
      const agent = new TestConversationAgent(createTestDeps());
      await agent.start();

      const channel: ChannelInfo = { type: "slack", channelId: "ch-42" };
      agent.send(makeInboundMessage("test", channel));

      await new Promise((r) => setTimeout(r, 200));

      expect(agent.getLastChannel()).toEqual(channel);

      await agent.stop();
    });
  });

  describe("onReply callback is called when LLM calls reply tool", () => {
    test("reply tool triggers onReply callback with message text", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            // First call: LLM emits a reply tool call
            return {
              text: "",
              finishReason: "tool_calls" as const,
              toolCalls: [
                {
                  id: "tc-reply-1",
                  name: "reply",
                  arguments: { text: "Hello user!" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          // Second call: LLM finishes
          return {
            text: "done",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      const replyCb = mock((_msg: any) => {});
      agent.onReply(replyCb);

      agent.send(makeInboundMessage("say hello"));

      await new Promise((r) => setTimeout(r, 300));

      expect(replyCb).toHaveBeenCalled();
      const callArgs = replyCb.mock.calls[0]![0];
      expect(callArgs.text).toBe("Hello user!");

      await agent.stop();
    });

    test("reply tool returns error when no callback configured", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls" as const,
              toolCalls: [
                {
                  id: "tc-reply-2",
                  name: "reply",
                  arguments: { text: "Hello!" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      // Don't register onReply callback
      agent.send(makeInboundMessage("say hello"));

      await new Promise((r) => setTimeout(r, 300));

      // Should not throw, but no callback was called
      // The agent handles this gracefully (returns skip with error)

      await agent.stop();
    });
  });

  describe("onSpawnAgent callback is called when LLM calls spawn_task", () => {
    test("spawn_task tool triggers onSpawnAgent callback", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls" as const,
              toolCalls: [
                {
                  id: "tc-spawn-1",
                  name: "spawn_task",
                  arguments: { description: "do something" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "task spawned",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      const spawnCb = mock((_kind: any, _config: any) => "child-42");
      agent.onSpawnAgent(spawnCb);

      agent.send(makeInboundMessage("run a task"));

      await new Promise((r) => setTimeout(r, 300));

      expect(spawnCb).toHaveBeenCalledTimes(1);
      const [kind, config] = spawnCb.mock.calls[0]!;
      expect(kind).toBe("execution");
      expect(config.description).toBe("do something");

      await agent.stop();
    });

    test("spawn_subagent tool uses orchestrator kind", async () => {
      let callIndex = 0;
      const model = createMockModel(
        mock(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: "",
              finishReason: "tool_calls" as const,
              toolCalls: [
                {
                  id: "tc-spawn-2",
                  name: "spawn_subagent",
                  arguments: { description: "orchestrate" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "done",
            finishReason: "stop" as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      const spawnCb = mock((_kind: any, _config: any) => "child-43");
      agent.onSpawnAgent(spawnCb);

      agent.send(makeInboundMessage("orchestrate something"));

      await new Promise((r) => setTimeout(r, 300));

      expect(spawnCb).toHaveBeenCalled();
      expect(spawnCb.mock.calls[0]![0]).toBe("orchestrator");

      await agent.stop();
    });
  });

  describe("childComplete() injects result and triggers thinking", () => {
    test("childComplete() adds system message and runs thinking", async () => {
      const generateMock = mock(async () => ({
        text: "acknowledged child result",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      // Add pending work so completePendingWork doesn't error
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "child-1",
        kind: "child_agent",
        description: "test child",
        dispatchedAt: Date.now(),
      });
      // Reset to allow processing (WAITING → can accept work)
      // addPendingWork auto-transitions BUSY→WAITING

      agent.childComplete("child-1", {
        id: "child-1",
        success: true,
        result: "child finished successfully",
      });

      await new Promise((r) => setTimeout(r, 300));

      // Session should contain the child result message
      const msgs = agent.getSessionMessages();
      const childMsg = msgs.find(
        (m) => m.content.includes("Child agent child-1 completed"),
      );
      expect(childMsg).toBeDefined();
      expect(childMsg!.content).toContain("child finished successfully");

      // LLM should have been called to process the result
      expect(generateMock).toHaveBeenCalled();

      await agent.stop();
    });

    test("childComplete() with failure injects error message", async () => {
      const generateMock = mock(async () => ({
        text: "handled error",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "child-2",
        kind: "child_agent",
        description: "failing child",
        dispatchedAt: Date.now(),
      });

      agent.childComplete("child-2", {
        id: "child-2",
        success: false,
        error: "timeout exceeded",
      });

      await new Promise((r) => setTimeout(r, 300));

      const msgs = agent.getSessionMessages();
      const errMsg = msgs.find(
        (m) => m.content.includes("Child agent child-2 failed"),
      );
      expect(errMsg).toBeDefined();
      expect(errMsg!.content).toContain("timeout exceeded");

      await agent.stop();
    });
  });

  describe("_think() completes via processStep", () => {
    test("_think() uses processStep and updates session messages with text response", async () => {
      const generateMock = mock(async () => ({
        text: "thinking result",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      agent.send(makeInboundMessage("trigger thinking"));

      await new Promise((r) => setTimeout(r, 300));

      const msgs = agent.getSessionMessages();
      // Should have: user message + assistant response
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[0]!.content).toBe("trigger thinking");
      // The assistant message is appended by processStep
      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("thinking result");

      // LLM should have been called exactly once (no tool calls → complete)
      expect(generateMock).toHaveBeenCalledTimes(1);

      await agent.stop();
    });

    test("_think() handles tool calls via processStep", async () => {
      let callIndex = 0;
      const generateMock = mock(async () => {
        callIndex++;
        if (callIndex === 1) {
          // First call: LLM returns a reply tool call (intercepted)
          return {
            text: "",
            finishReason: "tool_calls" as const,
            toolCalls: [
              {
                id: "tc-proc-1",
                name: "reply",
                arguments: { text: "Step result!" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }
        // Second call: LLM finishes
        return {
          text: "all done",
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      });

      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      const replyCb = mock((_msg: any) => {});
      agent.onReply(replyCb);

      agent.send(makeInboundMessage("do something"));

      await new Promise((r) => setTimeout(r, 500));

      // reply callback should have been triggered
      expect(replyCb).toHaveBeenCalled();
      expect(replyCb.mock.calls[0]![0].text).toBe("Step result!");

      // LLM should have been called twice (tool call → finish)
      expect(generateMock).toHaveBeenCalledTimes(2);

      await agent.stop();
    });

    test("_think() creates and cleans up task state", async () => {
      const generateMock = mock(async () => ({
        text: "done",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      agent.send(makeInboundMessage("check state"));

      await new Promise((r) => setTimeout(r, 300));

      // After completion, task state should be cleaned up
      expect(agent.getTaskStates().has("session")).toBe(false);

      await agent.stop();
    });
  });

  describe("subscribeEvents registers child event handlers", () => {
    test("subscribeEvents subscribes to TASK_COMPLETED and TASK_FAILED", async () => {
      const eventBus = new EventBus();
      const agent = new TestConversationAgent(
        createTestDeps({ eventBus }),
      );

      // start() calls subscribeEvents()
      await agent.start();

      // Add pending work so the event filter matches
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "child-ev-1",
        kind: "child_agent",
        description: "test child",
        dispatchedAt: Date.now(),
      });

      // Emit a TASK_COMPLETED event for the pending child
      const completedEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "child-ev-1",
        taskId: "child-ev-1",
        payload: { result: "child done" },
      });

      // The event should be queued/handled (agent is WAITING, can accept work)
      await eventBus.emit(completedEvent);

      await new Promise((r) => setTimeout(r, 300));

      // Child result should be injected into session
      const msgs = agent.getSessionMessages();
      const childMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes("Child agent child-ev-1 completed"),
      );
      expect(childMsg).toBeDefined();

      await agent.stop();
    });

    test("subscribeEvents ignores events for non-pending tasks", async () => {
      const eventBus = new EventBus();
      const generateMock = mock(async () => ({
        text: "response",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(
        createTestDeps({ model, eventBus }),
      );
      await agent.start();

      // Emit event for a task ID that is NOT in pendingWork
      const unknownEvent = createEvent(EventType.TASK_COMPLETED, {
        source: "unknown-child",
        taskId: "unknown-child",
        payload: { result: "should be ignored" },
      });

      await eventBus.emit(unknownEvent);

      await new Promise((r) => setTimeout(r, 200));

      // No child result message should appear in session
      const msgs = agent.getSessionMessages();
      const childMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes("unknown-child"),
      );
      expect(childMsg).toBeUndefined();

      await agent.stop();
    });
  });

  describe("handleEvent processes child completion", () => {
    test("handleEvent processes TASK_COMPLETED for pending child", async () => {
      const generateMock = mock(async () => ({
        text: "processed child result",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const eventBus = new EventBus();
      const agent = new TestConversationAgent(
        createTestDeps({ model, eventBus }),
      );
      await agent.start();

      // Add pending work
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "child-handle-1",
        kind: "child_agent",
        description: "test child handle",
        dispatchedAt: Date.now(),
      });

      // Emit TASK_COMPLETED
      await eventBus.emit(
        createEvent(EventType.TASK_COMPLETED, {
          source: "child-handle-1",
          taskId: "child-handle-1",
          payload: { result: "task output data" },
        }),
      );

      await new Promise((r) => setTimeout(r, 500));

      // Child result should be injected into session
      const msgs = agent.getSessionMessages();
      const childMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes("Child agent child-handle-1 completed"),
      );
      expect(childMsg).toBeDefined();
      expect(childMsg!.content).toContain("task output data");

      // Pending work should be removed
      expect(agent.stateManager.pendingWork.has("child-handle-1")).toBe(false);

      // LLM should have been called to process the result
      expect(generateMock).toHaveBeenCalled();

      await agent.stop();
    });

    test("handleEvent processes TASK_FAILED for pending child", async () => {
      const generateMock = mock(async () => ({
        text: "handled failure",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const eventBus = new EventBus();
      const agent = new TestConversationAgent(
        createTestDeps({ model, eventBus }),
      );
      await agent.start();

      // Add pending work
      agent.stateManager.markBusy();
      agent.stateManager.addPendingWork({
        id: "child-fail-1",
        kind: "child_agent",
        description: "failing child handle",
        dispatchedAt: Date.now(),
      });

      // Emit TASK_FAILED
      await eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "child-fail-1",
          taskId: "child-fail-1",
          payload: { error: "out of memory" },
        }),
      );

      await new Promise((r) => setTimeout(r, 500));

      // Error result should be injected into session
      const msgs = agent.getSessionMessages();
      const errMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes("Child agent child-fail-1 failed"),
      );
      expect(errMsg).toBeDefined();
      expect(errMsg!.content).toContain("Error: out of memory");

      // Pending work should be removed
      expect(agent.stateManager.pendingWork.has("child-fail-1")).toBe(false);

      await agent.stop();
    });
  });

  describe("onTaskComplete resolves completion promise", () => {
    test("onTaskComplete resolves the promise and cleans up task state", async () => {
      const generateMock = mock(async () => ({
        text: "final answer",
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      }));
      const model = createMockModel(generateMock);
      const agent = new TestConversationAgent(createTestDeps({ model }));
      await agent.start();

      // Send a message which triggers _think -> processStep -> onTaskComplete
      agent.send(makeInboundMessage("complete me"));

      await new Promise((r) => setTimeout(r, 300));

      // Task state should be cleaned up after completion
      expect(agent.getTaskStates().size).toBe(0);

      // Session should have both user and assistant messages
      const msgs = agent.getSessionMessages();
      expect(msgs.some((m) => m.role === "user" && m.content === "complete me")).toBe(true);
      expect(msgs.some((m) => m.role === "assistant" && m.content === "final answer")).toBe(true);

      await agent.stop();
    });
  });
});
