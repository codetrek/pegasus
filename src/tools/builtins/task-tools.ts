/**
 * Task tools — list and replay historical task conversations.
 *
 * These tools expose read-only access to persisted task JSONL logs,
 * allowing the LLM to browse past tasks and replay their messages.
 */

import { z } from "zod";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import { TaskPersister } from "../../task/persister.ts";

// ── task_list ──────────────────────────────────

export const task_list: Tool = {
  name: "task_list",
  description: "List historical tasks for a date. Returns task IDs, descriptions, and statuses.",
  category: ToolCategory.DATA,
  parameters: z.object({
    date: z
      .string()
      .optional()
      .describe("Date in YYYY-MM-DD format (defaults to today)"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { date } = params as { date?: string };
    const effectiveDataDir = process.env.PEGASUS_DATA_DIR ?? "data";
    const tasksDir = path.join(effectiveDataDir, "tasks");
    const targetDate = date ?? new Date().toISOString().slice(0, 10);

    try {
      const index = await TaskPersister.loadIndex(tasksDir);
      const taskIds = [...index.entries()]
        .filter(([, d]) => d === targetDate)
        .map(([id]) => id);

      const summaries: Array<{
        taskId: string;
        description: string;
        inputText: string;
        status: string;
        createdAt: number;
      }> = [];

      for (const taskId of taskIds) {
        const filePath = path.join(tasksDir, targetDate, `${taskId}.jsonl`);
        try {
          const ctx = await TaskPersister.replay(filePath);
          const status = ctx.finalResult
            ? "completed"
            : ctx.error
              ? "failed"
              : "in_progress";
          summaries.push({
            taskId,
            description: ctx.description,
            inputText: ctx.inputText,
            status,
            createdAt: 0,
          });
        } catch {
          // Skip corrupted files
        }
      }

      return {
        success: true,
        result: summaries,
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
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { taskId } = params as { taskId: string };
    const effectiveDataDir = process.env.PEGASUS_DATA_DIR ?? "data";
    const tasksDir = path.join(effectiveDataDir, "tasks");

    try {
      const filePath = await TaskPersister.resolveTaskPath(tasksDir, taskId);
      if (!filePath) {
        return {
          success: false,
          error: `Task "${taskId}" not found in index`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const ctx = await TaskPersister.replay(filePath);
      // Only expose messages to LLM — internal state is hidden
      return {
        success: true,
        result: ctx.messages,
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
