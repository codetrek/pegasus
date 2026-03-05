/**
 * TaskExecutionState — per-task execution tracking for event-driven agents.
 *
 * Tracks messages, iteration count, tool collection, and abort state.
 * Replaces what was spread across TaskFSM + TaskContext in the old system.
 */

import type { Message } from "../../infra/llm-types.ts";
import type { ToolCallCollector } from "./tool-call-collector.ts";

export interface TaskExecutionState {
  /** Unique task identifier. */
  taskId: string;
  /** Full message history for LLM calls. */
  messages: Message[];
  /** Current iteration count (number of LLM calls made). */
  iteration: number;
  /** Maximum iterations before forced stop. */
  maxIterations: number;
  /** Active tool call collector, if tools are executing. */
  activeCollector: ToolCallCollector | null;
  /** Set by TASK_SUSPENDED handler to stop execution. */
  aborted: boolean;
  /** Timestamp when execution started. */
  startedAt: number;
  /** Metadata from task creation. */
  metadata: Record<string, unknown>;
  /** Resolved when task finishes (for ConversationAgent await pattern). */
  onComplete?: () => void;
}

export interface CreateTaskStateOptions {
  maxIterations?: number;
  metadata?: Record<string, unknown>;
  onComplete?: () => void;
}

export function createTaskState(
  taskId: string,
  messages: Message[],
  opts?: CreateTaskStateOptions,
): TaskExecutionState {
  return {
    taskId,
    messages,
    iteration: 0,
    maxIterations: opts?.maxIterations ?? 25,
    activeCollector: null,
    aborted: false,
    startedAt: Date.now(),
    metadata: opts?.metadata ?? {},
    onComplete: opts?.onComplete,
  };
}
