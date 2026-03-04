/**
 * OrchestratorAgent — decomposes complex tasks and coordinates execution.
 *
 * Lifecycle:
 *   1. Receives task description + input from parent
 *   2. Runs tool-use loop with planning tools + spawn_task
 *   3. LLM decomposes work, spawns ExecutionAgents
 *   4. Collects results from child agents
 *   5. Synthesizes final result
 *   6. Notifies parent of completion
 *
 * Key design: OrchestratorAgent uses the SAME tool-use loop as
 * ConversationAgent and ExecutionAgent. The difference is:
 *   - Its tool set includes spawn_task (for delegation) + notify (for progress)
 *   - It does NOT have reply (cannot talk to users)
 *   - Its onToolCall() intercepts spawn_task to create child ExecutionAgents
 */

import { BaseAgent, type BaseAgentDeps } from "./base-agent.ts";
import type { ToolCallInterceptResult } from "./tool-use-loop.ts";
import type { PendingWork } from "./agent-state.ts";
import type { Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
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
  // Execution
  // ═══════════════════════════════════════════════════

  /**
   * Run the orchestration to completion.
   *
   * Unlike ConversationAgent (event-driven, long-lived),
   * OrchestratorAgent runs to completion and returns.
   */
  async run(): Promise<OrchestratorResult> {
    // Load session history (for resume support)
    this.sessionMessages = await this.sessionStore.load();

    // Initial input as user message (if fresh start)
    if (this.sessionMessages.length === 0) {
      const userMsg: Message = { role: "user", content: this.input };
      this.sessionMessages.push(userMsg);
      await this.sessionStore.append(userMsg);
    }

    // Main orchestration loop
    const result = await this.runToolUseLoop({
      systemPrompt: this.buildSystemPrompt(),
      messages: this.sessionMessages,
    });

    // Persist new messages
    for (const msg of result.newMessages) {
      await this.sessionStore.append(msg);
    }

    // Wait for any pending child agents
    if (result.pendingWork.length > 0) {
      await this._waitForChildren(result.pendingWork);

      // Run one more loop to synthesize results
      const synthesisResult = await this.runToolUseLoop({
        systemPrompt: this.buildSystemPrompt(),
        messages: [...this.sessionMessages, ...result.newMessages],
        triggerMessage: {
          role: "user",
          content: this._formatChildResults(),
        },
        maxIterations: 5, // Synthesis shouldn't need many iterations
      });

      for (const msg of synthesisResult.newMessages) {
        await this.sessionStore.append(msg);
      }

      const finalResult: OrchestratorResult = { success: true, result: synthesisResult.text };
      this.onNotifyParent({ type: "completed", result: finalResult.result });
      return finalResult;
    }

    if (result.finishReason === "error") {
      const failResult: OrchestratorResult = { success: false, error: result.error };
      this.onNotifyParent({ type: "failed", error: result.error ?? "unknown error" });
      return failResult;
    }

    const finalResult: OrchestratorResult = { success: true, result: result.text };
    this.onNotifyParent({ type: "completed", result: finalResult.result });
    return finalResult;
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

    // Track child result collection
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
  // Child Management
  // ═══════════════════════════════════════════════════

  private async _waitForChildren(pendingWork: PendingWork[]): Promise<void> {
    // Wait for all child promises to settle
    const promises = pendingWork.map(async (pw) => {
      try {
        // The promise was stored in the ExecutionHandle;
        // childResults will be populated via the .then() in _interceptSpawnTask
        // We wait for the state manager to clear all pending work
        const waitForId = async (id: string, timeoutMs: number = 300_000) => {
          const start = Date.now();
          while (this.stateManager.pendingWork.has(id)) {
            if (Date.now() - start > timeoutMs) {
              this.childResults.set(id, { success: false, error: "timeout" });
              this.stateManager.removePendingWork(id);
              return;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        };
        await waitForId(pw.id, pw.timeoutMs);
      } catch (err) {
        logger.error({ err, childId: pw.id }, "child_wait_error");
      }
    });

    await Promise.allSettled(promises);
  }

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
  // EventBus (OrchestratorAgent runs to completion)
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
    // OrchestratorAgent runs to completion via run(), not event-driven
  }

  protected override async handleEvent(_event: Event): Promise<void> {
    // No-op: OrchestratorAgent doesn't process external events
  }
}
