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
 *   New: ExecutionAgent.run() → processStep() → done.
 */

import { BaseAgent, type BaseAgentDeps, type ToolCallInterceptResult } from "./base-agent.ts";
import type { Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import { EventType, createEvent } from "../../events/types.ts";
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
  private contextPrompt: string;
  private onNotifyParent: ((message: string) => void) | null;

  /** Holds the last execution result for backward-compat run() to resolve. */
  private _lastResult: ExecutionResult | null = null;

  constructor(deps: ExecutionAgentDeps) {
    super({
      ...deps,
      maxIterations: deps.maxIterations ?? (deps.mode === "worker" ? 50 : 25),
    });
    this.input = deps.input;
    this.description = deps.description;
    this._mode = deps.mode;
    this.contextPrompt = deps.contextPrompt ?? "";
    this.onNotifyParent = deps.onNotify ?? null;

    // Session persistence only in worker mode
    this.sessionStore = deps.sessionDir
      ? new SessionStore(deps.sessionDir)
      : null;
  }

  // ═══════════════════════════════════════════════════
  // Execution (backward-compat wrapper)
  // ═══════════════════════════════════════════════════

  /**
   * Run the execution to completion.
   *
   * Backward-compatible wrapper: creates a TaskExecutionState,
   * drives processStep(), and resolves when onTaskComplete fires.
   */
  async run(): Promise<ExecutionResult> {
    // Load session for worker mode
    let messages: Message[] = [];
    if (this.sessionStore) {
      messages = await this.sessionStore.load();
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: this.input });
      if (this.sessionStore) {
        await this.sessionStore.append({ role: "user", content: this.input });
      }
    }

    // Create task state with completion promise
    return new Promise<ExecutionResult>((resolve) => {
      const state = this.createTaskExecutionState(this.agentId, messages, {
        maxIterations: this.maxIterations,
        metadata: { description: this.description },
        onComplete: () => {
          // onTaskComplete will set this._lastResult
          resolve(this._lastResult!);
        },
      });

      // Start processing
      this.processStep(this.agentId).catch((err) => {
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          llmCallCount: state.iteration,
          toolCallCount: 0,
        });
      });
    });
  }

  // ═══════════════════════════════════════════════════
  // Event-Driven: _startExecution
  // ═══════════════════════════════════════════════════

  /**
   * Start execution from an event trigger (TASK_CREATED).
   * Creates TaskExecutionState, loads session for worker mode, kicks off processStep.
   */
  private async _startExecution(): Promise<void> {
    let messages: Message[] = [];
    if (this.sessionStore) {
      messages = await this.sessionStore.load();
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: this.input });
      if (this.sessionStore) {
        await this.sessionStore.append({ role: "user", content: this.input });
      }
    }

    this.createTaskExecutionState(this.agentId, messages, {
      maxIterations: this.maxIterations,
      metadata: { description: this.description },
    });

    await this.processStep(this.agentId);
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
  // EventBus Integration
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
    this.eventBus.subscribe(EventType.TASK_CREATED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_SUSPENDED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_RESUMED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });
  }

  protected override async handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      case EventType.TASK_CREATED:
        await this._startExecution();
        break;

      case EventType.TASK_SUSPENDED: {
        const state = this.taskStates.get(this.agentId);
        if (state) {
          state.aborted = true;
        }
        break;
      }

      case EventType.TASK_RESUMED: {
        // Resume from session — re-start execution
        await this._startExecution();
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Task Completion
  // ═══════════════════════════════════════════════════

  protected override async onTaskComplete(
    taskId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    const state = this.taskStates.get(taskId);

    // Persist in worker mode
    if (this.sessionStore && state) {
      for (const msg of state.messages) {
        await this.sessionStore.append(msg);
      }
    }

    // Build result
    const success = finishReason === "complete";
    this._lastResult = {
      success,
      result: success ? text : undefined,
      error: !success
        ? finishReason === "error"
          ? "LLM call failed"
          : `Task ${finishReason}`
        : undefined,
      llmCallCount: state?.iteration ?? 0,
      toolCallCount: 0, // not tracked per-tool in new model
    };

    // Emit event
    await this.eventBus.emit(
      createEvent(
        success ? EventType.TASK_COMPLETED : EventType.TASK_FAILED,
        {
          source: this.agentId,
          taskId,
          payload: { result: text, finishReason },
        },
      ),
    );

    // Resolve completion promise
    state?.onComplete?.();

    // Cleanup
    this.removeTaskState(taskId);
    this.stateManager.markIdle();
  }
}
