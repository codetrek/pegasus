/**
 * TaskRunner — manages Agent instances for AITask execution.
 *
 * One Agent per task, fire-and-forget via run().
 * Tracks active tasks, notifies parent on completion/failure.
 *
 * Replaces the old Agent.submit() + TaskFSM pattern with a direct
 * Agent.run() call — no FSM, no event bus gymnastics.
 */

import { Agent, type AgentResult } from "./agent.ts";
import type { LanguageModel } from "../infra/llm-types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { allTaskTools } from "../tools/builtins/index.ts";
import { spawn_subagent } from "../tools/builtins/spawn-subagent-tool.ts";
import { resume_subagent } from "../tools/builtins/resume-subagent-tool.ts";
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
  depth: number;
}

/** Options for submit(). */
export interface SubmitOpts {
  memorySnapshot?: string;
  depth?: number;
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
   *
   * @param opts.memorySnapshot  If provided, prepended to input as [Available Memory].
   * @param opts.depth           Nesting depth. 0 = L1 (can spawn_subagent), ≥1 = L2 (no spawning).
   */
  submit(
    input: string,
    source: string,
    taskType: string,
    description: string,
    opts?: SubmitOpts,
  ): string {
    const taskId = shortId();
    const depth = opts?.depth ?? 0;

    // Prepend memory snapshot to input when available
    let effectiveInput = input;
    if (opts?.memorySnapshot) {
      effectiveInput = `[Available Memory]\n${opts.memorySnapshot}\n\n---\n\n${input}`;
    }

    const toolRegistry = this.getToolRegistryForType(taskType, depth);
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(this.tasksDir, dateStr, taskId);

    const agent = new Agent({
      agentId: taskId,
      model: this.model,
      toolRegistry,
      systemPrompt: this._buildSystemPrompt(description, this.taskTypeRegistry.getPrompt(taskType), depth),
      sessionDir,
      storeImage: this.storeImage,
      contextWindow: this.contextWindow,
      toolContext: {
        taskRegistry: this,
        onNotify: (message: string) => {
          this.onNotification({ type: "notify", taskId, message });
        },
      },
    });

    // Write task index entry (for task_list / task_replay tools)
    this._appendTaskIndex(taskId, dateStr, { description, taskType, source, depth }).catch((err) => {
      logger.warn({ taskId, err }, "task_index_append_failed");
    });

    const info: TaskInfo = {
      taskId,
      input: effectiveInput,
      taskType,
      description,
      source,
      startedAt: Date.now(),
      depth,
    };

    this._runAgent(agent, taskId, effectiveInput, taskType, info);

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
    const entry = index.get(taskId);
    if (!entry) {
      throw new Error(`Task ${taskId} not found in task index`);
    }

    const sessionDir = path.join(this.tasksDir, entry.date, taskId);
    const sessionStore = new SessionStore(sessionDir);
    await sessionStore.append({ role: "user", content: newInput });

    const resolvedType = taskType ?? entry.taskType ?? "general";
    const resolvedDescription = description ?? `Resumed task ${taskId}`;
    const depth = entry.depth ?? 0;
    const toolRegistry = this.getToolRegistryForType(resolvedType, depth);

    const agent = new Agent({
      agentId: taskId,
      model: this.model,
      toolRegistry,
      systemPrompt: this._buildSystemPrompt(resolvedDescription, this.taskTypeRegistry.getPrompt(resolvedType), depth),
      sessionDir,
      storeImage: this.storeImage,
      toolContext: {
        taskRegistry: this,
        onNotify: (message: string) => {
          this.onNotification({ type: "notify", taskId, message });
        },
      },
    });

    const info: TaskInfo = {
      taskId,
      input: newInput,
      taskType: resolvedType,
      description: resolvedDescription,
      source: "resume",
      startedAt: Date.now(),
      depth,
    };

    this._runAgent(agent, taskId, newInput, resolvedType, info);

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
    agent: Agent,
    taskId: string,
    input: string,
    taskType: string,
    info: TaskInfo,
  ): void {
    this.activeTasks.set(taskId, info);

    agent
      .run(input, { persistSession: true })
      .then((result: AgentResult) => {
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
   * Read the task index file (index.jsonl) and return a map of taskId → entry.
   * Returns an empty map if the file does not exist.
   */
  private async _loadIndex(): Promise<Map<string, { date: string; depth?: number; taskType?: string }>> {
    const indexPath = path.join(this.tasksDir, "index.jsonl");
    const map = new Map<string, { date: string; depth?: number; taskType?: string }>();
    try {
      const content = await readFile(indexPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { taskId: string; date: string; depth?: number; taskType?: string };
        map.set(entry.taskId, { date: entry.date, depth: entry.depth, taskType: entry.taskType });
      }
    } catch {
      // File doesn't exist or unreadable — return empty map
    }
    return map;
  }

  /**
   * Build or retrieve a cached ToolRegistry for a given task type + depth.
   * Uses AITaskTypeRegistry.getToolNames() to resolve which tools
   * are available. Falls back to allTaskTools for unknown types.
   *
   * When depth === 0, spawn_subagent and resume_subagent are added
   * (L1 agents can spawn L2 sub-agents). depth >= 1 agents cannot.
   */
  private getToolRegistryForType(taskType: string, depth: number = 0): ToolRegistry {
    const cacheKey = `${taskType}:d${depth}`;
    const cached = this.toolRegistryCache.get(cacheKey);
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

    // L1 agents (depth === 0) can spawn sub-agents; L2+ cannot
    if (depth === 0) {
      registry.register(spawn_subagent);
      registry.register(resume_subagent);
    }

    this.toolRegistryCache.set(cacheKey, registry);
    return registry;
  }

  /**
   * Build a system prompt for task execution agents.
   * Mirrors the old ExecutionAgent.buildSystemPrompt() logic.
   *
   * When depth === 0, the prompt mentions spawn_subagent capability.
   */
  private _buildSystemPrompt(description: string, contextPrompt?: string, depth: number = 0): string {
    const lines = [
      "You are an execution agent working on a specific task.",
      `Task: ${description}`,
      "",
      "Complete the task using your available tools. Be efficient and focused.",
      "When done, provide your final result as text output.",
      "",
      "Use notify(message) to report significant progress to your coordinator.",
    ];

    if (depth === 0) {
      lines.push(
        "",
        "## Sub-task Delegation",
        "You can delegate sub-tasks using spawn_subagent(description, input, type).",
        "Types: general (full access), explore (read-only), plan (analysis).",
        "Use resume_subagent(subagent_id, input) to continue a completed sub-agent.",
        "Sub-agents run in the background — results arrive automatically via notification.",
      );
    }

    if (contextPrompt) {
      lines.push("", "## Context", contextPrompt);
    }

    return lines.join("\n");
  }

  /**
   * Append a task entry to the index.jsonl file (for task_list / task_replay).
   * Includes metadata so task_list can display summaries without opening sessions.
   */
  private async _appendTaskIndex(
    taskId: string,
    date: string,
    meta?: { description?: string; taskType?: string; source?: string; depth?: number },
  ): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    const indexPath = path.join(this.tasksDir, "index.jsonl");
    const entry: Record<string, string | number> = { taskId, date };
    if (meta?.description) entry.description = meta.description;
    if (meta?.taskType) entry.taskType = meta.taskType;
    if (meta?.source) entry.source = meta.source;
    if (meta?.depth !== undefined) entry.depth = meta.depth;
    const line = JSON.stringify(entry) + "\n";
    await appendFile(indexPath, line, "utf-8");
  }
}
