/**
 * reload_skills — reload the SkillRegistry and notify downstream.
 *
 * Self-executing: calls onSkillsReloaded() callback which handles:
 *   1. Reloading the SkillRegistry from all skill directories
 *   2. Rebuilding the system prompt (so LLM sees updated skill metadata)
 *   3. Broadcasting skills_reload to all project Workers
 *
 * The callback returns the new skill count.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

/** Loose type for the onSkillsReloaded callback. */
type OnSkillsReloadedFn = () => number;

export const reload_skills: Tool = {
  name: "reload_skills",
  description:
    "Reload the skill registry after installing, updating, or removing skills. " +
    "Call this after any operation that changes skill files on disk.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({}),
  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    const onReloaded = context.onSkillsReloaded as OnSkillsReloadedFn | undefined;
    if (!onReloaded) {
      return {
        success: false,
        error: "onSkillsReloaded not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const skillCount = onReloaded();

      return {
        success: true,
        result: { reloaded: true, skillCount },
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
