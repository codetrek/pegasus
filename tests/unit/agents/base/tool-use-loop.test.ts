/**
 * Unit tests for toolUseLoop() — the core LLM tool-use execution engine.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  toolUseLoop,
  formatToolResult,
  type ToolUseLoopOptions,
  type ToolCallInterceptResult,
} from "../../../../src/agents/base/tool-use-loop.ts";
import type {
  LanguageModel,
  GenerateTextResult,
  Message,
} from "../../../../src/infra/llm-types.ts";
import type { ToolCall, ToolDefinition } from "../../../../src/models/tool.ts";
import type { ToolResult, ToolContext } from "../../../../src/tools/types.ts";
import type { ToolExecutor } from "../../../../src/tools/executor.ts";

// ── Helpers ──────────────────────────────────────────

/** Create a mock LanguageModel that returns preconfigured responses in order. */
function createMockModel(responses: GenerateTextResult[]): LanguageModel {
  let callIndex = 0;
  return {
    provider: "test",
    modelId: "test-model",
    generate: mock(async (): Promise<GenerateTextResult> => {
      if (callIndex >= responses.length) {
        throw new Error(`Mock model exhausted: no response at index ${callIndex}`);
      }
      return responses[callIndex++]!;
    }),
  };
}

/** Create a simple text-only LLM response (no tool calls). */
function textResponse(text: string): GenerateTextResult {
  return {
    text,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

/** Create an LLM response with tool calls. */
function toolCallResponse(
  text: string,
  toolCalls: ToolCall[],
): GenerateTextResult {
  return {
    text,
    finishReason: "tool_calls",
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

/** Create a mock ToolExecutor. */
function createMockExecutor(
  results?: Map<string, ToolResult>,
): ToolExecutor {
  const defaultResult: ToolResult = {
    success: true,
    result: "ok",
    startedAt: Date.now(),
    completedAt: Date.now(),
    durationMs: 1,
  };

  return {
    execute: mock(async (name: string, _params: unknown, _ctx: ToolContext) => {
      return results?.get(name) ?? defaultResult;
    }),
  } as unknown as ToolExecutor;
}

const defaultContext: ToolContext = { taskId: "test" };

const defaultTools: ToolDefinition[] = [
  { name: "read_file", description: "Read a file", parameters: { type: "object" } },
];

/** Build minimal ToolUseLoopOptions with overrides. */
function buildOptions(overrides: Partial<ToolUseLoopOptions>): ToolUseLoopOptions {
  return {
    model: createMockModel([textResponse("hello")]),
    systemPrompt: "You are a test assistant.",
    messages: [],
    tools: defaultTools,
    toolExecutor: createMockExecutor(),
    toolContext: defaultContext,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────

describe("toolUseLoop", () => {
  // 1. Simple completion — no tool calls
  it("returns final text when LLM returns no tool calls", async () => {
    const model = createMockModel([textResponse("Final answer")]);
    const result = await toolUseLoop(buildOptions({ model }));

    expect(result.text).toBe("Final answer");
    expect(result.finishReason).toBe("complete");
    expect(result.llmCallCount).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.pendingWork).toEqual([]);
    // newMessages should contain the assistant response
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]).toEqual({ role: "assistant", content: "Final answer" });
  });

  // 2. Tool call → execute → loop back → final text
  it("executes tools when LLM returns tool_calls and loops", async () => {
    const tc: ToolCall = { id: "tc-1", name: "read_file", arguments: { path: "/tmp/test" } };

    const model = createMockModel([
      toolCallResponse("Let me read that file.", [tc]),
      textResponse("The file contains hello."),
    ]);

    const executorResults = new Map<string, ToolResult>([
      ["read_file", { success: true, result: "hello", startedAt: 1, completedAt: 2, durationMs: 1 }],
    ]);
    const executor = createMockExecutor(executorResults);

    const result = await toolUseLoop(buildOptions({ model, toolExecutor: executor }));

    expect(result.finishReason).toBe("complete");
    expect(result.text).toBe("The file contains hello.");
    expect(result.llmCallCount).toBe(2);
    expect(result.toolCallCount).toBe(1);

    // Verify executor was called with correct arguments
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "read_file",
      { path: "/tmp/test" },
      defaultContext,
    ]);

    // newMessages: assistant (with toolCalls) + tool result + final assistant
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages[0]!.role).toBe("assistant");
    expect(result.newMessages[0]!.toolCalls).toEqual([tc]);
    expect(result.newMessages[1]!.role).toBe("tool");
    expect(result.newMessages[1]!.toolCallId).toBe("tc-1");
    expect(result.newMessages[2]!.role).toBe("assistant");
  });

  // 3. Max iterations limit
  it("stops after maxIterations", async () => {
    const tc: ToolCall = { id: "tc-loop", name: "read_file", arguments: {} };

    // Model always returns tool calls — should be stopped by maxIterations
    const neverEndingResponses = Array.from({ length: 5 }, () =>
      toolCallResponse("thinking...", [tc]),
    );
    const model = createMockModel(neverEndingResponses);

    const result = await toolUseLoop(buildOptions({
      model,
      maxIterations: 3,
    }));

    expect(result.finishReason).toBe("max_iterations");
    expect(result.llmCallCount).toBe(3);
    expect(result.toolCallCount).toBe(3);
  });

  // 4. LLM failure → finishReason "error"
  it('returns finishReason "error" on LLM failure', async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => {
        throw new Error("API rate limited");
      }),
    };

    const result = await toolUseLoop(buildOptions({ model }));

    expect(result.finishReason).toBe("error");
    expect(result.error).toBe("API rate limited");
    expect(result.llmCallCount).toBe(0);
    expect(result.toolCallCount).toBe(0);
  });

  // 5. AbortSignal — interrupted
  it("respects AbortSignal (interrupted)", async () => {
    const controller = new AbortController();
    // Abort immediately before the loop starts
    controller.abort();

    const model = createMockModel([textResponse("should not reach")]);

    const result = await toolUseLoop(buildOptions({
      model,
      signal: controller.signal,
    }));

    expect(result.finishReason).toBe("interrupted");
    expect(result.llmCallCount).toBe(0);
    // Model should never have been called
    expect(model.generate).not.toHaveBeenCalled();
  });

  // 6. onToolCall hook with "skip" action
  it('onToolCall hook with "skip" action skips execution', async () => {
    const tc: ToolCall = { id: "tc-skip", name: "dangerous_tool", arguments: {} };

    const model = createMockModel([
      toolCallResponse("", [tc]),
      textResponse("Done."),
    ]);

    const executor = createMockExecutor();

    const onToolCall = mock(async (_tc: ToolCall): Promise<ToolCallInterceptResult> => {
      return {
        action: "skip",
        result: { toolCallId: _tc.id, content: "Skipped: tool is disabled" },
      };
    });

    const result = await toolUseLoop(buildOptions({
      model,
      toolExecutor: executor,
      onToolCall,
    }));

    expect(result.finishReason).toBe("complete");
    expect(result.toolCallCount).toBe(1);
    // Executor should NOT have been called
    expect(executor.execute).not.toHaveBeenCalled();
    // The tool result message should contain the skip message
    const toolMsg = result.newMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("Skipped: tool is disabled");
    expect(toolMsg?.toolCallId).toBe("tc-skip");
  });

  // 7. onToolCall hook with "intercept" action + pendingWork
  it('onToolCall hook with "intercept" action returns custom result + pendingWork', async () => {
    const tc: ToolCall = { id: "tc-intercept", name: "spawn_child", arguments: { goal: "sub-task" } };

    const model = createMockModel([
      toolCallResponse("Spawning child agent.", [tc]),
      textResponse("Child dispatched."),
    ]);

    const executor = createMockExecutor();

    const onToolCall = mock(async (_tc: ToolCall): Promise<ToolCallInterceptResult> => {
      return {
        action: "intercept",
        result: { toolCallId: _tc.id, content: "Child agent spawned: child-1" },
        pendingWork: {
          id: "pw-1",
          kind: "child_agent",
          description: "sub-task execution",
          dispatchedAt: Date.now(),
        },
      };
    });

    const result = await toolUseLoop(buildOptions({
      model,
      toolExecutor: executor,
      onToolCall,
    }));

    expect(result.finishReason).toBe("complete");
    expect(result.pendingWork).toHaveLength(1);
    expect(result.pendingWork[0]!.id).toBe("pw-1");
    expect(result.pendingWork[0]!.kind).toBe("child_agent");
    // Executor should NOT have been called
    expect(executor.execute).not.toHaveBeenCalled();
  });

  // 8. onLLMUsage hook is called after each LLM call
  it("onLLMUsage hook is called after each LLM call", async () => {
    const tc: ToolCall = { id: "tc-usage", name: "read_file", arguments: {} };

    const model = createMockModel([
      toolCallResponse("step 1", [tc]),
      textResponse("step 2 done"),
    ]);

    const usageResults: GenerateTextResult[] = [];
    const onLLMUsage = mock(async (r: GenerateTextResult) => {
      usageResults.push(r);
    });

    const result = await toolUseLoop(buildOptions({
      model,
      onLLMUsage,
    }));

    expect(result.llmCallCount).toBe(2);
    expect(onLLMUsage).toHaveBeenCalledTimes(2);
    expect(usageResults[0]!.text).toBe("step 1");
    expect(usageResults[1]!.text).toBe("step 2 done");
  });

  // 9. Tool execution errors are returned as tool result messages (not thrown)
  it("tool execution errors are returned as tool result messages", async () => {
    const tc: ToolCall = { id: "tc-err", name: "failing_tool", arguments: {} };

    const model = createMockModel([
      toolCallResponse("trying...", [tc]),
      textResponse("Tool failed, moving on."),
    ]);

    const executorResults = new Map<string, ToolResult>([
      ["failing_tool", {
        success: false,
        error: "Permission denied",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      }],
    ]);
    const executor = createMockExecutor(executorResults);

    const result = await toolUseLoop(buildOptions({
      model,
      toolExecutor: executor,
    }));

    // Loop should complete (error is fed back to LLM, not thrown)
    expect(result.finishReason).toBe("complete");
    expect(result.llmCallCount).toBe(2);

    const toolMsg = result.newMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("Error: Permission denied");
    expect(toolMsg?.toolCallId).toBe("tc-err");
  });

  // Additional: triggerMessage is included in newMessages
  it("includes triggerMessage in newMessages", async () => {
    const trigger: Message = { role: "user", content: "Do something" };
    const model = createMockModel([textResponse("Done")]);

    const result = await toolUseLoop(buildOptions({
      model,
      triggerMessage: trigger,
    }));

    expect(result.newMessages[0]).toEqual(trigger);
    expect(result.newMessages).toHaveLength(2); // trigger + assistant
  });

  // Additional: empty text response does not add assistant message
  it("does not add assistant message when LLM returns empty text and no tool calls", async () => {
    const model = createMockModel([textResponse("")]);

    const result = await toolUseLoop(buildOptions({ model }));

    expect(result.finishReason).toBe("complete");
    expect(result.text).toBe("");
    // No assistant message should be added when text is empty
    expect(result.newMessages).toHaveLength(0);
  });

  // Additional: multiple tool calls in single response
  it("processes multiple tool calls in a single LLM response", async () => {
    const tcs: ToolCall[] = [
      { id: "tc-a", name: "read_file", arguments: { path: "a.txt" } },
      { id: "tc-b", name: "read_file", arguments: { path: "b.txt" } },
    ];

    const model = createMockModel([
      toolCallResponse("Reading two files.", tcs),
      textResponse("Both files read."),
    ]);

    const executor = createMockExecutor();

    const result = await toolUseLoop(buildOptions({
      model,
      toolExecutor: executor,
    }));

    expect(result.finishReason).toBe("complete");
    expect(result.toolCallCount).toBe(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);

    // Should have: assistant (with 2 tool calls) + 2 tool results + final assistant
    const toolMsgs = result.newMessages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]!.toolCallId).toBe("tc-a");
    expect(toolMsgs[1]!.toolCallId).toBe("tc-b");
  });

  // Additional: LLM error is caught as non-Error (string thrown)
  it("handles non-Error thrown values", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => {
        throw "string error";
      }),
    };

    const result = await toolUseLoop(buildOptions({ model }));

    expect(result.finishReason).toBe("error");
    expect(result.error).toBe("string error");
  });

  // Additional: AbortSignal mid-loop (abort between iterations)
  it("checks AbortSignal between iterations", async () => {
    const controller = new AbortController();
    const tc: ToolCall = { id: "tc-mid", name: "read_file", arguments: {} };

    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => {
        callCount++;
        // Abort after first LLM call so the check triggers before second call
        controller.abort();
        return toolCallResponse("working...", [tc]);
      }),
    };

    const result = await toolUseLoop(buildOptions({
      model,
      signal: controller.signal,
    }));

    expect(result.finishReason).toBe("interrupted");
    expect(callCount).toBe(1);
    expect(result.llmCallCount).toBe(1);
  });
});

describe("formatToolResult", () => {
  // 10. formatToolResult helper function
  it("formats a successful string result", () => {
    const toolResult: ToolResult = {
      success: true,
      result: "file content here",
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    const msg = formatToolResult("tc-1", "read_file", toolResult);

    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("tc-1");
    expect(msg.content).toBe("file content here");
    expect(msg.images).toBeUndefined();
  });

  it("formats a successful object result as JSON", () => {
    const toolResult: ToolResult = {
      success: true,
      result: { lines: 42, path: "/tmp/test" },
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    const msg = formatToolResult("tc-2", "read_file", toolResult);

    expect(msg.role).toBe("tool");
    expect(msg.content).toBe(JSON.stringify({ lines: 42, path: "/tmp/test" }));
  });

  it("formats an error result with Error prefix", () => {
    const toolResult: ToolResult = {
      success: false,
      error: "File not found",
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    const msg = formatToolResult("tc-3", "read_file", toolResult);

    expect(msg.role).toBe("tool");
    expect(msg.content).toBe("Error: File not found");
  });

  it("includes images when present", () => {
    const toolResult: ToolResult = {
      success: true,
      result: "screenshot taken",
      images: [{ id: "img-1", mimeType: "image/png" }],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    const msg = formatToolResult("tc-4", "screenshot", toolResult);

    expect(msg.images).toEqual([{ id: "img-1", mimeType: "image/png" }]);
  });

  it("does not include images when array is empty", () => {
    const toolResult: ToolResult = {
      success: true,
      result: "done",
      images: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };

    const msg = formatToolResult("tc-5", "some_tool", toolResult);

    // Empty array is falsy for .length, so images should not be set
    expect(msg.images).toBeUndefined();
  });
});
