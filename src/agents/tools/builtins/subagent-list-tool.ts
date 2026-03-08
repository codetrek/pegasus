/**
 * Subagent list tool — list historical subagent conversations.
 *
 * Reads from the subagent index (index.jsonl) written by Agent's
 * subagent management.
 */

import { z } from "zod";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";

// ── Shared index reader ──────────────────────────

interface IndexEntry {
  subagentId: string;
  date: string;
  description?: string;
  taskType?: string;
  source?: string;
}

async function loadIndex(subagentsDir: string): Promise<IndexEntry[]> {
  const indexPath = path.join(subagentsDir, "index.jsonl");
  try {
    const content = await readFile(indexPath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IndexEntry);
  } catch {
    return [];
  }
}

// ── subagent_list ──────────────────────────────────

export const subagent_list: Tool = {
  name: "subagent_list",
  description: "List historical subagents for a date. Returns subagent IDs, descriptions, and types.",
  category: ToolCategory.DATA,
  parameters: z.object({
    date: z
      .string()
      .optional()
      .describe("Date in YYYY-MM-DD format (defaults to today)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { date } = params as { date?: string };

    if (!context.subagentsDir) {
      return {
        success: false,
        error: "ToolContext.subagentsDir is required but missing",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const subagentsDir = context.subagentsDir;
    const targetDate = date ?? new Date().toISOString().slice(0, 10);

    try {
      const entries = await loadIndex(subagentsDir);
      const subagents = entries
        .filter((e) => e.date === targetDate)
        .map((e) => ({
          subagentId: e.subagentId,
          description: e.description ?? "",
          taskType: e.taskType ?? "general",
          source: e.source ?? "",
        }));

      return {
        success: true,
        result: subagents,
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
