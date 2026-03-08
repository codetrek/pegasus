/**
 * Tools system - core types and utilities.
 */

import { z } from "zod";
import path from "node:path";
import type { LanguageModel } from "../../infra/llm-types.ts";
import type { BackgroundTaskManager } from "./background.ts";
import type { ImageAttachment } from "../../media/types.ts";
import type {
  SubagentRegistryLike,
  TickManagerLike,
  OwnerStoreLike,
  SkillRegistryLike,
  ProjectManagerLike,
  ProjectAdapterLike,
  BrowserManagerLike,
  OnReplyFn,
  ResolveImageFn,
  GetMemorySnapshotFn,
  OnSkillsReloadedFn,
  StoreImageFn,
} from "./tool-context.ts";

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
  agentId: string;
  allowedPaths?: string[];
  memoryDir?: string;
  sessionDir?: string;
  subagentsDir?: string;
  subagentRegistry?: SubagentRegistryLike;
  projectManager?: ProjectManagerLike;
  ownerStore?: OwnerStoreLike;
  browserManager?: BrowserManagerLike;
  extractModel?: LanguageModel; // Small model for content extraction (web_fetch)
  backgroundManager?: BackgroundTaskManager; // Background task execution manager (bg_run/bg_output/bg_stop)
  mediaDir?: string; // Directory for media storage (images, etc.)
  /** Store an image via ImageManager. Injected by Agent/MainAgent so tools can persist images
   *  without direct ImageManager references (works across thread boundaries). */
  storeImage?: StoreImageFn;
  /** Reply callback — routes outbound message to channel adapter. */
  onReply?: OnReplyFn;
  /** Resolve an image by ID or file path. Returns base64 data or null. */
  resolveImage?: ResolveImageFn;
  /** SkillRegistry for skill lookup and body loading. */
  skillRegistry?: SkillRegistryLike;
  /** TickManager for starting periodic status checks after spawning work. */
  tickManager?: TickManagerLike;
  /** Get memory snapshot for SubAgent context injection. */
  getMemorySnapshot?: GetMemorySnapshotFn;
  /** Callback when skills are reloaded — triggers prompt rebuild + worker broadcast. Returns new skill count. */
  onSkillsReloaded?: OnSkillsReloadedFn;
  /** ProjectAdapter for starting/stopping project Workers. */
  projectAdapter?: ProjectAdapterLike;
  /** Notify callback — used by notify tool for self-executing behavior. */
  onNotify?: (message: string) => void;
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
