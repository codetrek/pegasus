/**
 * File tools - read, write, list, edit, grep, glob files with path security.
 */

import { z } from "zod";
import { normalizePath, isPathAllowed } from "../types.ts";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";
import { ToolPermissionError } from "../errors.ts";
import path from "node:path";
import { readdir, access, stat as fsStat } from "node:fs/promises";

// ── read_file ──────────────────────────────────

/** Default max lines returned when no limit is specified. */
const READ_FILE_DEFAULT_MAX_LINES = 2000;
/** Max characters per line before truncation. */
const READ_FILE_MAX_LINE_LENGTH = 2000;

export const read_file: Tool = {
  name: "read_file",
  description: "Read content of a file. Returns line-numbered output (up to 2000 lines by default). "
    + "Use offset and limit to paginate through large files.",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to read"),
    encoding: z.string().optional().default("utf-8").describe("File encoding"),
    offset: z.coerce.number().int().min(0).optional().describe("Start reading from this line number (0-based)"),
    limit: z.coerce.number().int().positive().optional().describe("Maximum number of lines to return (default: 2000)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, encoding, offset, limit } = params as {
      path: string;
      encoding?: string;
      offset?: number;
      limit?: number;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("read_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Read file
      const filePath = normalizePath(originalPath);
      const raw = await Bun.file(filePath).text();
      const stat = await Bun.file(filePath).stat();
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      // Apply offset/limit — always enforce a default max
      const startLine = offset ?? 0;
      const effectiveLimit = limit ?? READ_FILE_DEFAULT_MAX_LINES;
      const endLine = Math.min(startLine + effectiveLimit, totalLines);
      const sliced = allLines.slice(startLine, endLine);

      // Format: line-numbered output with per-line truncation
      const formatted = sliced.map((line, i) => {
        const lineNum = startLine + i + 1; // 1-based
        const truncatedLine = line.length > READ_FILE_MAX_LINE_LENGTH
          ? line.slice(0, READ_FILE_MAX_LINE_LENGTH) + "\u2026"
          : line;
        return `${lineNum}\t${truncatedLine}`;
      });

      const content = formatted.join("\n");
      const truncated = endLine < totalLines;

      // Build result
      const result: Record<string, unknown> = {
        path: filePath,
        content,
        size: stat.size,
        encoding,
        totalLines,
        linesReturned: sliced.length,
        offset: startLine,
        truncated,
      };

      // When truncated, append a notice guiding the LLM
      if (truncated) {
        result.notice = `File has ${totalLines} lines. `
          + `Showing lines ${startLine + 1}-${endLine}. `
          + `Use offset and limit to read other sections.`;
      }

      return {
        success: true,
        result,
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

// ── write_file ─────────────────────────────────

export const write_file: Tool = {
  name: "write_file",
  description: "Write content to a file",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to write"),
    content: z.string().describe("Content to write"),
    encoding: z.string().optional().default("utf-8").describe("File encoding"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, content, encoding } = params as {
      path: string;
      content: string;
      encoding?: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("write_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Write file
      const filePath = normalizePath(originalPath);

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await Bun.$`mkdir -p ${parentDir}`.quiet();

      const writer = Bun.file(filePath).writer();
      await writer.write(content);
      await writer.end();

      // Get file stats
      const stat = await Bun.file(filePath).stat();

      return {
        success: true,
        result: {
          path: filePath,
          bytesWritten: stat.size,
          encoding,
        },
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

// ── list_files ────────────────────────────────

export const list_files: Tool = {
  name: "list_files",
  description: "List files and directories",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().default(".").describe("Directory path to list"),
    recursive: z.boolean().optional().default(false).describe("List recursively"),
    pattern: z.string().optional().describe("Filter by pattern (e.g., '*.ts')"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath = ".", recursive, pattern } = params as {
      path?: string;
      recursive?: boolean;
      pattern?: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      const dirPath = normalizePath(originalPath || ".");

      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(dirPath, allowedPaths)) {
          throw new ToolPermissionError("list_files", `Path "${dirPath}" is not in allowed paths`);
        }
      }

      // List files - if directory doesn't exist, return empty list
      let files: Array<{ name: string; path: string; isDir: boolean; size: number }> = [];

      // Check if directory exists - use access instead of Bun.file().exists()
      // since Bun.file().exists() only works for files, not directories
      let dirExists = false;
      try {
        await access(dirPath);
        dirExists = true;
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        return {
          success: true,
          result: {
            path: dirPath,
            recursive: recursive || false,
            files: [],
            count: 0,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      if (recursive) {
        // Recursive listing
        const scanDir = async (currentPath: string, relativePath: string = ""): Promise<void> => {
          const entries = await readdir(currentPath, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);
            const stat = await Bun.file(entryPath).stat();

            if (stat.isDirectory()) {
              // Add directory and recurse
              files.push({
                name: entryRelativePath,
                path: entryPath,
                isDir: true,
                size: 0,
              });
              await scanDir(entryPath, entryRelativePath);
            } else if (stat.isFile()) {
              // Apply pattern filter
              if (pattern && !entry.name.match(new RegExp(pattern))) {
                continue;
              }
              files.push({
                name: entryRelativePath,
                path: entryPath,
                isDir: false,
                size: stat.size,
              });
            }
          }
        };

        await scanDir(dirPath);
      } else {
        // Non-recursive listing
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry.name);
          const stat = await Bun.file(entryPath).stat();

          // Skip directories in non-recursive mode
          if (stat.isDirectory()) {
            continue;
          }

          // Apply pattern filter
          if (pattern && !entry.name.match(new RegExp(pattern))) {
            continue;
          }

          files.push({
            name: entry.name,
            path: entryPath,
            isDir: false,
            size: stat.size,
          });
        }
      }

      return {
        success: true,
        result: {
          path: dirPath,
          recursive: recursive || false,
          files,
          count: files.length,
        },
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

// ── edit_file ──────────────────────────────────

export const edit_file: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match with new content. "
    + "The old_string must appear in the file and be unique (unless replace_all is true). "
    + "Include enough surrounding context in old_string to make it unique.",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to edit"),
    old_string: z.string().min(1).describe("Exact string to find (include surrounding lines for uniqueness)"),
    new_string: z.string().describe("Replacement string"),
    replace_all: z.boolean().optional().default(false).describe("Replace all occurrences (for renaming)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, old_string, new_string, replace_all } = params as {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("edit_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Read file
      const filePath = normalizePath(originalPath);
      const fileHandle = Bun.file(filePath);
      const exists = await fileHandle.exists();
      if (!exists) {
        throw new Error(`File not found: ${filePath}`);
      }
      const content = await fileHandle.text();

      // Count occurrences of old_string
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf(old_string, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + old_string.length;
      }

      if (count === 0) {
        throw new Error("old_string not found in file");
      }

      if (count > 1 && !replace_all) {
        throw new Error(`old_string found ${count} times, provide more context or set replace_all`);
      }

      // Perform replacement
      let newContent: string;
      let replacements: number;
      if (replace_all) {
        newContent = content.split(old_string).join(new_string);
        replacements = count;
      } else {
        newContent = content.replace(old_string, new_string);
        replacements = 1;
      }

      // Write back
      await Bun.write(filePath, newContent);

      return {
        success: true,
        result: {
          path: filePath,
          replacements,
        },
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

// ── grep_files ─────────────────────────────────

/**
 * Convert a simple glob pattern to a regex for filename matching.
 * Supports: *.ts, *.{ts,js}, etc.
 */
function globToRegex(glob: string): RegExp {
  // Handle {a,b} alternation
  let pattern = glob.replace(/\{([^}]+)\}/g, (_match, group: string) => {
    const alternatives = group.split(",").map((s: string) => s.trim());
    return `(${alternatives.join("|")})`;
  });
  // Escape regex special chars except * and our alternation groups
  pattern = pattern.replace(/[.+^$[\]\\]/g, (char) => `\\${char}`);
  // Convert * to regex
  pattern = pattern.replace(/\*/g, ".*");
  return new RegExp(`${pattern}$`);
}

/** Context line entry for grep results with context_lines enabled. */
interface ContextLine {
  lineNumber: number;
  line: string;
  isMatch?: boolean;
}

export const grep_files: Tool = {
  name: "grep_files",
  description: "Search file contents using a regular expression pattern. "
    + "Returns matching lines with file paths and line numbers. "
    + "Supports case-insensitive search, context lines, multiline matching, and multiple output modes.",
  category: "file" as ToolCategory,
  parameters: z.object({
    pattern: z.string().min(1).describe("Regex pattern to search for"),
    path: z.string().default(".").describe("Directory or file to search in"),
    include: z.string().optional().describe("File name glob pattern (e.g. '*.ts', '*.{ts,js}')"),
    max_results: z.coerce.number().int().positive().optional().default(50).describe("Maximum matches to return"),
    case_insensitive: z.boolean().optional().default(false).describe("Case-insensitive matching"),
    context_lines: z.coerce.number().int().min(0).max(10).optional().describe("Number of context lines before and after each match"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content")
      .describe("Output mode: content (matching lines), files_with_matches (file paths only), count (match counts per file)"),
    multiline: z.boolean().optional().default(false).describe("Enable multiline matching where . matches newlines"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const {
      pattern,
      path: originalPath = ".",
      include,
      max_results = 50,
      case_insensitive = false,
      context_lines,
      output_mode = "content",
      multiline = false,
    } = params as {
      pattern: string;
      path?: string;
      include?: string;
      max_results?: number;
      case_insensitive?: boolean;
      context_lines?: number;
      output_mode?: "content" | "files_with_matches" | "count";
      multiline?: boolean;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      const searchPath = normalizePath(originalPath || ".");
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(searchPath, allowedPaths)) {
          throw new ToolPermissionError("grep_files", `Path "${searchPath}" is not in allowed paths`);
        }
      }

      // Compile regex with appropriate flags
      let regex: RegExp;
      try {
        let flags = "g"; // global for counting all matches
        if (case_insensitive) flags += "i";
        if (multiline) flags += "s"; // dotAll: . matches newlines
        regex = new RegExp(pattern, flags);
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
      }

      // Compile include filter
      const includeRegex = include ? globToRegex(include) : null;

      // Result accumulators based on output mode
      const contentMatches: Array<{
        file: string;
        line?: string;
        lineNumber?: number;
        match?: string;
        context?: ContextLine[];
      }> = [];
      const filesWithMatches: string[] = [];
      const countPerFile: Array<{ file: string; count: number }> = [];
      let totalMatches = 0;

      // Helper: merge overlapping context ranges
      const buildContextRanges = (matchLineIndices: number[], totalLines: number, ctxLines: number): Array<[number, number]> => {
        if (matchLineIndices.length === 0) return [];
        const ranges: Array<[number, number]> = [];
        for (const idx of matchLineIndices) {
          const start = Math.max(0, idx - ctxLines);
          const end = Math.min(totalLines - 1, idx + ctxLines);
          if (ranges.length > 0 && start <= ranges[ranges.length - 1]![1] + 1) {
            // Merge with previous range
            ranges[ranges.length - 1]![1] = end;
          } else {
            ranges.push([start, end]);
          }
        }
        return ranges;
      };

      // Search a single file (line-by-line mode)
      const searchFileLineByLine = async (filePath: string): Promise<boolean> => {
        try {
          const fileContent = await Bun.file(filePath).text();
          const lines = fileContent.split("\n");

          // Use a non-global regex for line-by-line matching
          let lineRegex: RegExp;
          let flags = "";
          if (case_insensitive) flags += "i";
          lineRegex = new RegExp(pattern, flags);

          // Find all matching line indices
          const matchLineIndices: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (lineRegex.test(lines[i]!)) {
              matchLineIndices.push(i);
            }
          }

          if (matchLineIndices.length === 0) return false;

          const fileMatchCount = matchLineIndices.length;
          totalMatches += fileMatchCount;

          if (output_mode === "files_with_matches") {
            if (filesWithMatches.length < max_results) {
              filesWithMatches.push(filePath);
            }
            return filesWithMatches.length >= max_results;
          }

          if (output_mode === "count") {
            if (countPerFile.length < max_results) {
              countPerFile.push({ file: filePath, count: fileMatchCount });
            }
            return countPerFile.length >= max_results;
          }

          // output_mode === "content"
          if (context_lines !== undefined && context_lines > 0) {
            // Context mode: one entry per merged range (like ripgrep -C).
            // Overlapping matches are combined into a single context block.
            const ranges = buildContextRanges(matchLineIndices, lines.length, context_lines);
            const matchSet = new Set(matchLineIndices);

            for (const [rangeStart, rangeEnd] of ranges) {
              if (contentMatches.length >= max_results) return true;

              const contextArr: ContextLine[] = [];
              for (let j = rangeStart; j <= rangeEnd; j++) {
                contextArr.push({
                  lineNumber: j + 1,
                  line: lines[j]!,
                  ...(matchSet.has(j) ? { isMatch: true } : {}),
                });
              }

              contentMatches.push({
                file: filePath,
                context: contextArr,
              });
            }
          } else {
            // No context: original behavior
            for (const idx of matchLineIndices) {
              if (contentMatches.length >= max_results) return true;
              const m = lines[idx]!.match(lineRegex);
              contentMatches.push({
                file: filePath,
                line: lines[idx]!,
                lineNumber: idx + 1,
                match: m ? m[0] : "",
              });
            }
          }

          return contentMatches.length >= max_results;
        } catch {
          // Skip files that can't be read (binary, permission, etc.)
          return false;
        }
      };

      // Search a single file (multiline mode)
      const searchFileMultiline = async (filePath: string): Promise<boolean> => {
        try {
          const fileContent = await Bun.file(filePath).text();

          // Reset lastIndex for global regex
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          let fileMatchCount = 0;

          while ((m = regex.exec(fileContent)) !== null) {
            fileMatchCount++;
            totalMatches++;

            if (output_mode === "content" && contentMatches.length < max_results) {
              // Find starting line number of the match
              const beforeMatch = fileContent.slice(0, m.index);
              const startLineNum = beforeMatch.split("\n").length;

              contentMatches.push({
                file: filePath,
                line: m[0].length > 200 ? m[0].slice(0, 200) + "..." : m[0],
                lineNumber: startLineNum,
                match: m[0].length > 200 ? m[0].slice(0, 200) + "..." : m[0],
              });
            }

            // Prevent infinite loop on zero-length matches
            if (m[0].length === 0) {
              regex.lastIndex++;
            }
          }

          if (fileMatchCount === 0) return false;

          if (output_mode === "files_with_matches") {
            if (filesWithMatches.length < max_results) {
              filesWithMatches.push(filePath);
            }
            return filesWithMatches.length >= max_results;
          }

          if (output_mode === "count") {
            if (countPerFile.length < max_results) {
              countPerFile.push({ file: filePath, count: fileMatchCount });
            }
            return countPerFile.length >= max_results;
          }

          return contentMatches.length >= max_results;
        } catch {
          return false;
        }
      };

      const searchFile = multiline ? searchFileMultiline : searchFileLineByLine;

      // Check if path is a file or directory
      let isDir = false;
      try {
        const stats = await fsStat(searchPath);
        isDir = stats.isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      if (!isDir) {
        // Single file search
        await searchFile(searchPath);
      } else {
        // Recursive directory walk
        const walkDir = async (dirPath: string): Promise<boolean> => {
          let entries;
          try {
            entries = await readdir(dirPath, { withFileTypes: true });
          } catch {
            return false;
          }
          for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              const capped = await walkDir(entryPath);
              if (capped) return true;
            } else if (entry.isFile()) {
              // Apply include filter on filename
              if (includeRegex && !includeRegex.test(entry.name)) {
                continue;
              }
              const capped = await searchFile(entryPath);
              if (capped) return true;
            }
          }
          return false;
        };

        await walkDir(searchPath);
      }

      // Build result based on output mode
      let resultData: Record<string, unknown>;
      if (output_mode === "files_with_matches") {
        resultData = {
          files: filesWithMatches,
          totalMatches,
          truncated: filesWithMatches.length >= max_results && totalMatches > filesWithMatches.length,
        };
      } else if (output_mode === "count") {
        resultData = {
          counts: countPerFile,
          totalMatches,
          truncated: countPerFile.length >= max_results,
        };
      } else {
        resultData = {
          matches: contentMatches,
          totalMatches,
          truncated: totalMatches > contentMatches.length,
        };
      }

      return {
        success: true,
        result: resultData,
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

// ── glob_files ─────────────────────────────────

export const glob_files: Tool = {
  name: "glob_files",
  description: "Find files matching a glob pattern. Returns file paths sorted by modification time (newest first).",
  category: "file" as ToolCategory,
  parameters: z.object({
    pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts')"),
    cwd: z.string().optional().describe("Base directory (defaults to process.cwd())"),
    max_results: z.coerce.number().int().positive().optional().default(100).describe("Maximum files to return"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { pattern: globPattern, cwd: cwdParam, max_results = 100 } = params as {
      pattern: string;
      cwd?: string;
      max_results?: number;
    };

    try {
      const basePath = cwdParam ? normalizePath(cwdParam) : process.cwd();

      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(basePath, allowedPaths)) {
          throw new ToolPermissionError("glob_files", `Path "${basePath}" is not in allowed paths`);
        }
      }

      // Use Bun.Glob for pattern matching
      const glob = new Bun.Glob(globPattern);
      const entries: string[] = [];
      for await (const entry of glob.scan({ cwd: basePath, onlyFiles: true })) {
        entries.push(entry);
        // Collect more than max_results so we can sort by mtime, then truncate
        if (entries.length >= max_results * 2) break;
      }

      // Stat each file to get mtime, sort by mtime descending
      const filesWithMtime: Array<{ path: string; mtime: number }> = [];
      for (const entry of entries) {
        try {
          const fullPath = path.join(basePath, entry);
          const stats = await fsStat(fullPath);
          filesWithMtime.push({
            path: entry,
            mtime: stats.mtime?.getTime() || 0,
          });
        } catch {
          // Skip files that can't be stat'd
        }
      }

      // Sort by mtime descending (newest first)
      filesWithMtime.sort((a, b) => b.mtime - a.mtime);

      // Truncate to max_results
      const truncated = filesWithMtime.length > max_results;
      const result = filesWithMtime.slice(0, max_results).map(f => f.path);

      return {
        success: true,
        result: {
          files: result,
          count: result.length,
          truncated,
          cwd: basePath,
        },
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
