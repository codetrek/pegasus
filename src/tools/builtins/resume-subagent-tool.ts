/**
 * resume_subagent tool — signals intent to resume a completed SubAgent.
 *
 * The MainAgent intercepts the result and resumes the SubAgent
 * with its full session history via SubAgentManager.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

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
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { subagent_id, input } = params as {
      subagent_id: string;
      input: string;
    };

    // resume_subagent doesn't execute the resume — it signals intent.
    // The MainAgent intercepts this tool result and calls SubAgentManager.resume().
    return {
      success: true,
      result: {
        action: "resume_subagent",
        subagent_id,
        input,
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
