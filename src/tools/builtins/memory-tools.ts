/**
 * Memory tools — long-term memory as markdown files.
 *
 * Storage layout:
 *   data/memory/
 *   ├── facts/       (key-value fact files)
 *   └── episodes/    (monthly experience summaries)
 *
 * Each file has a `> Summary: ...` line used as the index entry.
 */

import { z } from "zod";
import path from "node:path";
import { readdir, access, mkdir } from "node:fs/promises";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

/** Allowed fact file names. The LLM cannot create arbitrary fact files. */
export const ALLOWED_FACT_FILES = new Set(["user.md", "memory.md"]);

/** Maximum total size of all fact files combined (bytes). */
export const FACTS_BUDGET_BYTES = 15_360; // 15KB

/** Extract `> Summary: ...` from file content. */
export function extractSummary(content: string): string {
  const match = content.match(/^>\s*Summary:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

/** Resolve and validate a memory path. Prevents directory traversal. */
export function resolveMemoryPath(
  relativePath: string,
  memoryDir: string,
): string {
  const resolved = path.resolve(memoryDir, relativePath);
  const memoryRoot = path.resolve(memoryDir);
  if (!resolved.startsWith(memoryRoot + "/") && resolved !== memoryRoot) {
    throw new Error(`Path "${relativePath}" escapes memory directory`);
  }
  return resolved;
}

/** Get the memory directory from context. Crashes if memoryDir is missing — a configuration bug. */
function getMemoryDir(context: ToolContext): string {
  if (!context.memoryDir) {
    throw new Error("ToolContext.memoryDir is required but missing — this is a configuration bug");
  }
  return context.memoryDir;
}

// ── memory_list ─────────────────────────────────

export const memory_list: Tool = {
  name: "memory_list",
  description: "List all memory files with path, summary, and size. Call this first to discover available memories.",
  category: "memory" as ToolCategory,
  parameters: z.object({}),
  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const memoryDir = getMemoryDir(context);

    try {
      // Check if memory directory exists
      try {
        await access(memoryDir);
      } catch {
        return {
          success: true,
          result: [],
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const entries: Array<{ path: string; summary: string; size: number }> = [];

      // Scan subdirectories (facts/, episodes/, etc.)
      const subdirs = await readdir(memoryDir, { withFileTypes: true });
      for (const subdir of subdirs) {
        if (!subdir.isDirectory()) continue;

        const subdirPath = path.join(memoryDir, subdir.name);
        const files = await readdir(subdirPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".md")) continue;

          const filePath = path.join(subdirPath, file.name);
          const content = await Bun.file(filePath).text();
          const stat = Bun.file(filePath).size;

          entries.push({
            path: `${subdir.name}/${file.name}`,
            summary: subdir.name === "facts" ? "" : extractSummary(content),
            size: stat,
          });
        }
      }

      return {
        success: true,
        result: entries,
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

// ── memory_read ─────────────────────────────────

export const memory_read: Tool = {
  name: "memory_read",
  description: "Read a memory file by relative path (e.g. 'facts/user.md'). Returns raw markdown content.",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path within memory directory, e.g. 'facts/user.md'"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath } = params as { path: string };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);
      const content = await Bun.file(filePath).text();

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

// ── memory_write ─────────────────────────────────

export const memory_write: Tool = {
  name: "memory_write",
  description: "Create or overwrite a memory file. Fact files (facts/*.md) are subject to allowlist and 15KB budget.",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path, e.g. 'facts/user.md'"),
    content: z.string().describe("Full file content (markdown)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath, content } = params as { path: string; content: string };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);

      // Fact file constraints
      if (relativePath.startsWith("facts/")) {
        const fileName = path.basename(relativePath);
        if (!ALLOWED_FACT_FILES.has(fileName)) {
          return {
            success: false,
            error: `Fact file "${fileName}" is not allowed. Only allowed: ${[...ALLOWED_FACT_FILES].join(", ")}`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        // Check facts budget: total size of all fact files after this write
        const factsDir = path.join(memoryDir, "facts");
        let totalSize = content.length; // this write
        try {
          const files = await readdir(factsDir);
          for (const f of files) {
            if (f === fileName) continue; // skip the file being overwritten
            const fPath = path.join(factsDir, f);
            const fSize = Bun.file(fPath).size;
            totalSize += fSize;
          }
        } catch {
          // facts/ doesn't exist yet — only this write counts
        }
        if (totalSize > FACTS_BUDGET_BYTES) {
          return {
            success: false,
            error: `Facts budget exceeded: ${totalSize} bytes > 15KB limit. Condense existing facts before adding new content.`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await mkdir(parentDir, { recursive: true });

      await Bun.write(filePath, content);

      return {
        success: true,
        result: { path: relativePath, size: content.length },
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

// ── memory_patch ─────────────────────────────────

export const memory_patch: Tool = {
  name: "memory_patch",
  description: "Partial string replacement within a memory file. Finds old_str and replaces with new_str.",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path, e.g. 'facts/user.md'"),
    old_str: z.string().describe("Exact string to find in the file"),
    new_str: z.string().describe("Replacement string"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath, old_str, new_str } = params as {
      path: string; old_str: string; new_str: string;
    };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);

      // Fact file allowlist check
      if (relativePath.startsWith("facts/")) {
        const fileName = path.basename(relativePath);
        if (!ALLOWED_FACT_FILES.has(fileName)) {
          return {
            success: false,
            error: `Fact file "${fileName}" is not allowed. Only allowed: ${[...ALLOWED_FACT_FILES].join(", ")}`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const content = await Bun.file(filePath).text();

      const firstIdx = content.indexOf(old_str);
      if (firstIdx === -1) {
        return {
          success: false,
          error: `String not found in ${relativePath}`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }
      const secondIdx = content.indexOf(old_str, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          success: false,
          error: `String appears multiple times in ${relativePath} — provide more context to make it unique`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const newContent = content.replace(old_str, new_str);
      await Bun.write(filePath, newContent);

      return {
        success: true,
        result: { path: relativePath, size: newContent.length },
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

// ── memory_append ─────────────────────────────────

export const memory_append: Tool = {
  name: "memory_append",
  description: "Append an entry to a memory file (typically episodes)",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path, e.g. 'episodes/2026-02.md'"),
    entry: z.string().describe("Markdown block to append"),
    summary: z.string().optional().describe("If provided, update the file-level '> Summary:' line"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath, entry, summary } = params as {
      path: string; entry: string; summary?: string;
    };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await mkdir(parentDir, { recursive: true });

      // Read existing content or start empty
      let existing = "";
      try {
        existing = await Bun.file(filePath).text();
      } catch {
        // File doesn't exist, will be created
      }

      const newContent = existing + entry;

      let finalContent = newContent;

      // Update file-level summary if provided
      if (summary) {
        const summaryLine = `> Summary: ${summary}`;
        if (finalContent.match(/^> Summary:.+$/m)) {
          finalContent = finalContent.replace(/^> Summary:.+$/m, summaryLine);
        } else {
          // Insert after first heading line
          const headingMatch = finalContent.match(/^#.+$/m);
          if (headingMatch) {
            const insertPos = (headingMatch.index ?? 0) + headingMatch[0].length;
            finalContent = finalContent.slice(0, insertPos) + "\n\n" + summaryLine + finalContent.slice(insertPos);
          }
        }
      }

      await Bun.write(filePath, finalContent);

      return {
        success: true,
        result: { path: relativePath, size: finalContent.length },
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
