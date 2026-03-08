/**
 * subagent_status — query the runtime status of spawned subagents.
 *
 * Reads from the in-memory subagent registry (via ToolContext) to show
 * currently active subagents. Use this when a spawned subagent's result hasn't
 * come back and you need to check on it.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

export const subagent_status: Tool = {
  name: "subagent_status",
  description:
    "Check the runtime status of spawned subagents. Shows all in-memory subagents with their current state. " +
    "IMPORTANT: Subagent results arrive automatically via notification — do NOT call this tool repeatedly to poll. " +
    "Only use this for one-off diagnostics when you suspect a subagent may have failed silently after a long time.",
  category: ToolCategory.DATA,
  parameters: z.object({
    subagentId: z
      .string()
      .optional()
      .describe("Optional: query a specific subagent by ID. If omitted, lists all subagents."),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { subagentId } = params as { subagentId?: string };
    const registry = context.subagentRegistry;

    if (!registry) {
      return {
        success: false,
        error: "subagent management not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      if (subagentId) {
        const info = registry.getStatus(subagentId);
        if (!info) {
          return {
            success: true,
            result: { subagentId, status: "not_found", message: "Subagent not in registry (may have been cleaned up or never existed)" },
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          success: true,
          result: {
            subagentId: info.subagentId,
            state: "running",
            description: info.description,
            agentType: info.agentType,
            source: info.source,
            startedAt: info.startedAt,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const subagents = registry.listAll().map((info) => ({
        subagentId: info.subagentId,
        state: "running",
        description: info.description,
        agentType: info.agentType,
        source: info.source,
        startedAt: info.startedAt,
      }));

      return {
        success: true,
        result: { subagents, activeCount: registry.activeCount, totalCount: subagents.length },
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
