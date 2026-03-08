/**
 * session_archive_read — read a previous archived session file.
 *
 * Only reads from the session directory. Rejects path traversal
 * and reading current.jsonl (which is the active session).
 */

import { z } from "zod";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const session_archive_read: Tool = {
  name: "session_archive_read",
  description:
    "Read a previous archived session file. Use this when the conversation summary lacks detail you need. Only the most recent archive is typically referenced in the compact metadata.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    file: z
      .string()
      .describe("Archive filename, e.g. '20260225T143000.jsonl'"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { file } = params as { file: string };

    if (!context.sessionDir) {
      return {
        success: false,
        error: "ToolContext.sessionDir is required but missing",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    // Reject current.jsonl
    if (file === "current.jsonl") {
      return {
        success: false,
        error:
          "Cannot read current.jsonl — it is the active session, not an archive",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    // Path traversal check
    const resolved = path.resolve(context.sessionDir, file);
    if (!resolved.startsWith(path.resolve(context.sessionDir) + "/")) {
      return {
        success: false,
        error: `Path "${file}" escapes session directory`,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const content = await readFile(resolved, "utf-8");
      return {
        success: true,
        result: content,
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
