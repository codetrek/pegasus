/**
 * Tools system - core types and utilities.
 */

import { z } from "zod";
import path from "node:path";
import type { LanguageModel } from "../infra/llm-types.ts";
import type { BackgroundTaskManager } from "./background.ts";
import type { ImageAttachment } from "../media/types.ts";

// ── ToolCategory ─────────────────────────────────────

/**
 * Tool categories. CODE and CUSTOM marked for future extensions.
 */
export enum ToolCategory {
  SYSTEM = "system",
  FILE = "file",
  NETWORK = "network",
  DATA = "data",
  MEMORY = "memory", // M2: long-term memory
  BROWSER = "browser", // Browser automation (Playwright)
  MEDIA = "media", // V1: image/vision tools
  CODE = "code", // Future extension
  MCP = "mcp", // Future extension
  CUSTOM = "custom", // Future extension
}

// ── Tool ───────────────────────────────────────────

/**
 * Tool interface - all tools must implement this.
 */
export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: z.ZodTypeAny;
  /** Pre-computed JSON Schema, skips Zod→JSON Schema conversion in toLLMTools(). Used by MCP tools. */
  parametersJsonSchema?: Record<string, unknown>;
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

// ── ToolResult ───────────────────────────────────

/**
 * Result returned by tool execution.
 * Note: toolName is omitted as it's managed by the caller.
 */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
  images?: ImageAttachment[];
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
}

// ── ToolContext ─────────────────────────────────

/**
 * Context passed to tool execution.
 */
export interface ToolContext {
  taskId: string;
  userId?: string;
  allowedPaths?: string[];
  memoryDir?: string;
  sessionDir?: string;
  tasksDir?: string;
  taskRegistry?: unknown; // TaskRegistry — used by task_status tool (loosely typed to avoid circular imports)
  projectManager?: unknown; // ProjectManager — used by project tools (loosely typed to avoid circular imports)
  browserManager?: unknown; // BrowserManager — used by browser tools (loosely typed to avoid circular imports)
  extractModel?: LanguageModel; // Small model for content extraction (web_fetch)
  backgroundManager?: BackgroundTaskManager; // Background task execution manager (bg_run/bg_output/bg_stop)
  mediaDir?: string; // Directory for media storage (images, etc.)
}

// ── ToolStats ─────────────────────────────────

/**
 * Statistics about tool usage.
 */
export interface ToolStats {
  total: number;
  byCategory: Record<ToolCategory, number>;
  callStats: Record<string, { count: number; failures: number; avgDuration: number }>;
}

// ── Path Security ─────────────────────────────

/**
 * Normalize a file path, resolving relative references.
 * If baseDir is provided, relative paths are resolved against it.
 */
export function normalizePath(pathToNormalize: string, baseDir?: string): string {
  // If baseDir provided and path is relative, resolve against baseDir
  if (baseDir && !pathToNormalize.startsWith("/")) {
    pathToNormalize = path.join(baseDir, pathToNormalize);
  }

  // Use Node's path.resolve to normalize (resolves .. and .)
  const normalized = path.resolve(pathToNormalize);

  return normalized;
}

/**
 * Check if a path is allowed based on a whitelist.
 * Supports both absolute and relative paths.
 * Subdirectories are automatically included.
 */
export function isPathAllowed(pathToCheck: string, allowedPaths: string[]): boolean {
  const normalized = normalizePath(pathToCheck);

  for (const allowedPath of allowedPaths) {
    const normalizedAllowed = normalizePath(allowedPath);

    // Direct match
    if (normalized === normalizedAllowed) {
      return true;
    }

    // Subdirectory match (normalizedAllowed is a prefix)
    if (normalized.startsWith(normalizedAllowed + "/")) {
      return true;
    }
  }

  return false;
}
