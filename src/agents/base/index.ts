/**
 * Base agent module — new agent hierarchy for Pegasus.
 *
 * Exports:
 *   - AgentState, AgentStateManager — 3-state model (IDLE/BUSY/WAITING)
 *   - ToolCallCollector — parallel tool execution coordinator
 *   - TaskExecutionState — per-task state tracking
 *   - BaseAgent — abstract base class for all agents
 *   - ConversationAgent — persistent conversation management
 *   - OrchestratorAgent — complex task decomposition and coordination
 *   - ExecutionAgent — direct task execution (task/worker modes)
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

// Agent types
export {
  ConversationAgent,
  type ConversationAgentDeps,
  type ReplyCallback,
  type SpawnAgentCallback,
} from "./conversation-agent.ts";

export {
  OrchestratorAgent,
  type OrchestratorAgentDeps,
  type ExecutionSpawnConfig,
  type ExecutionHandle,
  type OrchestratorNotification,
  type OrchestratorResult,
} from "./orchestrator-agent.ts";

export {
  ExecutionAgent,
  type ExecutionAgentDeps,
  type ExecutionMode,
  type ExecutionResult,
} from "./execution-agent.ts";
