/**
 * TaskExecutionState — per-task execution tracking for event-driven agents.
 *
 * Tracks messages, iteration count, tool collection, and abort state.
 * Replaces what was spread across TaskFSM + TaskContext in the old system.
 */

import type { Message } from "../../infra/llm-types.ts";
import type { ToolCallCollector } from "./tool-call-collector.ts";

export interface AgentExecutionState {
  /** Unique task identifier. */
  agentId: string;
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
  /** Last known prompt token count from API (promptTokens + cacheReadTokens). */
  lastPromptTokens: number;
  /** Telemetry: trace ID for the current processing chain. */
  traceId?: string;
  /** Telemetry: current active span ID for parent-child relationships. */
  currentSpanId?: string;
  /** Resolved when task finishes (for ConversationAgent await pattern). */
  onComplete?: () => void;
}

export interface CreateAgentStateOptions {
  maxIterations?: number;
  metadata?: Record<string, unknown>;
  onComplete?: () => void;
}

export function createTaskState(
  agentId: string,
  messages: Message[],
  opts?: CreateAgentStateOptions,
): AgentExecutionState {
  return {
    agentId,
    messages,
    iteration: 0,
    maxIterations: opts?.maxIterations ?? 25,
    activeCollector: null,
    aborted: false,
    startedAt: Date.now(),
    metadata: opts?.metadata ?? {},
    lastPromptTokens: 0,
    onComplete: opts?.onComplete,
  };
}
