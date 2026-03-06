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
import type { LanguageModel } from "../infra/llm-types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { allTaskTools } from "../tools/builtins/index.ts";
import type { AITaskTypeRegistry } from "../aitask-types/registry.ts";
import { shortId } from "../infra/id.ts";
import { getLogger } from "../infra/logger.ts";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../session/store.ts";

const logger = getLogger("task_runner");

// ── Types ────────────────────────────────────────────

export type TaskNotification =
  | { type: "completed"; taskId: string; result: unknown; imageRefs?: Array<{ id: string; mimeType: string }> }
  | { type: "failed"; taskId: string; error: string }
  | { type: "notify"; taskId: string; message: string; imageRefs?: Array<{ id: string; mimeType: string }> };

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
  /** Base directory for task persistence (e.g. data/agents/main/tasks). */
  tasksDir: string;
  /** Callback for task lifecycle notifications. */
  onNotification: (notification: TaskNotification) => void;
  /** Optional storeImage callback passed through to ExecutionAgent → ToolContext. */
  storeImage?: ToolContext["storeImage"];
  /** Context window override for task agents (tokens). */
  contextWindow?: number;
}

// ── TaskRunner ───────────────────────────────────────

export class TaskRunner {
  private model: LanguageModel;
  private taskTypeRegistry: AITaskTypeRegistry;
  private tasksDir: string;
  private onNotification: (notification: TaskNotification) => void;
  private storeImage?: ToolContext["storeImage"];
  private contextWindow?: number;
  private activeTasks = new Map<string, TaskInfo>();

  /** Cached per-type ToolRegistry instances. */
  private toolRegistryCache = new Map<string, ToolRegistry>();

  /** Additional tools (e.g. MCP tools) registered after construction. */
  private additionalTools: Tool[] = [];

  constructor(deps: TaskRunnerDeps) {
    this.model = deps.model;
    this.taskTypeRegistry = deps.taskTypeRegistry;
    this.tasksDir = deps.tasksDir;
    this.onNotification = deps.onNotification;
    this.storeImage = deps.storeImage;
    this.contextWindow = deps.contextWindow;
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
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(this.tasksDir, dateStr, taskId);

    const agent = new ExecutionAgent({
      agentId: taskId,
      model: this.model,
      toolRegistry,
      input,
      description,
      mode: "worker",
      sessionDir,
      contextPrompt: this.taskTypeRegistry.getPrompt(taskType),
      storeImage: this.storeImage,
      contextWindow: this.contextWindow,
      onNotify: (message: string) => {
        this.onNotification({ type: "notify", taskId, message });
      },
    });

    // Write task index entry (for task_list / task_replay tools)
    this._appendTaskIndex(taskId, dateStr).catch((err) => {
      logger.warn({ taskId, err }, "task_index_append_failed");
    });

    const info: TaskInfo = {
      taskId,
      input,
      taskType,
      description,
      source,
      startedAt: Date.now(),
    };

    this._runAgent(agent, taskId, taskType, info);

    return taskId;
  }

  /**
   * Resume a previously-submitted task by appending new user input
   * and re-running the ExecutionAgent from its persisted session.
   *
   * Returns taskId immediately; the agent runs fire-and-forget in the background.
   */
  async resume(
    taskId: string,
    newInput: string,
    taskType?: string,
    description?: string,
  ): Promise<string> {
    // Guard: cannot resume a task that is still running
    if (this.activeTasks.has(taskId)) {
      throw new Error(`Task ${taskId} is still running, cannot resume`);
    }

    const index = await this._loadIndex();
    const date = index.get(taskId);
    if (!date) {
      throw new Error(`Task ${taskId} not found in task index`);
    }

    const sessionDir = path.join(this.tasksDir, date, taskId);
    const sessionStore = new SessionStore(sessionDir);
    await sessionStore.append({ role: "user", content: newInput });

    const resolvedType = taskType ?? "general";
    const resolvedDescription = description ?? `Resumed task ${taskId}`;
    const toolRegistry = this.getToolRegistryForType(resolvedType);

    const agent = new ExecutionAgent({
      agentId: taskId,
      model: this.model,
      toolRegistry,
      input: newInput,
      description: resolvedDescription,
      mode: "worker",
      sessionDir,
      contextPrompt: this.taskTypeRegistry.getPrompt(resolvedType),
      storeImage: this.storeImage,
      onNotify: (message: string) => {
        this.onNotification({ type: "notify", taskId, message });
      },
    });

    const info: TaskInfo = {
      taskId,
      input: newInput,
      taskType: resolvedType,
      description: resolvedDescription,
      source: "resume",
      startedAt: Date.now(),
    };

    this._runAgent(agent, taskId, resolvedType, info);

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

  /**
   * Register additional tools (e.g. MCP tools) that should be available
   * to all task types. Clears the tool registry cache so new tasks
   * pick up the updated tool set.
   */
  setAdditionalTools(tools: Tool[]): void {
    this.additionalTools = tools;
    this.toolRegistryCache.clear();
  }

  // ═══════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════

  /**
   * Fire-and-forget: add to activeTasks, run the agent,
   * and handle completion/failure notifications.
   */
  private _runAgent(
    agent: ExecutionAgent,
    taskId: string,
    taskType: string,
    info: TaskInfo,
  ): void {
    this.activeTasks.set(taskId, info);

    agent
      .run()
      .then((result: ExecutionResult) => {
        this.activeTasks.delete(taskId);
        if (result.success) {
          this.onNotification({
            type: "completed",
            taskId,
            result: result.result,
            ...(result.imageRefs?.length ? { imageRefs: result.imageRefs } : {}),
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
  }

  /**
   * Read the task index file (index.jsonl) and return a map of taskId → date.
   * Returns an empty map if the file does not exist.
   */
  private async _loadIndex(): Promise<Map<string, string>> {
    const indexPath = path.join(this.tasksDir, "index.jsonl");
    const map = new Map<string, string>();
    try {
      const content = await readFile(indexPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { taskId: string; date: string };
        map.set(entry.taskId, entry.date);
      }
    } catch {
      // File doesn't exist or unreadable — return empty map
    }
    return map;
  }

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

    // Register additional tools (e.g. MCP tools) unconditionally
    for (const tool of this.additionalTools) {
      registry.register(tool);
    }

    this.toolRegistryCache.set(taskType, registry);
    return registry;
  }

  /**
   * Append a task entry to the index.jsonl file (for task_list / task_replay).
   * Compatible with the format used by TaskPersister.
   */
  private async _appendTaskIndex(taskId: string, date: string): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    const indexPath = path.join(this.tasksDir, "index.jsonl");
    const line = JSON.stringify({ taskId, date }) + "\n";
    await appendFile(indexPath, line, "utf-8");
  }
}
