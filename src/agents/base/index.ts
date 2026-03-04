/**
 * Base agent module — new agent hierarchy for Pegasus.
 *
 * Exports:
 *   - AgentState, AgentStateManager — 3-state model (IDLE/BUSY/WAITING)
 *   - toolUseLoop — core execution engine replacing Thinker+Planner+Actor
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

// Core engine
export {
  toolUseLoop,
  formatToolResult,
  type ToolUseLoopOptions,
  type ToolUseLoopResult,
  type ToolCallInterceptResult,
  type ToolCallResult,
} from "./tool-use-loop.ts";

// Base class
export {
  BaseAgent,
  type BaseAgentDeps,
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
