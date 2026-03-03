/**
 * reload_skills — signal MainAgent to reload the SkillRegistry.
 *
 * Called by skills (e.g. clawhub) after installing, updating, or removing skills.
 * MainAgent intercepts this tool call and:
 *   1. Reloads its own SkillRegistry from all skill directories
 *   2. Rebuilds the system prompt (so the LLM sees updated skill metadata)
 *   3. Broadcasts skills_reload to all project Workers
 *
 * This is a signal tool — the actual reload logic is in MainAgent, not here.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

export const reload_skills: Tool = {
  name: "reload_skills",
  description:
    "Reload the skill registry after installing, updating, or removing skills. " +
    "Call this after any operation that changes skill files on disk.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({}),
  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    return {
      success: true,
      result: { action: "reload_skills" },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
