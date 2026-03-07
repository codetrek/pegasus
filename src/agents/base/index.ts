/**
 * Base agent module — agent hierarchy for Pegasus.
 *
 * Exports:
 *   - AgentState, AgentStateManager — 3-state model (IDLE/BUSY/WAITING)
 *   - ToolCallCollector — parallel tool execution coordinator
 *   - TaskExecutionState — per-task state tracking
 *   - BaseAgent — abstract base class for all agents
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

// Base class
export {
  BaseAgent,
  type BaseAgentDeps,
  formatToolResult,
  type ToolCallInterceptResult,
} from "./base-agent.ts";

// Unified Agent
export {
  Agent,
  type AgentDeps,
  type AgentResult,
  type ReplyCallback,
  type QueueItem,
  type CustomQueueItem,
  type TaskNotificationPayload,
  formatChannelMeta,
} from "../agent.ts";
