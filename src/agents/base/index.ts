/**
 * Base agent module — new agent hierarchy for Pegasus.
 *
 * Exports:
 *   - AgentState, AgentStateManager — 3-state model (IDLE/BUSY/WAITING)
 *   - ToolCallCollector — parallel tool execution coordinator
 *   - TaskExecutionState — per-task state tracking
 *   - BaseAgent — abstract base class for all agents
 *   - Agent — unified concrete agent (conversation + execution)
 *   - OrchestratorAgent — complex task decomposition and coordination
 *   - ConversationAgent — DEPRECATED: use Agent instead
 *   - ExecutionAgent — DEPRECATED: use Agent instead
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
  type AgentCallbacks,
  type AgentResult,
  type ReplyCallback,
  type QueueItem,
  type CustomQueueItem,
  type TaskNotificationPayload,
  formatChannelMeta,
} from "../agent.ts";

// Agent types — backward-compat re-exports
export {
  ConversationAgent,
  type ConversationAgentDeps,
  type ReplyCallback as ConversationReplyCallback,
  type SpawnAgentCallback,
  type QueueItem as ConversationQueueItem,
  type CustomQueueItem as ConversationCustomQueueItem,
} from "./conversation-agent.ts";

// OrchestratorAgent — DEPRECATED: use Agent with TaskRunner via toolContext instead
export {
  OrchestratorAgent,
  type OrchestratorAgentDeps,
  type ExecutionSpawnConfig as OrchestratorExecutionSpawnConfig,
  type ExecutionHandle as OrchestratorExecutionHandle,
  type OrchestratorNotification as OrchestratorAgentNotification,
  type OrchestratorResult,
} from "./orchestrator-agent.ts";

export {
  ExecutionAgent,
  type ExecutionAgentDeps,
  type ExecutionMode,
  type ExecutionResult,
} from "./execution-agent.ts";
