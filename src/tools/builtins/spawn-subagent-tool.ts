/**
 * spawn_subagent tool — launch a SubAgent Worker.
 *
 * Self-executing: collects memory snapshot, calls subAgentManager.spawn(),
 * and starts tickManager directly, eliminating signal interception.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

/** Loose interface for SubAgentManager methods used by this tool. */
interface SubAgentManagerLike {
  spawn(description: string, input: string, memorySnapshot?: string): string;
}

/** Loose interface for TickManager methods used by this tool. */
interface TickManagerLike {
  start(): void;
}

/** Loose type for getMemorySnapshot callback. */
type GetMemorySnapshotFn = () => Promise<string | undefined>;

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

    const manager = context.subAgentManager as SubAgentManagerLike | undefined;
    if (!manager) {
      return {
        success: false,
        error: "SubAgentManager not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      // Collect memory snapshot for SubAgent context
      const getSnapshot = context.getMemorySnapshot as GetMemorySnapshotFn | undefined;
      const memorySnapshot = getSnapshot ? await getSnapshot() : undefined;

      const subagentId = manager.spawn(description, input, memorySnapshot);

      // Start tick manager to poll for subagent completion
      const tick = context.tickManager as TickManagerLike | undefined;
      if (tick) tick.start();

      return {
        success: true,
        result: { subagentId, status: "spawned", description },
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
