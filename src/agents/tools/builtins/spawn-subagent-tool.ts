/**
 * spawn_subagent tool — launch a sub-agent via TaskRunner.
 *
 * Self-executing: collects memory snapshot, calls taskRegistry.submit(),
 * and starts tickManager directly, eliminating signal interception.
 *
 * Replaces both the old spawn_task and spawn_subagent (SubAgentManager)
 * tools with a unified interface backed by TaskRunner.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { getLogger } from "../../../infra/logger.ts";

const logger = getLogger("spawn_subagent");

export const spawn_subagent: Tool = {
  name: "spawn_subagent",
  description:
    "Launch a sub-agent to handle work in the background. " +
    "Types: general (full access), explore (read-only), plan (analysis + memory). " +
    "The sub-agent runs autonomously and results arrive via notification.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    description: z
      .string()
      .describe("Short label for this sub-agent's mission"),
    input: z.string().describe("Detailed instructions"),
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

    const registry = context.taskRegistry;
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
      // Collect memory snapshot for sub-agent context
      const getSnapshot = context.getMemorySnapshot;
      const memorySnapshot = getSnapshot ? await getSnapshot() : undefined;

      const taskId = registry.submit(input, context.taskId, type ?? "general", description, {
        memorySnapshot,
        depth: 1,
      });

      // Start tick manager to poll for task completion
      const tick = context.tickManager;
      if (tick) tick.start();

      logger.info({ subagentId: taskId, description, type }, "subagent_spawned");

      return {
        success: true,
        result: { subagentId: taskId, status: "spawned", type: type ?? "general", description },
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
