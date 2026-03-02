/**
 * Background execution tools — bg_run, bg_output, bg_stop.
 *
 * Three meta tools that enable background execution of any existing tool.
 * The cognitive loop is not modified; these tools are synchronous from
 * the loop's perspective.
 */

import { z } from "zod";
import { MAX_TOOL_TIMEOUT } from "../background.ts";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

// ── bg_run ──────────────────────────────────────

export const bg_run: Tool = {
  name: "bg_run",
  description:
    "Run a tool in the background. Returns immediately with a bgTaskId. Use for long-running operations (>30s). Retrieve results with bg_output, or cancel with bg_stop.",
  category: "system" as ToolCategory,
  parameters: z.object({
    tool: z.string().describe("Name of the tool to execute in the background"),
    params: z.record(z.unknown()).describe("Parameters for the tool"),
    timeout: z
      .number()
      .positive()
      .max(MAX_TOOL_TIMEOUT)
      .optional()
      .describe(`Execution timeout in ms (default: config tools.timeout, max: ${MAX_TOOL_TIMEOUT})`),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { tool, params: toolParams, timeout } = params as {
      tool: string;
      params: Record<string, unknown>;
      timeout?: number;
    };

    const manager = context.backgroundManager;
    if (!manager) {
      return {
        success: false,
        error: "Background task execution is not available",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const bgTaskId = manager.run(tool, toolParams, context, timeout);

    return {
      success: true,
      result: { bgTaskId, tool, status: "running" },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── bg_output ───────────────────────────────────

export const bg_output: Tool = {
  name: "bg_output",
  description:
    "Get the result of a background task. By default, blocks until the task completes. " +
    "Use block=false for a non-blocking status check.",
  category: "system" as ToolCategory,
  parameters: z.object({
    bgTaskId: z.string().describe("Task ID from bg_run"),
    block: z
      .boolean()
      .optional()
      .default(true)
      .describe("Wait for completion (default: true)"),
    timeout: z
      .number()
      .positive()
      .max(MAX_TOOL_TIMEOUT)
      .optional()
      .default(30000)
      .describe("Max wait time in ms when block=true (default: 30000)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { bgTaskId, block, timeout } = params as {
      bgTaskId: string;
      block: boolean;
      timeout: number;
    };

    const manager = context.backgroundManager;
    if (!manager) {
      return {
        success: false,
        error: "Background task execution is not available",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const status = block
      ? await manager.waitFor(bgTaskId, timeout)
      : manager.getStatus(bgTaskId);

    return {
      success: true,
      result: status,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── bg_stop ─────────────────────────────────────

export const bg_stop: Tool = {
  name: "bg_stop",
  description: "Terminate a running background task.",
  category: "system" as ToolCategory,
  parameters: z.object({
    bgTaskId: z.string().describe("Task ID from bg_run"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { bgTaskId } = params as { bgTaskId: string };

    const manager = context.backgroundManager;
    if (!manager) {
      return {
        success: false,
        error: "Background task execution is not available",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const stopped = manager.stop(bgTaskId);

    return {
      success: true,
      result: { bgTaskId, stopped },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
