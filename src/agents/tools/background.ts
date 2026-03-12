/**
 * BackgroundTaskManager - manages lifecycle of background tool executions.
 *
 * Enables the LLM to run tools in the background so the cognitive loop
 * is not blocked by long-running operations.  Each background task gets
 * a unique ID that can be used to poll status, wait for completion, or
 * stop the task.
 *
 * Pure in-memory state — nothing is persisted.
 */

import type { ToolExecutor } from "./executor.ts";
import type { ToolResult, ToolContext } from "./types.ts";
import type { PendingTracker } from "../pending-tracker.ts";
import { getLogger } from "../../infra/logger.ts";
import { shortId } from "../../infra/id.ts";

const logger = getLogger("tools.background");

// ── Constants ────────────────────────────────────────

/** Maximum allowed timeout for a single background tool execution (10 minutes). */
export const MAX_TOOL_TIMEOUT = 600_000;

/** Default age after which completed/failed tasks are cleaned up (30 minutes). */
export const DEFAULT_CLEANUP_AGE = 30 * 60 * 1000;

// ── Types ────────────────────────────────────────────

interface BackgroundTask {
  id: string;
  tool: string;
  status: "running" | "completed" | "failed";
  result?: ToolResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
  abortController: AbortController;
  promise: Promise<void>;
}

export type BackgroundTaskStatus =
  | { bgTaskId: string; status: "running"; tool: string; elapsedMs: number }
  | { bgTaskId: string; status: "completed"; result: ToolResult }
  | { bgTaskId: string; status: "failed"; error: string }
  | { bgTaskId: string; status: "not_found" };

// ── BackgroundTaskManager ────────────────────────────

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();

  constructor(
    private executor: ToolExecutor,
    private defaultTimeout: number = MAX_TOOL_TIMEOUT,
    private pendingTracker?: PendingTracker,
  ) {}

  /**
   * Start a tool execution in the background.
   *
   * Returns the task ID immediately.  The executor.execute() call runs
   * as a fire-and-forget promise; its result/error is captured when the
   * promise settles.
   */
  run(
    toolName: string,
    params: unknown,
    context: ToolContext,
    timeout?: number,
  ): string {
    // Piggyback cleanup on each new run to prevent memory leaks
    this.cleanup();

    const id = this.generateId();
    const effectiveTimeout = Math.min(
      timeout ?? this.defaultTimeout,
      MAX_TOOL_TIMEOUT,
    );

    const abortController = new AbortController();
    const startedAt = Date.now();

    // Build the promise first, then construct the task object (avoids `undefined!`)
    const executePromise = this.executeWithTimeout(
      toolName,
      params,
      context,
      effectiveTimeout,
      abortController.signal,
    );

    // Mutable holder so .then/.catch can reference the task
    let taskRef: BackgroundTask;

    const promise = executePromise
      .then((result) => {
        // Task may have been stopped while running
        if (taskRef.status !== "running") return;
        taskRef.status = result.success ? "completed" : "failed";
        taskRef.result = result;
        taskRef.error = result.error;
        taskRef.completedAt = Date.now();
        this.pendingTracker?.remove(id);
        logger.info(
          { bgTaskId: id, tool: toolName, success: result.success,
            durationMs: taskRef.completedAt - startedAt },
          "bg_task_done",
        );
      })
      .catch((error) => {
        if (taskRef.status !== "running") return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        taskRef.status = "failed";
        taskRef.error = errorMessage;
        taskRef.completedAt = Date.now();
        this.pendingTracker?.remove(id);
        logger.error(
          { bgTaskId: id, tool: toolName, error: errorMessage,
            durationMs: taskRef.completedAt - startedAt },
          "bg_task_error",
        );
      });

    const task: BackgroundTask = {
      id,
      tool: toolName,
      status: "running",
      startedAt,
      abortController,
      promise,
    };
    taskRef = task;

    this.tasks.set(id, task);

    this.pendingTracker?.add({ id, kind: "bg_run", ts: startedAt, tool: toolName });
    logger.info(
      { bgTaskId: id, tool: toolName, timeout: effectiveTimeout },
      "bg_task_started",
    );

    return id;
  }

  /**
   * Get the current status of a background task.
   */
  getStatus(bgTaskId: string): BackgroundTaskStatus {
    const task = this.tasks.get(bgTaskId);
    if (!task) {
      return { bgTaskId, status: "not_found" };
    }

    switch (task.status) {
      case "running":
        return {
          bgTaskId,
          status: "running",
          tool: task.tool,
          elapsedMs: Date.now() - task.startedAt,
        };
      case "completed":
        return {
          bgTaskId,
          status: "completed",
          result: task.result!,
        };
      case "failed":
        return {
          bgTaskId,
          status: "failed",
          error: task.error ?? "Unknown error",
        };
    }
  }

  /**
   * Wait for a background task to complete or until timeout.
   *
   * Uses a promise-based approach: races the task's internal promise
   * against a timeout.  Returns the final status when settled.
   */
  async waitFor(bgTaskId: string, timeout: number): Promise<BackgroundTaskStatus> {
    const task = this.tasks.get(bgTaskId);
    if (!task) {
      return { bgTaskId, status: "not_found" };
    }

    if (task.status !== "running") {
      return this.getStatus(bgTaskId);
    }

    // Race the task promise against a timeout
    let timerId: ReturnType<typeof setTimeout>;
    await Promise.race([
      task.promise,
      new Promise<void>((resolve) => { timerId = setTimeout(resolve, timeout); }),
    ]);
    clearTimeout(timerId!);

    return this.getStatus(bgTaskId);
  }

  /**
   * Stop a running background task.
   *
   * Marks the task as failed with a "stopped by user" error.
   * Signals abort via AbortController (tools may or may not honour it).
   *
   * Returns true if the task was found and stopped, false otherwise.
   */
  stop(bgTaskId: string): boolean {
    const task = this.tasks.get(bgTaskId);
    if (!task || task.status !== "running") {
      return false;
    }

    task.abortController.abort();
    task.status = "failed";
    task.error = "Stopped by user";
    task.completedAt = Date.now();

    this.pendingTracker?.remove(bgTaskId);

    logger.info(
      { bgTaskId, tool: task.tool, durationMs: task.completedAt - task.startedAt },
      "bg_task_stopped",
    );

    return true;
  }

  /**
   * Remove completed/failed tasks older than maxAgeMs.
   */
  cleanup(maxAgeMs: number = DEFAULT_CLEANUP_AGE): void {
    const now = Date.now();
    let removed = 0;

    for (const [id, task] of this.tasks) {
      if (task.status === "running") continue;
      if (task.completedAt && now - task.completedAt > maxAgeMs) {
        this.tasks.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug({ removed }, "bg_tasks_cleaned_up");
    }
  }

  // ── Private helpers ──────────────────────────────

  private generateId(): string {
    return `bg-${shortId()}`;
  }

  /**
   * Execute a tool with a timeout cap.
   *
   * If the AbortController is signalled (via stop()), the timeout race
   * resolves early so the task status update in run() is skipped
   * (stop() already set the status).
   */
  private async executeWithTimeout(
    toolName: string,
    params: unknown,
    context: ToolContext,
    timeout: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const executePromise = this.executor.execute(toolName, params, context, { timeout, signal });

    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`Background task timed out after ${timeout}ms`)),
        timeout,
      );
      // If aborted, clear the timer so we don't leak
      signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
    });

    try {
      const result = await Promise.race([executePromise, timeoutPromise]);
      clearTimeout(timerId!);
      return result;
    } catch (error) {
      clearTimeout(timerId!);
      throw error;
    }
  }
}
