/**
 * spawn_task tool — launch a background task via TaskRunner.
 *
 * Self-executing: calls taskRegistry.submit() and tickManager.start()
 * directly, eliminating the need for MainAgent signal interception.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

/** Loose interface for TaskRunner methods used by this tool. */
interface TaskRegistryLike {
  submit(input: string, source: string, type: string, description: string): string;
}

/** Loose interface for TickManager methods used by this tool. */
interface TickManagerLike {
  start(): void;
}

export const spawn_task: Tool = {
  name: "spawn_task",
  description:
    "Launch a background task. Types: explore (read-only), plan (analysis + memory), general (full access). Results arrive in your session automatically.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    description: z.string().describe(
      "Short label for this task (for your own reference when reviewing task list later)"
    ),
    input: z
      .string()
      .describe("Detailed instructions for the task — include all necessary context, requirements, and constraints"),
    type: z
      .enum(["general", "explore", "plan"])
      .default("general")
      .describe(
        "Task type: 'explore' for research (read-only), 'plan' for analysis/planning, 'general' for full capabilities",
      ),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { description, input, type = "general" } = params as {
      description: string;
      input: string;
      type?: string;
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
      const taskType = type ?? "general";
      const taskId = registry.submit(input, context.taskId, taskType, description);

      // Start tick manager to poll for task completion
      const tick = context.tickManager as TickManagerLike | undefined;
      if (tick) tick.start();

      return {
        success: true,
        result: { taskId, status: "spawned", type: taskType, description },
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
