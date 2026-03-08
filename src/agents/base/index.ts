/**
 * Base agent module — shared infrastructure for Pegasus agents.
 *
 * Exports:
 *   - AgentState, AgentStateManager — 3-state model (IDLE/BUSY/WAITING)
 *   - ToolCallCollector — parallel tool execution coordinator
 *   - TaskExecutionState — per-task state tracking
 *   - Agent — unified concrete agent (conversation + execution)
 */

// State model
export {
  AgentState,
  AgentStateManager,
  type PendingWork,
  type PendingWorkResult,
} from "./agent-state.ts";

// Tool call coordination
export {
  ToolCallCollector,
  type ToolCallResult,
} from "./tool-call-collector.ts";

// Task execution state
export {
  type TaskExecutionState,
  createTaskState,
  type CreateTaskStateOptions,
} from "./task-execution-state.ts";

// Unified Agent
export {
  Agent,
  type AgentDeps,
  type AgentResult,
  type ReplyCallback,
  type QueueItem,
  type CustomQueueItem,
  type SubagentNotificationPayload,
  formatChannelMeta,
  formatToolResult,
  mechanicalSummary,
} from "../agent.ts";
