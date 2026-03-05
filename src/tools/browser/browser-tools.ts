/**
 * Browser tools — Playwright-based browser automation for LLM agents.
 *
 * Each tool wraps a BrowserManager method, converting ARIA snapshots
 * into LLM-readable text with ref-based element selectors (e1, e2, …).
 */

import { z } from "zod";
import { readFile, unlink } from "node:fs/promises";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import type { BrowserManager } from "./browser-manager.ts";
import type { ImageAttachment } from "../../media/types.ts";

// ── Helper ──────────────────────────────────────

/**
 * Retrieve BrowserManager from the tool context.
 * Uses a type assertion since the `browserManager` field is added
 * to ToolContext in a later integration step.
 */
function getBrowserManager(context: ToolContext): BrowserManager {
  const manager = context.browserManager as BrowserManager | undefined;
  if (!manager) {
    throw new Error(
      "Browser not available. Configure tools.browser in config.yml.",
    );
  }
  return manager;
}

// ── browser_navigate ────────────────────────────

export const browser_navigate: Tool = {
  name: "browser_navigate",
  description:
    "Navigate to a URL and return the page's accessibility snapshot with ref numbers. " +
    "Use these refs (e1, e2...) to interact with elements via browser_click or browser_type.",
  category: ToolCategory.BROWSER,
  parameters: z.object({
    url: z.string().describe("URL to navigate to"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const { url } = params as { url: string };
      const result = await manager.navigate(context.taskId, url);
      return {
        success: true,
        result: { snapshot: result.snapshot, truncated: result.truncated },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_snapshot ────────────────────────────

export const browser_snapshot: Tool = {
  name: "browser_snapshot",
  description:
    "Get the current page's accessibility snapshot with fresh ref numbers. " +
    "Refs from previous snapshots are invalidated — always use refs from the latest snapshot.",
  category: ToolCategory.BROWSER,
  parameters: z.object({}),
  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const result = await manager.takeSnapshot(context.taskId);
      return {
        success: true,
        result: { snapshot: result.snapshot, truncated: result.truncated },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_screenshot ──────────────────────────

export const browser_screenshot: Tool = {
  name: "browser_screenshot",
  description:
    "Take a screenshot of the current page and save to disk. " +
    "Also returns the accessibility snapshot.",
  category: ToolCategory.BROWSER,
  parameters: z.object({
    fullPage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Capture the full scrollable page (default: false)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const { fullPage } = params as { fullPage: boolean };
      const result = await manager.screenshot(context.taskId, fullPage);

      // If storeImage is available, persist screenshot in ImageManager and
      // return image data inline so the LLM can see it.
      let images: ImageAttachment[] | undefined;
      if (context.storeImage) {
        const buffer = await readFile(result.screenshotPath);
        const ref = await context.storeImage(buffer, "image/png", "browser");
        images = [
          {
            id: ref.id,
            mimeType: "image/png",
            data: buffer.toString("base64"),
          },
        ];
        // Clean up the temp file — image is now in ImageManager
        await unlink(result.screenshotPath).catch(() => {});
      }

      return {
        success: true,
        result: {
          screenshotPath: result.screenshotPath,
          snapshot: result.snapshot,
          truncated: result.truncated,
          message: `Screenshot saved to ${result.screenshotPath}`,
        },
        ...(images ? { images } : {}),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_click ───────────────────────────────

export const browser_click: Tool = {
  name: "browser_click",
  description:
    "Click an element by its ref number from the most recent snapshot. " +
    "Returns a new page snapshot with updated refs — previous refs are invalidated after each action.",
  category: ToolCategory.BROWSER,
  parameters: z.object({
    ref: z
      .string()
      .describe("Element ref from snapshot (e.g. 'e3')"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const { ref } = params as { ref: string };
      const result = await manager.click(context.taskId, ref);
      return {
        success: true,
        result: { snapshot: result.snapshot, truncated: result.truncated },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_type ────────────────────────────────

export const browser_type: Tool = {
  name: "browser_type",
  description:
    "Type text into an input element by its ref number. " +
    "Set submit=true to press Enter after typing. " +
    "Returns a new page snapshot with updated refs.",
  category: ToolCategory.BROWSER,
  parameters: z.object({
    ref: z.string().describe("Element ref from snapshot (e.g. 'e1')"),
    text: z.string().describe("Text to type into the element"),
    submit: z
      .boolean()
      .optional()
      .default(false)
      .describe("Press Enter after typing (default: false)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const { ref, text, submit } = params as {
        ref: string;
        text: string;
        submit: boolean;
      };
      const result = await manager.type(context.taskId, ref, text, submit);
      return {
        success: true,
        result: { snapshot: result.snapshot, truncated: result.truncated },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_scroll ──────────────────────────────

export const browser_scroll: Tool = {
  name: "browser_scroll",
  description:
    "Scroll the page up or down and return the updated page snapshot with fresh refs. " +
    "Amount controls scroll distance in viewport-heights (default: 3).",
  category: ToolCategory.BROWSER,
  parameters: z.object({
    direction: z
      .enum(["up", "down"])
      .describe("Scroll direction"),
    amount: z
      .number()
      .int()
      .positive()
      .optional()
      .default(3)
      .describe("Scroll distance in viewport-heights (default: 3)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      const { direction, amount } = params as {
        direction: "up" | "down";
        amount: number;
      };
      const result = await manager.scroll(context.taskId, direction, amount);
      return {
        success: true,
        result: { snapshot: result.snapshot, truncated: result.truncated },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── browser_close ───────────────────────────────

export const browser_close: Tool = {
  name: "browser_close",
  description:
    "Close the browser session for the current task. Call this when you're done with browser tasks to free resources.",
  category: ToolCategory.BROWSER,
  parameters: z.object({}),
  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const manager = getBrowserManager(context);
      await manager.closeSession(context.taskId);
      return {
        success: true,
        result: { message: "Browser session closed successfully." },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── Aggregate export ────────────────────────────

/** All browser tools as an array for registry registration. */
export const browserTools: Tool[] = [
  browser_navigate,
  browser_snapshot,
  browser_screenshot,
  browser_click,
  browser_type,
  browser_scroll,
  browser_close,
];
