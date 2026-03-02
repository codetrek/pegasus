/**
 * spawn_subagent tool — signals intent to launch a SubAgent Worker.
 *
 * The MainAgent intercepts the result and spawns the actual SubAgent
 * via the SubAgentManager.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const spawn_subagent: Tool = {
  name: "spawn_subagent",
  description:
    "Launch an autonomous SubAgent to handle complex multi-step work. " +
    "The SubAgent can break down tasks, spawn its own AITasks, and coordinate results. " +
    "Use for work requiring decomposition, parallel execution, or multi-step orchestration.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    description: z
      .string()
      .describe("Short label for this SubAgent's mission"),
    input: z.string().describe("Detailed instructions"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { description, input } = params as {
      description: string;
      input: string;
    };

    // spawn_subagent doesn't execute — it signals intent.
    // The MainAgent intercepts this tool result and spawns the actual SubAgent.
    return {
      success: true,
      result: {
        action: "spawn_subagent",
        description,
        input,
        taskId: context.taskId, // placeholder, MainAgent replaces with real subagentId
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
