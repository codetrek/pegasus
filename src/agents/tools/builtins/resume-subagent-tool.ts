/**
 * resume_subagent tool — resume a completed sub-agent with new input.
 *
 * Self-executing: calls taskRegistry.resume() and tickManager.start()
 * directly, eliminating the need for MainAgent signal interception.
 *
 * Now backed by TaskRunner.resume() instead of SubAgentManager.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { getLogger } from "../../../infra/logger.ts";

const logger = getLogger("resume_subagent");

export const resume_subagent: Tool = {
  name: "resume_subagent",
  description:
    "Resume a completed sub-agent with new input. " +
    "Restores its full session history.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    subagent_id: z.string().describe("The sub-agent ID to resume"),
    input: z.string().describe("New instructions"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { subagent_id, input } = params as {
      subagent_id: string;
      input: string;
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
      await registry.resume(subagent_id, input);

      // Start tick manager to poll for task completion
      const tick = context.tickManager;
      if (tick) tick.start();

      logger.info({ subagentId: subagent_id }, "subagent_resumed");

      return {
        success: true,
        result: { subagentId: subagent_id, status: "resumed" },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      logger.warn({ subagentId: subagent_id, error: (err as Error).message }, "subagent_resume_failed");
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
