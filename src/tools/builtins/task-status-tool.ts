/**
 * task_status — query the runtime status of spawned tasks.
 *
 * Reads from the in-memory TaskRegistry (via ToolContext) to show
 * currently active, completed, and failed tasks. Use this when a
 * spawned task's result hasn't come back and you need to check on it.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import type { TaskRegistry } from "../../task/registry.ts";

export const task_status: Tool = {
  name: "task_status",
  description:
    "Check the runtime status of spawned tasks. Shows all in-memory tasks with their current state (reasoning, acting, completed, failed, etc). Use when a task result hasn't arrived or you suspect a task may have failed silently.",
  category: ToolCategory.DATA,
  parameters: z.object({
    taskId: z
      .string()
      .optional()
      .describe("Optional: query a specific task by ID. If omitted, lists all tasks."),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { taskId } = params as { taskId?: string };
    const registry = context.taskRegistry as TaskRegistry | undefined;

    if (!registry) {
      return {
        success: false,
        error: "TaskRegistry not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      if (taskId) {
        // Query specific task
        const task = registry.getOrNull(taskId);
        if (!task) {
          return {
            success: true,
            result: { taskId, status: "not_found", message: "Task not in registry (may have been cleaned up or never existed)" },
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        return {
          success: true,
          result: {
            taskId: task.taskId,
            state: task.state,
            description: task.context.description,
            taskType: task.context.taskType,
            iteration: task.context.iteration,
            error: task.context.error,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // List all tasks
      const tasks = registry.listAll().map((task) => ({
        taskId: task.taskId,
        state: task.state,
        description: task.context.description,
        taskType: task.context.taskType,
        iteration: task.context.iteration,
        error: task.context.error,
      }));

      return {
        success: true,
        result: { tasks, activeCount: registry.activeCount, totalCount: registry.totalCount },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
