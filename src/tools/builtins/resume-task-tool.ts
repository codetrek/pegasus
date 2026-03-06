/**
 * resume_task tool — resume a completed task with new instructions.
 *
 * Self-executing: calls taskRegistry.resume() and tickManager.start()
 * directly, eliminating the need for MainAgent signal interception.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("resume_task");

/** Loose interface for TaskRunner methods used by this tool. */
interface TaskRegistryLike {
  resume(taskId: string, input: string): Promise<void>;
}

/** Loose interface for TickManager methods used by this tool. */
interface TickManagerLike {
  start(): void;
}

export const resume_task: Tool = {
  name: "resume_task",
  description:
    "Resume a previously completed task with new instructions. " +
    "The task continues with its full conversation history.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    task_id: z.string().describe("ID of the completed task to resume"),
    input: z.string().describe("New instructions for the task"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { task_id, input } = params as {
      task_id: string;
      input: string;
    };

    const registry = context.taskRegistry as TaskRegistryLike | undefined;
    if (!registry) {
      return {
        success: false,
        error: "taskRegistry not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      await registry.resume(task_id, input);

      // Start tick manager to poll for task completion
      const tick = context.tickManager as TickManagerLike | undefined;
      if (tick) tick.start();

      logger.info({ taskId: task_id, input }, "task_resumed");

      return {
        success: true,
        result: { taskId: task_id, status: "resumed" },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      logger.warn({ taskId: task_id, error: (err as Error).message }, "task_resume_failed");
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
