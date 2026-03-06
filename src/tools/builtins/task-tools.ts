/**
 * Task tools — list and replay historical task conversations.
 *
 * Reads from the task index (index.jsonl) and SessionStore (current.jsonl)
 * written by TaskRunner.
 */

import { z } from "zod";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import { SessionStore } from "../../session/store.ts";

// ── Shared index reader ──────────────────────────

interface IndexEntry {
  taskId: string;
  date: string;
  description?: string;
  taskType?: string;
  source?: string;
}

async function loadIndex(tasksDir: string): Promise<IndexEntry[]> {
  const indexPath = path.join(tasksDir, "index.jsonl");
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

// ── task_list ──────────────────────────────────

export const task_list: Tool = {
  name: "task_list",
  description: "List historical tasks for a date. Returns task IDs, descriptions, and types.",
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

    if (!context.tasksDir) {
      return {
        success: false,
        error: "ToolContext.tasksDir is required but missing",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const tasksDir = context.tasksDir;
    const targetDate = date ?? new Date().toISOString().slice(0, 10);

    try {
      const entries = await loadIndex(tasksDir);
      const tasks = entries
        .filter((e) => e.date === targetDate)
        .map((e) => ({
          taskId: e.taskId,
          description: e.description ?? "",
          taskType: e.taskType ?? "general",
          source: e.source ?? "",
        }));

      return {
        success: true,
        result: tasks,
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

// ── task_replay ──────────────────────────────────

export const task_replay: Tool = {
  name: "task_replay",
  description: "Replay a past task's full conversation by ID. Use to review what a previous task did.",
  category: ToolCategory.DATA,
  parameters: z.object({
    taskId: z.string().describe("The task ID to replay"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { taskId } = params as { taskId: string };

    if (!context.tasksDir) {
      return {
        success: false,
        error: "ToolContext.tasksDir is required but missing",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const tasksDir = context.tasksDir;

    try {
      // Look up task date from index
      const entries = await loadIndex(tasksDir);
      const entry = entries.find((e) => e.taskId === taskId);
      if (!entry) {
        return {
          success: false,
          error: `Task "${taskId}" not found in index`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // Load session from SessionStore
      const sessionDir = path.join(tasksDir, entry.date, taskId);
      const store = new SessionStore(sessionDir);
      const messages = await store.load();

      return {
        success: true,
        result: messages,
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
