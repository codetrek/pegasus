/**
 * resume_subagent tool — resume a completed SubAgent with new input.
 *
 * Self-executing: calls subAgentManager.resume() and tickManager.start()
 * directly, eliminating the need for MainAgent signal interception.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

/** Loose interface for SubAgentManager methods used by this tool. */
interface SubAgentManagerLike {
  resume(subagentId: string, input: string): void;
}

/** Loose interface for TickManager methods used by this tool. */
interface TickManagerLike {
  start(): void;
}

export const resume_subagent: Tool = {
  name: "resume_subagent",
  description:
    "Resume a completed SubAgent with new input. " +
    "Restores its full session history.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    subagent_id: z.string().describe("The SubAgent ID to resume"),
    input: z.string().describe("New instructions"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { subagent_id, input } = params as {
      subagent_id: string;
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
      manager.resume(subagent_id, input);

      // Start tick manager to poll for subagent completion
      const tick = context.tickManager as TickManagerLike | undefined;
      if (tick) tick.start();

      return {
        success: true,
        result: { subagentId: subagent_id, status: "resumed" },
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
