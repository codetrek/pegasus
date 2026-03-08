/**
 * notify tool — Subagent → MainAgent communication channel.
 *
 * Allows a running subagent to send messages back to the MainAgent:
 * progress updates, interim results, clarification requests, warnings, etc.
 *
 * Self-executing: if context.onNotify is set, calls it directly and returns { notified: true }.
 * Fallback: if context.onNotify is not set, returns a signal result for the agent to intercept
 * (backward compatibility).
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const notify: Tool = {
  name: "notify",
  description:
    "Send a message to the main agent. Use for progress updates, interim results, or clarification requests during long-running tasks.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    message: z
      .string()
      .describe("Message to send to the main agent"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { message } = params as { message: string };

    // Self-executing: call onNotify directly if available
    if (context.onNotify) {
      context.onNotify(message);
      return {
        success: true,
        result: { notified: true },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    // Fallback: signal tool behavior (agent intercepts this result)
    return {
      success: true,
      result: { action: "notify", message, agentId: context.agentId },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
