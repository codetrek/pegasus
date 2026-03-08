/**
 * use_skill — invoke a skill by name.
 *
 * Self-executing: looks up the skill via skillRegistry, then either:
 * - Returns an error if skill not found
 * - Forks a background task for fork-context skills
 * - Returns the skill body inline for inline-context skills
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
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { skill: skillName, args: skillArgs } = params as { skill: string; args?: string };

    const registry = context.skillRegistry;
    if (!registry) {
      return {
        success: false,
        error: "skillRegistry not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const skill = registry.get(skillName);
    if (!skill) {
      return {
        success: false,
        error: `Skill "${skillName}" not found`,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      if (skill.context === "fork") {
        // Fork: submit as background task
        const taskRegistry = context.taskRegistry;
        if (!taskRegistry) {
          return {
            success: false,
            error: "taskRegistry not available for fork skill execution",
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        const body = registry.loadBody(skillName, skillArgs);
        const taskType = skill.agent || "general";
        const taskId = taskRegistry.submit(body ?? "", "skill:" + skillName, taskType, `Skill: ${skillName}`);

        // Start tick manager to poll for task completion
        const tick = context.tickManager;
        if (tick) tick.start();

        return {
          success: true,
          result: { taskId, status: "spawned", skill: skillName },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // Inline: return skill body as result
      const body = registry.loadBody(skillName, skillArgs);
      return {
        success: true,
        result: body ?? `Skill "${skillName}" body could not be loaded`,
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
