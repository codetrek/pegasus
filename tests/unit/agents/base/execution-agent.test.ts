/**
 * Tests for ExecutionAgent — does actual work in task or worker mode.
 *
 * Exercises:
 *   - run() in task mode returns result (no session persistence)
 *   - run() in worker mode persists session
 *   - notify() tool is intercepted and calls onNotify callback
 *   - mode getter returns correct mode
 *   - buildSystemPrompt includes task description
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
      expect(result.error).toBe("LLM connection failed");
    });

    test("task mode does not persist session", async () => {
      const model = createMockModel();
      const sessionDir = await createTempDir();

      const agent = new ExecutionAgent(
        createTaskDeps({ model, sessionDir: undefined }),
      );
      const result = await agent.run();

      expect(result.success).toBe(true);
      // No session file should exist (no sessionDir provided in task mode)
      // Verify the sessionStore is null by checking no file created
      try {
        await readFile(path.join(sessionDir, "current.jsonl"), "utf-8");
        // If we get here, file exists — unexpected
        expect(true).toBe(false);
      } catch {
        // Expected: no session file
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

  describe("notify() tool is intercepted and calls onNotify callback", () => {
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
      const agent = new ExecutionAgent(
        createTaskDeps({ model, onNotify: notifyCb }),
      );

      const result = await agent.run();

      expect(result.success).toBe(true);
      expect(notifyCb).toHaveBeenCalledTimes(1);
      expect(notifyCb).toHaveBeenCalledWith("progress: 50%");
    });

    test("notify tool without callback executes normally (no intercept)", async () => {
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

      // No onNotify callback — notify tool should fall through to execute
      const agent = new ExecutionAgent(createTaskDeps({ model }));

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
});
