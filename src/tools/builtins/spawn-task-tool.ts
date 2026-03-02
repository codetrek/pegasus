/**
 * spawn_task tool — signals intent to launch a background task.
 *
 * The MainAgent intercepts the result and spawns the actual task
 * via the existing Task System (Agent).
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

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

    // spawn_task doesn't execute — it signals intent.
    // The MainAgent intercepts this tool result and spawns the actual task.
    return {
      success: true,
      result: {
        action: "spawn_task",
        description,
        input,
        type,
        taskId: context.taskId, // placeholder, MainAgent replaces with real taskId
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
