/**
 * TaskRunner — manages ExecutionAgent instances for AITask execution.
 *
 * One ExecutionAgent per task, fire-and-forget via run().
 * Tracks active tasks, notifies parent on completion/failure.
 *
 * Replaces the old Agent.submit() + TaskFSM pattern with a direct
 * ExecutionAgent.run() call — no FSM, no event bus gymnastics.
 */

import { ExecutionAgent } from "./base/execution-agent.ts";
import type { ExecutionResult } from "./base/execution-agent.ts";
import type { TaskNotification } from "./agent.ts";
import type { LanguageModel } from "../infra/llm-types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { allTaskTools } from "../tools/builtins/index.ts";
import type { AITaskTypeRegistry } from "../aitask-types/registry.ts";
import { shortId } from "../infra/id.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("task_runner");

// ── Types ────────────────────────────────────────────

export interface TaskInfo {
  taskId: string;
  input: string;
  taskType: string;
  description: string;
  source: string;
  startedAt: number;
}

export interface TaskRunnerDeps {
  /** LLM model for task agents. */
  model: LanguageModel;
  /** AI task type registry for per-type tool resolution. */
  taskTypeRegistry: AITaskTypeRegistry;
  /** Callback for task lifecycle notifications. */
  onNotification: (notification: TaskNotification) => void;
}

// ── TaskRunner ───────────────────────────────────────

export class TaskRunner {
  private model: LanguageModel;
  private taskTypeRegistry: AITaskTypeRegistry;
  private onNotification: (notification: TaskNotification) => void;
  private activeTasks = new Map<string, TaskInfo>();

  /** Cached per-type ToolRegistry instances. */
  private toolRegistryCache = new Map<string, ToolRegistry>();

  constructor(deps: TaskRunnerDeps) {
    this.model = deps.model;
    this.taskTypeRegistry = deps.taskTypeRegistry;
    this.onNotification = deps.onNotification;
  }

  // ═══════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════

  /**
   * Submit a task for execution. Returns taskId immediately.
   * The ExecutionAgent runs fire-and-forget in the background.
   */
  submit(
    input: string,
    source: string,
    taskType: string,
    description: string,
  ): string {
    const taskId = shortId();
    const toolRegistry = this.getToolRegistryForType(taskType);

    const agent = new ExecutionAgent({
      agentId: taskId,
      model: this.model,
      toolRegistry,
      input,
      description,
      mode: "task",
      contextPrompt: this.taskTypeRegistry.getPrompt(taskType),
      onNotify: (message: string) => {
        this.onNotification({ type: "notify", taskId, message });
      },
    });

    const info: TaskInfo = {
      taskId,
      input,
      taskType,
      description,
      source,
      startedAt: Date.now(),
    };
    this.activeTasks.set(taskId, info);

    // Fire-and-forget: run the agent, handle completion/failure
    agent
      .run()
      .then((result: ExecutionResult) => {
        this.activeTasks.delete(taskId);
        if (result.success) {
          this.onNotification({
            type: "completed",
            taskId,
            result: result.result,
          });
        } else {
          this.onNotification({
            type: "failed",
            taskId,
            error: result.error ?? "Unknown error",
          });
        }
        logger.info(
          { taskId, taskType, success: result.success, llmCalls: result.llmCallCount },
          "task_completed",
        );
      })
      .catch((err: unknown) => {
        this.activeTasks.delete(taskId);
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.onNotification({
          type: "failed",
          taskId,
          error: errorMsg,
        });
        logger.error({ taskId, taskType, err }, "task_runner_error");
      });

    return taskId;
  }

  /** Number of currently running tasks. */
  get activeCount(): number {
    return this.activeTasks.size;
  }

  /** Get info about a running task, or null if not found / already completed. */
  getStatus(taskId: string): TaskInfo | null {
    return this.activeTasks.get(taskId) ?? null;
  }

  /** List all currently active tasks. */
  listAll(): TaskInfo[] {
    return [...this.activeTasks.values()];
  }

  // ═══════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════

  /**
   * Build or retrieve a cached ToolRegistry for a given task type.
   * Uses AITaskTypeRegistry.getToolNames() to resolve which tools
   * are available. Falls back to allTaskTools for unknown types.
   */
  private getToolRegistryForType(taskType: string): ToolRegistry {
    const cached = this.toolRegistryCache.get(taskType);
    if (cached) return cached;

    const registry = new ToolRegistry();
    const toolNames = this.taskTypeRegistry.getToolNames(taskType);
    const toolNameSet = new Set(toolNames);

    for (const tool of allTaskTools) {
      if (toolNameSet.has(tool.name)) {
        registry.register(tool);
      }
    }

    this.toolRegistryCache.set(taskType, registry);
    return registry;
  }
}
