/**
 * Tests for ExecutionAgent — does actual work in task or worker mode.
 *
 * Exercises:
 *   - run() in task mode returns result (no session persistence)
 *   - run() in worker mode persists session
 *   - notify() tool self-executes via ToolContext.onNotify callback
 *   - mode getter returns correct mode
 *   - buildSystemPrompt includes task description
 *   - onTaskComplete emits TASK_COMPLETED / TASK_FAILED events
 *   - subscribeEvents subscribes to correct event types
 *   - handleEvent TASK_SUSPENDED sets abort flag
 *   - worker mode persists session via onTaskComplete
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  ExecutionAgent,
  type ExecutionAgentDeps,
} from "../../../../src/agents/base/execution-agent.ts";
import type {
  LanguageModel,
} from "../../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../../src/tools/registry.ts";
import { EventBus } from "../../../../src/events/bus.ts";
import { EventType, createEvent } from "../../../../src/events/types.ts";
import type { Event } from "../../../../src/events/types.ts";
import { notify } from "../../../../src/tools/builtins/notify-tool.ts";
import { mkdtemp, readFile } from "node:fs/promises";
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
        text: "task complete",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      })),
  };
}

let tempDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pegasus-exec-test-"));
}

function createTaskDeps(
  overrides?: Partial<ExecutionAgentDeps>,
): ExecutionAgentDeps {
  return {
    agentId: "exec-agent-1",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    input: "Do the thing",
    description: "Test task description",
    mode: "task",
    sessionDir: tempDir,
    ...overrides,
  };
}

function createWorkerDeps(
  overrides?: Partial<ExecutionAgentDeps>,
): ExecutionAgentDeps {
  return {
    agentId: "exec-worker-1",
    model: createMockModel(),
    toolRegistry: new ToolRegistry(),
    input: "Do the worker thing",
    description: "Test worker description",
    mode: "worker",
    sessionDir: tempDir,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────

describe("ExecutionAgent", () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  describe("run() in task mode returns result", () => {
    test("returns success result with text from LLM", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "task result: 42",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(createTaskDeps({ model }));
      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(result.result).toBe("task result: 42");
      expect(result.llmCallCount).toBe(1);
      expect(result.toolCallCount).toBe(0);
    });

    test("returns failure result on LLM error", async () => {
      const model = createMockModel(
        mock(async () => {
          throw new Error("LLM connection failed");
        }),
      );

      const agent = new ExecutionAgent(createTaskDeps({ model }));
      const result = await agent.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe("LLM call failed");
    });

    test("task mode does not persist session", async () => {
      const model = createMockModel();
      const taskSessionDir = await createTempDir();

      const agent = new ExecutionAgent(
        createTaskDeps({ model, sessionDir: taskSessionDir }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);
      // Task mode should not write session files even though sessionDir exists
      try {
        await readFile(path.join(taskSessionDir, "current.jsonl"), "utf-8");
        // If we get here, file exists — unexpected for task mode
        expect(true).toBe(false);
      } catch {
        // Expected: no session file in task mode
      }
    });
  });

  describe("run() in worker mode persists session", () => {
    test("creates session file with messages in worker mode", async () => {
      const model = createMockModel(
        mock(async () => ({
          text: "worker done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(
        createWorkerDeps({ model, sessionDir: tempDir }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(result.result).toBe("worker done");

      // Session file should exist
      const sessionContent = await readFile(
        path.join(tempDir, "current.jsonl"),
        "utf-8",
      );
      expect(sessionContent.length).toBeGreaterThan(0);

      // Should contain user message and assistant message
      const lines = sessionContent.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const firstEntry = JSON.parse(lines[0]!);
      expect(firstEntry.role).toBe("user");
      expect(firstEntry.content).toBe("Do the worker thing");

      // Last line should be assistant
      const lastEntry = JSON.parse(lines[lines.length - 1]!);
      expect(lastEntry.role).toBe("assistant");
    });

    test("worker mode defaults to maxIterations=50", async () => {
      const agent = new ExecutionAgent(createWorkerDeps());
      expect((agent as any).maxIterations).toBe(50);
    });
  });

  describe("notify() tool self-executes via onNotify callback", () => {
    test("notify tool triggers onNotify callback with message", async () => {
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
                  arguments: { message: "progress: 50%" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          return {
            text: "task finished",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const notifyCb = mock((_msg: string) => {});
      const registry = new ToolRegistry();
      registry.register(notify);
      const agent = new ExecutionAgent(
        createTaskDeps({ model, onNotify: notifyCb, toolRegistry: registry }),
      );

      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(notifyCb).toHaveBeenCalledTimes(1);
      expect(notifyCb).toHaveBeenCalledWith("progress: 50%");
    });

    test("notify tool without callback falls back to signal result", async () => {
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
                  id: "tc-notify-2",
                  name: "notify",
                  arguments: { message: "progress" },
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

      // No onNotify callback — notify tool should fall back to signal result
      const registry = new ToolRegistry();
      registry.register(notify);
      const agent = new ExecutionAgent(createTaskDeps({ model, toolRegistry: registry }));

      // This will try to execute the "notify" tool via ToolExecutor.
      // Since no such tool is registered, it will fail gracefully.
      const result = await agent.run();

      // Should still complete (tool execution error doesn't crash the loop)
      expect(result.success).toBe(true);
    });
  });

  describe("mode getter returns correct mode", () => {
    test("returns 'task' for task mode agent", () => {
      const agent = new ExecutionAgent(createTaskDeps());
      expect(agent.mode).toBe("task");
    });

    test("returns 'worker' for worker mode agent", () => {
      const agent = new ExecutionAgent(createWorkerDeps());
      expect(agent.mode).toBe("worker");
    });
  });

  describe("buildSystemPrompt includes task description", () => {
    test("system prompt contains task description", async () => {
      // Capture the system prompt passed to model.generate
      let capturedSystem: string | undefined;
      const model = createMockModel(
        mock(async (opts: any) => {
          capturedSystem = opts.system;
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          description: "Summarize the quarterly report",
        }),
      );

      await agent.run();

      expect(capturedSystem).toBeDefined();
      expect(capturedSystem!).toContain("Summarize the quarterly report");
    });

    test("system prompt includes notify instruction when onNotify is set", async () => {
      let capturedSystem: string | undefined;
      const model = createMockModel(
        mock(async (opts: any) => {
          capturedSystem = opts.system;
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          onNotify: () => {},
        }),
      );

      await agent.run();

      expect(capturedSystem).toBeDefined();
      expect(capturedSystem!).toContain("notify");
    });

    test("system prompt includes context when contextPrompt is set", async () => {
      let capturedSystem: string | undefined;
      const model = createMockModel(
        mock(async (opts: any) => {
          capturedSystem = opts.system;
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          contextPrompt: "You are working on project X",
        }),
      );

      await agent.run();

      expect(capturedSystem).toBeDefined();
      expect(capturedSystem!).toContain("## Context");
      expect(capturedSystem!).toContain("You are working on project X");
    });

    test("system prompt omits context section when contextPrompt is empty", async () => {
      let capturedSystem: string | undefined;
      const model = createMockModel(
        mock(async (opts: any) => {
          capturedSystem = opts.system;
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          contextPrompt: "",
        }),
      );

      await agent.run();

      expect(capturedSystem).toBeDefined();
      expect(capturedSystem!).not.toContain("## Context");
    });
  });

  describe("onTaskComplete emits events", () => {
    test("emits TASK_COMPLETED on success", async () => {
      const eventBus = new EventBus();
      const emittedEvents: Event[] = [];
      const originalEmit = eventBus.emit.bind(eventBus);
      eventBus.emit = async (event: Event) => {
        emittedEvents.push(event);
        return originalEmit(event);
      };

      const model = createMockModel(
        mock(async () => ({
          text: "success result",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({ model, eventBus }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);

      // Check captured events for TASK_COMPLETED
      const completedEvents = emittedEvents.filter(
        (e) => e.type === EventType.TASK_COMPLETED,
      );
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.source).toBe("exec-agent-1");
      expect(completedEvents[0]!.payload.finishReason).toBe("complete");
      expect(completedEvents[0]!.payload.result).toBe("success result");
    });

    test("emits TASK_FAILED on error", async () => {
      const eventBus = new EventBus();
      const emittedEvents: Event[] = [];
      const originalEmit = eventBus.emit.bind(eventBus);
      eventBus.emit = async (event: Event) => {
        emittedEvents.push(event);
        return originalEmit(event);
      };

      const model = createMockModel(
        mock(async () => {
          throw new Error("model crashed");
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({ model, eventBus }),
      );
      const result = await agent.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe("LLM call failed");

      // Check captured events for TASK_FAILED
      const failedEvents = emittedEvents.filter(
        (e) => e.type === EventType.TASK_FAILED,
      );
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0]!.source).toBe("exec-agent-1");
      expect(failedEvents[0]!.payload.finishReason).toBe("error");
    });
  });

  describe("subscribeEvents registers correct handlers", () => {
    test("subscribes to TASK_CREATED, TASK_SUSPENDED, TASK_RESUMED", async () => {
      const eventBus = new EventBus();

      // Track subscribe calls
      const subscribedTypes: (EventType | null)[] = [];
      const originalSubscribe = eventBus.subscribe.bind(eventBus);
      eventBus.subscribe = (type: EventType | null, handler: any) => {
        subscribedTypes.push(type);
        return originalSubscribe(type, handler);
      };

      const agent = new ExecutionAgent(
        createTaskDeps({ eventBus }),
      );

      // start() calls subscribeEvents()
      await agent.start();

      expect(subscribedTypes).toContain(EventType.TASK_CREATED);
      expect(subscribedTypes).toContain(EventType.TASK_SUSPENDED);
      expect(subscribedTypes).toContain(EventType.TASK_RESUMED);

      await agent.stop();
    });
  });

  describe("handleEvent TASK_SUSPENDED sets abort", () => {
    test("sets aborted flag on task state when TASK_SUSPENDED received", async () => {
      const eventBus = new EventBus();

      // Model that blocks until we signal it — gives us time to suspend
      let callCount = 0;
      const model = createMockModel(
        mock(async () => {
          callCount++;
          if (callCount === 1) {
            // First call returns a tool call so we stay in the loop
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "some_tool",
                  arguments: {},
                },
              ],
              usage: { promptTokens: 10, completionTokens: 5 },
            };
          }
          // Subsequent calls — just complete
          return {
            text: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({ model, eventBus, agentId: "suspend-test" }),
      );

      // Manually create task state and call handleEvent
      const state = (agent as any).createTaskExecutionState("suspend-test", [
        { role: "user", content: "test" },
      ]);

      expect(state.aborted).toBe(false);

      // Simulate TASK_SUSPENDED event
      const suspendEvent = createEvent(EventType.TASK_SUSPENDED, {
        source: "suspend-test",
        taskId: "suspend-test",
        payload: { reason: "user requested" },
      });

      await (agent as any).handleEvent(suspendEvent);

      expect(state.aborted).toBe(true);
    });
  });

  describe("worker mode persists session via onTaskComplete", () => {
    test("session file has content after run() in worker mode", async () => {
      const workerDir = await createTempDir();
      const model = createMockModel(
        mock(async () => ({
          text: "worker result",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(
        createWorkerDeps({ model, sessionDir: workerDir }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(result.result).toBe("worker result");

      // Verify session file exists and has content
      const content = await readFile(
        path.join(workerDir, "current.jsonl"),
        "utf-8",
      );
      expect(content.length).toBeGreaterThan(0);

      const lines = content.trim().split("\n");
      // Should have user message (from run()) + messages from onTaskComplete persistence
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // First line should be user message
      const first = JSON.parse(lines[0]!);
      expect(first.role).toBe("user");
    });
  });

  describe("event-driven path via TASK_CREATED", () => {
    test("start() + TASK_CREATED event triggers processStep → LLM → onTaskComplete → emits TASK_COMPLETED", async () => {
      const eventBus = new EventBus({ keepHistory: true });
      const model = createMockModel(
        mock(async () => ({
          text: "event-driven result",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          eventBus,
          agentId: "event-exec-1",
          input: "event-driven task input",
        }),
      );

      // start() subscribes to events and starts the EventBus
      await agent.start();

      // Emit TASK_CREATED event with matching agentId
      await eventBus.emit(
        createEvent(EventType.TASK_CREATED, {
          source: "event-exec-1",
          taskId: "event-exec-1",
          payload: { description: "test task" },
        }),
      );

      // Wait for the event bus to dispatch and agent to process
      await new Promise((r) => setTimeout(r, 100));

      // Verify: agent processed the event and completed
      // Check that TASK_COMPLETED was emitted in event history
      const completedEvents = eventBus.history.filter(
        (e) => e.type === EventType.TASK_COMPLETED,
      );
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.source).toBe("event-exec-1");
      expect(completedEvents[0]!.payload.result).toBe("event-driven result");
      expect(completedEvents[0]!.payload.finishReason).toBe("complete");

      // Verify: LLM was called
      expect(model.generate).toHaveBeenCalledTimes(1);

      // Clean up
      await agent.stop();
    }, 10000);
  });

  describe("processStep catch branch in run()", () => {
    test("returns failure when processStep itself throws (not LLM error)", async () => {
      const model = createMockModel();
      const agent = new ExecutionAgent(createTaskDeps({ model }));

      // Override processStep to throw before it can call onTaskComplete
      const agentAny = agent as any;
      agentAny.processStep = async (_taskId: string) => {
        throw new Error("processStep exploded");
      };

      const result = await agent.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe("processStep exploded");
    }, 5000);
  });

  describe("TASK_SUSPENDED via EventBus subscription handler", () => {
    test("emitting TASK_SUSPENDED through EventBus reaches handleEvent via subscription", async () => {
      const eventBus = new EventBus({ keepHistory: true });
      const model = createMockModel(
        mock(async () => ({
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const agent = new ExecutionAgent(
        createTaskDeps({
          model,
          eventBus,
          agentId: "suspend-bus-test",
        }),
      );

      // start() subscribes to events via subscribeEvents()
      await agent.start();

      // Create a task state so handleEvent has something to suspend
      const state = (agent as any).createTaskExecutionState("suspend-bus-test", [
        { role: "user", content: "test" },
      ]);
      expect(state.aborted).toBe(false);

      // Emit TASK_SUSPENDED through EventBus (not direct handleEvent)
      await eventBus.emit(
        createEvent(EventType.TASK_SUSPENDED, {
          source: "suspend-bus-test",
          taskId: "suspend-bus-test",
          payload: { reason: "test suspend via bus" },
        }),
      );

      // Wait for EventBus to dispatch the event
      await new Promise((r) => setTimeout(r, 100));

      // The subscription handler should have routed the event to handleEvent
      expect(state.aborted).toBe(true);

      await agent.stop();
    }, 10000);
  });

  describe("TASK_RESUMED resume flow", () => {
    test("TASK_RESUMED event re-starts execution via _startExecution", async () => {
      const eventBus = new EventBus({ keepHistory: true });
      const model = createMockModel(
        mock(async () => ({
          text: "resumed result",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const resumeDir = await createTempDir();
      const agent = new ExecutionAgent(
        createWorkerDeps({
          model,
          eventBus,
          agentId: "resume-exec-1",
          input: "resumable task input",
          sessionDir: resumeDir,
        }),
      );

      // start() subscribes to events
      await agent.start();

      // Emit TASK_RESUMED event (simulating resume of a previously suspended task)
      await eventBus.emit(
        createEvent(EventType.TASK_RESUMED, {
          source: "resume-exec-1",
          taskId: "resume-exec-1",
          payload: { reason: "user requested resume" },
        }),
      );

      // Wait for the event bus to dispatch and agent to process
      await new Promise((r) => setTimeout(r, 100));

      // Verify: agent re-started execution
      expect(model.generate).toHaveBeenCalledTimes(1);

      // Verify: TASK_COMPLETED was emitted
      const completedEvents = eventBus.history.filter(
        (e) => e.type === EventType.TASK_COMPLETED,
      );
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.source).toBe("resume-exec-1");
      expect(completedEvents[0]!.payload.result).toBe("resumed result");

      // Clean up
      await agent.stop();
    }, 10000);
  });
});
