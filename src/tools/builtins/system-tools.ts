/**
 * System tools - time, environment, and system utilities.
 */

import { z } from "zod";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

// ── current_time ─────────────────────────────────

export const current_time: Tool = {
  name: "current_time",
  description: "Get current date and time. Returns ISO timestamp and formatted local time.",
  category: "system" as ToolCategory,
  parameters: z.object({
    timezone: z.string().optional().describe("IANA timezone (e.g., 'UTC', 'America/New_York')"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { timezone } = params as { timezone?: string };
    const now = new Date();
    const iso = now.toISOString();

    let formattedTime = iso;
    if (timezone) {
      try {
        formattedTime = now.toLocaleString("en-US", { timeZone: timezone });
      } catch {
        // Invalid timezone, fall back to UTC
        formattedTime = now.toUTCString();
      }
    }

    return {
      success: true,
      result: {
        timestamp: now.getTime(),
        iso,
        timezone: timezone || "UTC",
        formatted: formattedTime,
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── sleep ───────────────────────────────────────

export const sleep: Tool = {
  name: "sleep",
  description: "Pause execution for the given duration. Use only when polling or rate-limiting.",
  category: "system" as ToolCategory,
  parameters: z.object({
    duration: z.number().positive().describe("Duration in seconds"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { duration } = params as { duration: number };
    const durationMs = duration * 1000;
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    return {
      success: true,
      result: { slept: duration },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── get_env ────────────────────────────────────

export const get_env: Tool = {
  name: "get_env",
  description: "Read an environment variable. Returns null if not set.",
  category: "system" as ToolCategory,
  parameters: z.object({
    key: z.string().describe("Environment variable name"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { key } = params as { key: string };
    const value = process.env[key] ?? null;

    return {
      success: true,
      result: { key, value },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── set_env ────────────────────────────────────

export const set_env: Tool = {
  name: "set_env",
  description: "Set an environment variable for the current process only. Does not persist across restarts.",
  category: "system" as ToolCategory,
  parameters: z.object({
    key: z.string().describe("Environment variable name"),
    value: z.string().describe("Value to set"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { key, value } = params as { key: string; value: string };
    const previous = process.env[key] ?? null;
    process.env[key] = value;

    return {
      success: true,
      result: { key, previous, current: value },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
