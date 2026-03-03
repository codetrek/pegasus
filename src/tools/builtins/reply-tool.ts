/**
 * reply tool — signals intent to send a message to the user.
 *
 * The MainAgent intercepts the result and delivers it to the
 * appropriate channel. This is the ONLY way for the agent to
 * produce user-visible output; all other text is inner monologue.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const reply: Tool = {
  name: "reply",
  description:
    "Speak to the user. This is the ONLY way to produce user-visible output. Your text output is inner monologue — use this tool when you want the user to hear you.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    text: z.string().describe("What to say to the user"),
    channelType: z
      .string()
      .describe("Channel type to reply to — use the value from the user message metadata (e.g. 'cli', 'telegram', 'slack')"),
    channelId: z
      .string()
      .describe("Channel instance ID — use the value from the user message metadata (e.g. 'main', 'C123')"),
    replyTo: z
      .string()
      .optional()
      .describe("Thread or conversation ID — use the value from the user message metadata if present"),
    imageIds: z
      .array(z.string())
      .optional()
      .describe(
        "Image IDs to send with the reply. Use IDs from [img://ID] references in conversation.",
      ),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { text, channelType, channelId, replyTo, imageIds } = params as {
      text: string;
      channelType: string;
      channelId: string;
      replyTo?: string;
      imageIds?: string[];
    };

    // reply doesn't deliver the message — it signals intent.
    // The MainAgent intercepts this tool result and routes to the channel.
    return {
      success: true,
      result: { action: "reply", text, channelType, channelId, replyTo, imageIds },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
