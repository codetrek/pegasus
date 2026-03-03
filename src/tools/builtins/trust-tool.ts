/**
 * trust — manage trusted owner identities for channel security.
 *
 * Allows the MainAgent to add, remove, or list owner identities
 * that control who is recognized as a trusted operator per channel.
 * Delegates to OwnerStore (via ToolContext) for persistence.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

/** Loose interface for OwnerStore methods used by this tool. */
interface OwnerStoreLike {
  add(channelType: string, userId: string): void;
  remove(channelType: string, userId: string): void;
  listAll(): Record<string, string[]>;
}

export const trust: Tool = {
  name: "trust",
  description:
    "Manage trusted owner identities for channel security. Actions: add (register a userId as owner for a channel), remove (unregister), list (show all trusted identities).",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    action: z.enum(["add", "remove", "list"]),
    channel: z.string().optional().describe("Channel type (e.g. 'discord', 'slack'). Required for add/remove."),
    userId: z.string().optional().describe("User ID to add/remove as owner. Required for add/remove."),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { action, channel, userId } = params as {
      action: "add" | "remove" | "list";
      channel?: string;
      userId?: string;
    };

    const store = context.ownerStore as OwnerStoreLike | undefined;
    if (!store) {
      return {
        success: false,
        error: "ownerStore not available in this context",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      if (action === "list") {
        const channels = store.listAll();
        return {
          success: true,
          result: { action: "list", channels },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // add / remove require channel + userId
      if (!channel) {
        return {
          success: false,
          error: `channel is required for "${action}" action`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }
      if (!userId) {
        return {
          success: false,
          error: `userId is required for "${action}" action`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      if (action === "add") {
        store.add(channel, userId);
        return {
          success: true,
          result: { action: "add", channel, userId, status: "added" },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // action === "remove"
      store.remove(channel, userId);
      return {
        success: true,
        result: { action: "remove", channel, userId, status: "removed" },
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
