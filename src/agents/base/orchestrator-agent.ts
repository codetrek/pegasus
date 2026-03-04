/**
 * OrchestratorAgent — decomposes complex tasks and coordinates execution.
 *
 * Lifecycle (event-driven):
 *   1. Receives TASK_CREATED event → starts orchestration via processStep
 *   2. LLM decomposes work, spawns ExecutionAgents via spawn_task tool
 *   3. Child task IDs tracked in childTaskIds set
 *   4. TASK_COMPLETED/TASK_FAILED events for children → collect results
 *   5. When all children done → synthesize final result via processStep
 *   6. Notify parent of completion
 *
 * Key change from old design:
 *   Old: _waitForChildren() polling with 100ms setTimeout loop
 *   New: EventBus subscription — child completion events drive synthesis
 */

import { BaseAgent, type BaseAgentDeps, type ToolCallInterceptResult } from "./base-agent.ts";
import type { PendingWork } from "./agent-state.ts";
import type { Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import { EventType, createEvent } from "../../events/types.ts";
import type { ToolCall } from "../../models/tool.ts";
import { SessionStore } from "../../session/store.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("orchestrator_agent");

// ── Types ────────────────────────────────────────────

export interface OrchestratorAgentDeps extends BaseAgentDeps {
  /** The task description from the parent. */
  taskDescription: string;
  /** Initial input to process. */
  input: string;
  /** System prompt additions (e.g., memory snapshot). */
  contextPrompt?: string;
  /** Session directory for debugging/resume. */
  sessionDir: string;
  /** Callback to spawn ExecutionAgents. */
  onSpawnExecution: (config: ExecutionSpawnConfig) => ExecutionHandle;
  /** Callback to notify parent agent of progress/completion. */
  onNotify: (notification: OrchestratorNotification) => void;
}

/** Configuration for spawning an ExecutionAgent. */
export interface ExecutionSpawnConfig {
  input: string;
  description: string;
  taskType?: string;
  mode: "task" | "worker";
}

/** Handle to a spawned ExecutionAgent. */
export interface ExecutionHandle {
  id: string;
  promise: Promise<{ success: boolean; result?: unknown; error?: string }>;
}

/** Notifications sent to the parent agent. */
export type OrchestratorNotification =
  | { type: "progress"; message: string }
  | { type: "completed"; result: unknown }
  | { type: "failed"; error: string };

/** Result of the orchestration. */
export interface OrchestratorResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// ── OrchestratorAgent ────────────────────────────────

export class OrchestratorAgent extends BaseAgent {
  private taskDescription: string;
  private input: string;
  private contextPrompt: string;
  private sessionStore: SessionStore;
  private sessionMessages: Message[] = [];
  private onSpawnExecution: (config: ExecutionSpawnConfig) => ExecutionHandle;
  private onNotifyParent: (notification: OrchestratorNotification) => void;
  private childResults = new Map<string, { success: boolean; result?: unknown; error?: string }>();

  /** Track spawned child task IDs for event-driven completion. */
  private childTaskIds = new Set<string>();

  /** Holds the last orchestration result for backward-compat run() to resolve. */
  private _lastResult: OrchestratorResult | null = null;

  constructor(deps: OrchestratorAgentDeps) {
    super(deps);
    this.taskDescription = deps.taskDescription;
    this.input = deps.input;
    this.contextPrompt = deps.contextPrompt ?? "";
    this.sessionStore = new SessionStore(deps.sessionDir);
    this.onSpawnExecution = deps.onSpawnExecution;
    this.onNotifyParent = deps.onNotify;
  }

  // ═══════════════════════════════════════════════════
  // Execution (backward-compat wrapper)
  // ═══════════════════════════════════════════════════

  /**
   * Run the orchestration to completion.
   *
   * Backward-compatible wrapper: creates a TaskExecutionState,
   * drives processStep(), and resolves when onTaskComplete fires.
   */
  async run(): Promise<OrchestratorResult> {
    return new Promise<OrchestratorResult>((resolve) => {
      // Load session, create state, start orchestration
      this._initAndStart(resolve).catch((err) => {
        const errorResult: OrchestratorResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        resolve(errorResult);
      });
    });
  }

  private async _initAndStart(resolve: (result: OrchestratorResult) => void): Promise<void> {
    // Load session history (for resume support)
    this.sessionMessages = await this.sessionStore.load();

    // Initial input as user message (if fresh start)
    if (this.sessionMessages.length === 0) {
      const userMsg: Message = { role: "user", content: this.input };
      this.sessionMessages.push(userMsg);
      await this.sessionStore.append(userMsg);
    }

    // Create task state with completion promise
    this.createTaskExecutionState(this.agentId, [...this.sessionMessages], {
      maxIterations: this.maxIterations,
      metadata: { description: this.taskDescription },
      onComplete: () => {
        resolve(this._lastResult!);
      },
    });

    // Subscribe to child events if EventBus is running
    this.subscribeEvents();

    // Start the EventBus if not already running
    if (!this.eventBus.isRunning) {
      await this.eventBus.start();
    }

    // Start orchestration
    await this._startOrchestration();
  }

  // ═══════════════════════════════════════════════════
  // Event-Driven: _startOrchestration
  // ═══════════════════════════════════════════════════

  /**
   * Start orchestration from an event trigger (TASK_CREATED) or run().
   * Loads session if needed, creates TaskExecutionState, kicks off processStep.
   */
  private async _startOrchestration(): Promise<void> {
    // If no task state yet (event-driven path), create one
    if (!this.taskStates.has(this.agentId)) {
      this.sessionMessages = await this.sessionStore.load();
      if (this.sessionMessages.length === 0) {
        const userMsg: Message = { role: "user", content: this.input };
        this.sessionMessages.push(userMsg);
        await this.sessionStore.append(userMsg);
      }

      this.createTaskExecutionState(this.agentId, [...this.sessionMessages], {
        maxIterations: this.maxIterations,
        metadata: { description: this.taskDescription },
      });
    }

    await this.processStep(this.agentId);
  }

  // ═══════════════════════════════════════════════════
  // Synthesis
  // ═══════════════════════════════════════════════════

  /**
   * All children completed — inject results as user message and run
   * one more processStep round for synthesis.
   */
  private async _synthesize(): Promise<void> {
    const state = this.taskStates.get(this.agentId);
    if (!state) return;

    // Inject child results as a user message
    const synthesisMsg: Message = {
      role: "user",
      content: this._formatChildResults(),
    };
    state.messages.push(synthesisMsg);

    // Use limited iterations for synthesis (current + 5)
    state.maxIterations = state.iteration + 5;

    await this.processStep(this.agentId);
  }

  // ═══════════════════════════════════════════════════
  // Tool Call Interception
  // ═══════════════════════════════════════════════════

  protected override async onToolCall(tc: ToolCall): Promise<ToolCallInterceptResult> {
    if (tc.name === "spawn_task") {
      return this._interceptSpawnTask(tc);
    }
    if (tc.name === "notify") {
      return this._interceptNotify(tc);
    }
    return { action: "execute" };
  }

  private _interceptSpawnTask(tc: ToolCall): ToolCallInterceptResult {
    const args = tc.arguments as { description: string; input: string; type?: string };

    const handle = this.onSpawnExecution({
      input: args.input,
      description: args.description,
      taskType: args.type,
      mode: "task",
    });

    // Track child task ID for event-driven completion
    this.childTaskIds.add(handle.id);

    // Track child result collection (backward-compat for handle.promise)
    handle.promise.then((result) => {
      this.childResults.set(handle.id, result);
    }).catch((err) => {
      this.childResults.set(handle.id, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const pendingWork: PendingWork = {
      id: handle.id,
      kind: "child_agent",
      description: args.description,
      dispatchedAt: Date.now(),
    };

    return {
      action: "intercept",
      result: {
        toolCallId: tc.id,
        content: JSON.stringify({
          taskId: handle.id,
          status: "spawned",
          description: args.description,
        }),
      },
      pendingWork,
    };
  }

  private _interceptNotify(tc: ToolCall): ToolCallInterceptResult {
    const args = tc.arguments as { message: string };
    this.onNotifyParent({ type: "progress", message: args.message });

    return {
      action: "skip",
      result: {
        toolCallId: tc.id,
        content: JSON.stringify({ notified: true }),
      },
    };
  }

  // ═══════════════════════════════════════════════════
  // Child Result Formatting
  // ═══════════════════════════════════════════════════

  private _formatChildResults(): string {
    const lines = ["All child tasks completed. Results:"];
    for (const [id, result] of this.childResults) {
      if (result.success) {
        const resultStr = typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result);
        lines.push(`\n[Task ${id}] Success:\n${resultStr}`);
      } else {
        lines.push(`\n[Task ${id}] Failed: ${result.error}`);
      }
    }
    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════

  protected override buildSystemPrompt(): string {
    const sections = [
      "## Your Role",
      "You are an Orchestrator Agent — an autonomous coordinator working on behalf of the main agent.",
      `Task: ${this.taskDescription}`,
      "",
      "## How You Work",
      "- Break down complex work into sub-tasks using spawn_task()",
      "- Use notify() to report progress to the main agent",
      "- Coordinate results from child tasks and synthesize a final answer",
      "- You can also execute work directly with your own tools",
      "",
      "## Rules",
      "1. FOCUS: Stay strictly on the task you were given.",
      "2. DECOMPOSE: Break complex work into parallel sub-tasks when possible.",
      "3. COORDINATE: Wait for sub-task results before synthesizing.",
      "4. PROGRESS: Use notify() for major milestones.",
      "5. EFFICIENT: Don't over-decompose. If you can do it directly, do it.",
    ];

    if (this.contextPrompt) {
      sections.push("", `## Context`, this.contextPrompt);
    }

    return sections.join("\n");
  }

  // ═══════════════════════════════════════════════════
  // EventBus Integration
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
    // TASK_CREATED: start orchestration when our task is created
    this.eventBus.subscribe(EventType.TASK_CREATED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });

    // TASK_COMPLETED: child task finished successfully
    this.eventBus.subscribe(EventType.TASK_COMPLETED, async (event: Event) => {
      if (event.taskId && this.childTaskIds.has(event.taskId)) {
        await this.handleEvent(event);
      }
    });

    // TASK_FAILED: child task failed
    this.eventBus.subscribe(EventType.TASK_FAILED, async (event: Event) => {
      if (event.taskId && this.childTaskIds.has(event.taskId)) {
        await this.handleEvent(event);
      }
    });

    // TASK_SUSPENDED: abort this orchestration
    this.eventBus.subscribe(EventType.TASK_SUSPENDED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });
  }

  protected override async handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      case EventType.TASK_CREATED:
        await this._startOrchestration();
        break;

      case EventType.TASK_COMPLETED:
      case EventType.TASK_FAILED: {
        const childId = event.taskId;
        if (!childId || !this.childTaskIds.has(childId)) return;

        // Store the result
        const payload = event.payload as { result?: unknown; finishReason?: string };
        const success = event.type === EventType.TASK_COMPLETED;
        this.childResults.set(childId, {
          success,
          result: success ? payload.result : undefined,
          error: !success ? String(payload.result ?? "child task failed") : undefined,
        });

        // Remove from tracking
        this.childTaskIds.delete(childId);
        this.stateManager.removePendingWork(childId);

        logger.info(
          { childId, remaining: this.childTaskIds.size, success },
          "child_task_completed",
        );

        // If all children done → synthesize
        if (this.childTaskIds.size === 0) {
          await this._synthesize();
        }
        break;
      }

      case EventType.TASK_SUSPENDED: {
        const state = this.taskStates.get(this.agentId);
        if (state) {
          state.aborted = true;
        }
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

    // If there are pending children, don't complete yet — wait for them
    if (this.childTaskIds.size > 0 && finishReason === "complete") {
      logger.info(
        { taskId, childCount: this.childTaskIds.size },
        "waiting_for_children",
      );
      return;
    }

    // Persist session
    if (state) {
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

    // Notify parent
    if (success) {
      this.onNotifyParent({ type: "completed", result: this._lastResult.result });
    } else {
      this.onNotifyParent({ type: "failed", error: this._lastResult.error ?? "unknown error" });
    }

    // Resolve completion promise
    state?.onComplete?.();

    // Cleanup
    this.removeTaskState(taskId);
    this.stateManager.markIdle();
  }
}
