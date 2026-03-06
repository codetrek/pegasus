/**
 * task_status — query the runtime status of spawned tasks.
 *
 * Reads from the in-memory task registry (via ToolContext) to show
 * currently active, completed, and failed tasks. Use this when a
 * spawned task's result hasn't come back and you need to check on it.
 *
 * Supports both old TaskRegistry (getOrNull/listAll/activeCount/totalCount)
 * and new TaskRunner (getStatus/listAll/activeCount) via duck typing.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

/**
 * Duck-type check: does the registry have .getOrNull (old TaskRegistry)?
 * If not, it's the new TaskRunner which uses .getStatus instead.
 */
function isOldRegistry(registry: unknown): registry is {
  getOrNull(taskId: string): { taskId: string; state: string; context: { description: string; taskType: string; iteration: number; error?: string } } | null;
  listAll(): Array<{ taskId: string; state: string; context: { description: string; taskType: string; iteration: number; error?: string } }>;
  activeCount: number;
  totalCount: number;
} {
  return typeof (registry as Record<string, unknown>).getOrNull === "function";
}

function isNewRunner(registry: unknown): registry is {
  getStatus(taskId: string): { taskId: string; taskType: string; description: string; source: string; startedAt: number } | null;
  listAll(): Array<{ taskId: string; taskType: string; description: string; source: string; startedAt: number }>;
  activeCount: number;
} {
  return typeof (registry as Record<string, unknown>).getStatus === "function";
}

export const task_status: Tool = {
  name: "task_status",
  description:
    "Check the runtime status of spawned tasks. Shows all in-memory tasks with their current state. " +
    "IMPORTANT: Task results arrive automatically via notification — do NOT call this tool repeatedly to poll. " +
    "Only use this for one-off diagnostics when you suspect a task may have failed silently after a long time.",
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
    const registry = context.taskRegistry;

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
      // ── New TaskRunner interface ──
      if (isNewRunner(registry)) {
        if (taskId) {
          const info = registry.getStatus(taskId);
          if (!info) {
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
              taskId: info.taskId,
              state: "running",
              description: info.description,
              taskType: info.taskType,
              source: info.source,
              startedAt: info.startedAt,
            },
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        const tasks = registry.listAll().map((info) => ({
          taskId: info.taskId,
          state: "running",
          description: info.description,
          taskType: info.taskType,
          source: info.source,
          startedAt: info.startedAt,
        }));

        return {
          success: true,
          result: { tasks, activeCount: registry.activeCount, totalCount: tasks.length },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // ── Old TaskRegistry interface ──
      if (isOldRegistry(registry)) {
        if (taskId) {
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
      }

      // Unknown registry type
      return {
        success: false,
        error: "Unknown task registry type",
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
