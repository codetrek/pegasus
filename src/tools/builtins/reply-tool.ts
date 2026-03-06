/**
 * reply tool — send a message to the user via the channel adapter.
 *
 * Self-executing: resolves images via resolveImage(), builds an outbound
 * message, and delivers it via onReply(). This is the ONLY way for the
 * agent to produce user-visible output; all other text is inner monologue.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("reply");

/** Loose type for the onReply callback. */
type OnReplyFn = (msg: {
  text: string;
  channel: { type: string; channelId: string; replyTo?: string };
  content?: { text: string; images: Array<{ id: string; data: string; mimeType: string }> };
}) => void;

/** Loose type for the resolveImage callback. */
type ResolveImageFn = (idOrPath: string) => Promise<{ id: string; data: string; mimeType: string } | null>;

export const reply: Tool = {
  name: "reply",
  description:
    "Speak to the user. This is the ONLY way to produce user-visible output. Your text output is inner monologue — use this tool when you want the user to hear you.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    text: z.string().describe("What to say to the user"),
    channelType: z
      .string()
      .describe("Channel type to reply to — REQUIRED, use the value from the user message metadata (e.g. 'cli', 'telegram', 'slack')"),
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
        "Images to send with the reply. Accepts image IDs from [img://ID] references " +
        "OR file paths (e.g., '/tmp/screenshot.png'). " +
        "Images are automatically stored for persistence.",
      ),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { text, channelType, channelId, replyTo, imageIds } = params as {
      text: string;
      channelType: string;
      channelId: string;
      replyTo?: string;
      imageIds?: string[];
    };

    const onReply = context.onReply as OnReplyFn | undefined;
    if (!onReply) {
      return {
        success: false,
        error: "onReply not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      // Resolve images first so failures can be reported in the tool result
      const images: Array<{ id: string; data: string; mimeType: string }> = [];
      const failures: string[] = [];

      if (imageIds?.length) {
        const resolveImage = context.resolveImage as ResolveImageFn | undefined;
        if (resolveImage) {
          for (const idOrPath of imageIds) {
            const img = await resolveImage(idOrPath);
            if (img) {
              images.push(img);
            } else {
              failures.push(idOrPath);
            }
          }
        } else {
          // No resolveImage available — all images fail
          failures.push(...imageIds);
        }
      }

      // Build delivered result
      const delivered: Record<string, unknown> = { delivered: true };
      if (failures.length > 0) {
        delivered.imageFailures = failures.map(f => `Failed to load image: ${f}`);
        logger.warn({ failures }, "reply_image_resolve_failed");
      }

      // Build outbound message
      const outbound: {
        text: string;
        channel: { type: string; channelId: string; replyTo?: string };
        content?: { text: string; images: Array<{ id: string; data: string; mimeType: string }> };
      } = {
        text,
        channel: { type: channelType, channelId, replyTo },
      };

      // Attach resolved images as structured content
      if (images.length > 0) {
        outbound.content = { text, images };
      }

      onReply(outbound);

      return {
        success: true,
        result: delivered,
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
