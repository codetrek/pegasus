/**
 * ExecutionAgent — does actual work.
 *
 * Two modes via configuration (not inheritance):
 *
 *   "task" mode — inline, fire-and-forget:
 *     - Runs in caller's thread
 *     - No session persistence
 *     - Cannot be resumed after crash
 *     - Used for simple, atomic work
 *
 *   "worker" mode — persistent, Worker thread:
 *     - Runs in dedicated Worker thread (via WorkerAdapter)
 *     - Has session persistence (recoverable)
 *     - Can be suspended/resumed
 *     - Used for longer-running work needing crash isolation
 *
 * Replaces:
 *   - Old AITask (inline execution with FSM overhead)
 *   - Old Agent-in-Worker pattern (SubAgent/Project Worker bootstrap)
 *
 * The fundamental simplification:
 *   Old: Agent._onExternalInput → TaskFSM → TASK_CREATED → transition(REASONING)
 *        → _runReason → Thinker → REASON_DONE → transition(ACTING) → _runAct
 *        → Actor → ToolExecutor → TOOL_CALL_COMPLETED → transition(REASONING) → ...
 *
 *   New: ExecutionAgent.run() → toolUseLoop() → done.
 */

import { BaseAgent, type BaseAgentDeps } from "./base-agent.ts";
import type { ToolCallInterceptResult } from "./tool-use-loop.ts";
import type { Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import type { ToolCall } from "../../models/tool.ts";
import { SessionStore } from "../../session/store.ts";

// ── Types ────────────────────────────────────────────

/**
 * Execution mode:
 *   "task"   — inline, fire-and-forget, no session
 *   "worker" — Worker thread, session persistence, recoverable
 */
export type ExecutionMode = "task" | "worker";

export interface ExecutionAgentDeps extends BaseAgentDeps {
  /** What to do. */
  input: string;
  /** Human-readable description. */
  description: string;
  /** Execution mode. */
  mode: ExecutionMode;
  /** Session directory (only used in "worker" mode). */
  sessionDir?: string;
  /** Memory directory for memory tools. */
  memoryDir?: string;
  /** Tasks directory for task persistence. */
  tasksDir?: string;
  /** System prompt additions. */
  contextPrompt?: string;
  /** Callback to notify parent of progress. */
  onNotify?: (message: string) => void;
}

/** Result of execution. */
export interface ExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Number of LLM calls made. */
  llmCallCount: number;
  /** Number of tools executed. */
  toolCallCount: number;
}

// ── ExecutionAgent ───────────────────────────────────

export class ExecutionAgent extends BaseAgent {
  private input: string;
  private description: string;
  private _mode: ExecutionMode;

  get mode(): ExecutionMode {
    return this._mode;
  }
  private sessionStore: SessionStore | null;
  private memoryDir: string | undefined;
  private tasksDir: string | undefined;
  private contextPrompt: string;
  private onNotifyParent: ((message: string) => void) | null;

  constructor(deps: ExecutionAgentDeps) {
    super({
      ...deps,
      maxIterations: deps.maxIterations ?? (deps.mode === "worker" ? 50 : 25),
    });
    this.input = deps.input;
    this.description = deps.description;
    this._mode = deps.mode;
    this.memoryDir = deps.memoryDir;
    this.tasksDir = deps.tasksDir;
    this.contextPrompt = deps.contextPrompt ?? "";
    this.onNotifyParent = deps.onNotify ?? null;

    // Session persistence only in worker mode
    this.sessionStore = deps.sessionDir
      ? new SessionStore(deps.sessionDir)
      : null;
  }

  // ═══════════════════════════════════════════════════
  // Execution
  // ═══════════════════════════════════════════════════

  /**
   * Run the execution to completion.
   *
   * taskMode:   runs inline, returns result directly.
   * workerMode: loads session for resume, persists messages.
   */
  async run(): Promise<ExecutionResult> {
    let messages: Message[] = [];

    // In worker mode, load existing session for resume
    if (this.sessionStore) {
      messages = await this.sessionStore.load();
    }

    // Add input as user message (if starting fresh)
    if (messages.length === 0) {
      const userMsg: Message = { role: "user", content: this.input };
      messages.push(userMsg);
      if (this.sessionStore) {
        await this.sessionStore.append(userMsg);
      }
    }

    const result = await this.runToolUseLoop({
      systemPrompt: this.buildSystemPrompt(),
      messages,
      toolContext: {
        taskId: this.agentId,
        memoryDir: this.memoryDir,
        tasksDir: this.tasksDir,
      },
    });

    // Persist in worker mode
    if (this.sessionStore) {
      for (const msg of result.newMessages) {
        await this.sessionStore.append(msg);
      }
    }

    if (result.finishReason === "error") {
      return {
        success: false,
        error: result.error,
        llmCallCount: result.llmCallCount,
        toolCallCount: result.toolCallCount,
      };
    }

    return {
      success: true,
      result: result.text,
      llmCallCount: result.llmCallCount,
      toolCallCount: result.toolCallCount,
    };
  }

  // ═══════════════════════════════════════════════════
  // Tool Call Interception
  // ═══════════════════════════════════════════════════

  protected override async onToolCall(tc: ToolCall): Promise<ToolCallInterceptResult> {
    // Intercept notify() to send progress to parent
    if (tc.name === "notify" && this.onNotifyParent) {
      const args = tc.arguments as { message: string };
      this.onNotifyParent(args.message);
      return {
        action: "skip",
        result: {
          toolCallId: tc.id,
          content: JSON.stringify({ notified: true }),
        },
      };
    }
    // Everything else: normal execution
    return { action: "execute" };
  }

  // ═══════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════

  protected override buildSystemPrompt(): string {
    const lines = [
      "You are an execution agent working on a specific task.",
      `Task: ${this.description}`,
      "",
      "Complete the task using your available tools. Be efficient and focused.",
      "When done, provide your final result as text output.",
    ];

    if (this.onNotifyParent) {
      lines.push(
        "",
        "Use notify(message) to report significant progress to your coordinator.",
      );
    }

    if (this.contextPrompt) {
      lines.push("", "## Context", this.contextPrompt);
    }

    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════
  // EventBus (ExecutionAgent runs to completion)
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
    // ExecutionAgent runs to completion via run(), not event-driven
  }

  protected override async handleEvent(_event: Event): Promise<void> {
    // No-op: ExecutionAgent doesn't process external events
  }
}
