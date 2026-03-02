/**
 * use_skill — invoke a skill by name.
 *
 * Signal tool: returns skill metadata for MainAgent to intercept.
 * MainAgent handles actual execution (inline or fork).
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

export const use_skill: Tool = {
  name: "use_skill",
  description: "Invoke a registered skill by name. Available skills are listed in the Skills section.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    skill: z.string().describe("Skill name to invoke"),
    args: z.string().optional().describe("Arguments to pass to the skill"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { skill, args } = params as { skill: string; args?: string };

    return {
      success: true,
      result: { action: "use_skill", skill, args },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
