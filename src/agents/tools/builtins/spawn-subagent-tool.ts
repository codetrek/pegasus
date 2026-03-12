/**
 * spawn_subagent tool — launch a sub-agent.
 *
 * Self-executing: collects memory snapshot, calls subagentRegistry.submit().
 * Tick is handled automatically by Agent when subagents are spawned.
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

    const registry = context.subagentRegistry;
    if (!registry) {
      return {
        success: false,
        error: "subagentRegistry not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      // Collect memory snapshot for sub-agent context
      const getSnapshot = context.getMemorySnapshot;
      const memorySnapshot = getSnapshot ? await getSnapshot() : undefined;

      const subagentId = registry.submit(input, context.agentId, type ?? "general", description, {
        memorySnapshot,
        depth: 1,
      });

      logger.info({ subagentId, description, type }, "subagent_spawned");

      return {
        success: true,
        result: {
          subagentId,
          status: "spawned",
          type: type ?? "general",
          description,
          hint: `To follow up on this work later, use resume_subagent("${subagentId}", "your new instructions").`,
        },
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
