/**
 * Tool-Use Loop — the core execution engine replacing Thinker + Planner + Actor.
 *
 * Algorithm:
 *   1. Call LLM with system prompt + messages + tool definitions
 *   2. If LLM returns tool_calls:
 *      a. For each tool call → onToolCall() hook (intercept or execute)
 *      b. Append assistant message (with tool calls) + tool result messages
 *      c. Go to step 1
 *   3. If LLM returns no tool_calls (pure text) → loop complete
 *   4. If maxIterations reached → force stop
 *
 * This is a standalone function (not a class method) for testability and reuse.
 */

import type {
  LanguageModel,
  Message,
  GenerateTextResult,
} from "../../infra/llm-types.ts";
import type { ToolCall, ToolDefinition } from "../../models/tool.ts";
import type { ToolResult, ToolContext } from "../../tools/types.ts";
import type { ToolExecutor } from "../../tools/executor.ts";
import type { PendingWork } from "./agent-state.ts";

// ── Types ────────────────────────────────────────────

/**
 * How a tool call should be handled.
 *
 *   "execute"   — proceed with normal tool execution via ToolExecutor
 *   "skip"      — skip execution, inject the provided synthetic result
 *   "intercept" — subclass handled it, inject the provided result + optional pending work
 */
export type ToolCallInterceptResult =
  | { action: "execute" }
  | { action: "skip"; result: ToolCallResult }
  | { action: "intercept"; result: ToolCallResult; pendingWork?: PendingWork };

/**
 * A tool call result formatted for feeding back to the LLM.
 */
export interface ToolCallResult {
  toolCallId: string;
  content: string;
  images?: Array<{ id: string; mimeType: string }>;
}

/**
 * Options for running a tool-use loop.
 */
export interface ToolUseLoopOptions {
  /** LLM model to use. */
  model: LanguageModel;
  /** System prompt for LLM calls. */
  systemPrompt: string;
  /** Full conversation history (messages before this loop). */
  messages: Message[];
  /** New trigger message to append before first LLM call. */
  triggerMessage?: Message;
  /** Tool definitions to pass to LLM. Empty = no tools. */
  tools?: ToolDefinition[];
  /** Tool executor for running tools. */
  toolExecutor: ToolExecutor;
  /** Tool context for tool execution. */
  toolContext: ToolContext;
  /** Max LLM call iterations. Default: 25. */
  maxIterations?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /**
   * Hook called before each tool call is executed.
   * Subclasses intercept special tools (reply, spawn_task, etc.).
   * Default: execute all tools normally.
   */
  onToolCall?: (tc: ToolCall) => Promise<ToolCallInterceptResult>;
  /**
   * Hook called after each LLM call for usage tracking.
   */
  onLLMUsage?: (result: GenerateTextResult) => Promise<void>;
}

/**
 * Result of a complete tool-use loop execution.
 */
export interface ToolUseLoopResult {
  /** Final text output from the LLM (last response without tool calls). */
  text: string;
  /** Total number of LLM calls made. */
  llmCallCount: number;
  /** Total number of tool calls processed. */
  toolCallCount: number;
  /** How the loop ended. */
  finishReason: "complete" | "max_iterations" | "interrupted" | "error";
  /** Error message if finishReason is "error". */
  error?: string;
  /** New messages generated during this loop (for session persistence). */
  newMessages: Message[];
  /** Pending work dispatched during the loop (e.g., child agents). */
  pendingWork: PendingWork[];
}

// ── Core Loop ────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Execute a complete tool-use loop.
 *
 * This is the core engine that replaces the old Thinker → Planner → Actor pipeline.
 * The LLM's natural tool-use protocol drives the loop:
 *   - LLM returns tool_calls → execute → feed results back → LLM again
 *   - LLM returns no tool_calls → done
 */
export async function toolUseLoop(
  options: ToolUseLoopOptions,
): Promise<ToolUseLoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const onToolCall = options.onToolCall ?? defaultOnToolCall;
  const onLLMUsage = options.onLLMUsage;

  // Build the full message list for the LLM
  const allMessages = [...options.messages];
  const newMessages: Message[] = [];

  if (options.triggerMessage) {
    allMessages.push(options.triggerMessage);
    newMessages.push(options.triggerMessage);
  }

  const pendingWork: PendingWork[] = [];
  let llmCallCount = 0;
  let toolCallCount = 0;
  let lastText = "";

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check cancellation
      if (options.signal?.aborted) {
        return {
          text: lastText,
          llmCallCount,
          toolCallCount,
          finishReason: "interrupted",
          newMessages,
          pendingWork,
        };
      }

      // Step 1: Call LLM
      const result = await options.model.generate({
        system: options.systemPrompt,
        messages: allMessages,
        tools: options.tools?.length ? options.tools : undefined,
        toolChoice: options.tools?.length ? "auto" : undefined,
      });
      llmCallCount++;
      lastText = result.text;

      // Usage tracking hook
      if (onLLMUsage) {
        await onLLMUsage(result);
      }

      // Step 2: No tool calls → loop complete
      if (!result.toolCalls?.length) {
        if (result.text) {
          const assistantMsg: Message = { role: "assistant", content: result.text };
          allMessages.push(assistantMsg);
          newMessages.push(assistantMsg);
        }
        return {
          text: lastText,
          llmCallCount,
          toolCallCount,
          finishReason: "complete",
          newMessages,
          pendingWork,
        };
      }

      // Step 3: Process tool calls
      const assistantMsg: Message = {
        role: "assistant",
        content: result.text ?? "",
        toolCalls: result.toolCalls,
      };
      allMessages.push(assistantMsg);
      newMessages.push(assistantMsg);

      for (const tc of result.toolCalls) {
        toolCallCount++;

        // Hook: let caller intercept special tool calls
        const intercept = await onToolCall(tc);

        let toolMsg: Message;

        switch (intercept.action) {
          case "skip":
            toolMsg = toolCallResultToMessage(intercept.result);
            break;

          case "intercept":
            toolMsg = toolCallResultToMessage(intercept.result);
            if (intercept.pendingWork) {
              pendingWork.push(intercept.pendingWork);
            }
            break;

          case "execute": {
            const toolResult = await options.toolExecutor.execute(
              tc.name,
              tc.arguments,
              options.toolContext,
            );
            toolMsg = formatToolResult(tc.id, tc.name, toolResult);
            break;
          }
        }

        allMessages.push(toolMsg);
        newMessages.push(toolMsg);
      }
    }

    // Max iterations reached
    return {
      text: lastText,
      llmCallCount,
      toolCallCount,
      finishReason: "max_iterations",
      newMessages,
      pendingWork,
    };
  } catch (err) {
    return {
      text: lastText,
      llmCallCount,
      toolCallCount,
      finishReason: "error",
      error: err instanceof Error ? err.message : String(err),
      newMessages,
      pendingWork,
    };
  }
}

// ── Helpers ──────────────────────────────────────────

/** Default onToolCall: execute all tools normally. */
async function defaultOnToolCall(
  _tc: ToolCall,
): Promise<ToolCallInterceptResult> {
  return { action: "execute" };
}

/** Convert a ToolResult to a Message for feeding back to the LLM. */
export function formatToolResult(
  toolCallId: string,
  _toolName: string,
  result: ToolResult,
): Message {
  const content = result.success
    ? typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result)
    : `Error: ${result.error}`;

  const msg: Message = {
    role: "tool",
    content,
    toolCallId,
  };

  if (result.images?.length) {
    msg.images = result.images;
  }

  return msg;
}

/** Convert a ToolCallResult to a Message. */
function toolCallResultToMessage(result: ToolCallResult): Message {
  const msg: Message = {
    role: "tool",
    content: result.content,
    toolCallId: result.toolCallId,
  };
  if (result.images?.length) {
    msg.images = result.images;
  }
  return msg;
}
