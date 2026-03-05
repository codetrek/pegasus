/**
 * File tools - read, write, list, edit, grep, glob files with path security.
 */

import { z } from "zod";
import { normalizePath, isPathAllowed } from "../types.ts";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";
import { ToolPermissionError } from "../errors.ts";
import path from "node:path";
import { readdir, access, stat as fsStat } from "node:fs/promises";
import ignore from "ignore";
import { getSettings } from "../../infra/config.ts";
import { isImageFile, readImageFile } from "../../media/image-helpers.ts";

// ── rg availability check (cached at module load) ──

let _rgAvailable: boolean | null = null;

/** Check if ripgrep (rg) is available. Cached after first call. */
export function isRgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    const result = Bun.spawnSync(["rg", "--version"], { stdout: "pipe", stderr: "pipe" });
    _rgAvailable = result.exitCode === 0;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

// Eagerly probe on module load (non-blocking since spawnSync is sync)
isRgAvailable();

/** Reset rg availability cache (for testing). */
export function _resetRgCache(value?: boolean | null): void {
  _rgAvailable = value ?? null;
}

// ── read_file ──────────────────────────────────

/** Default max lines returned when no limit is specified. */
const READ_FILE_DEFAULT_MAX_LINES = 2000;
/** Max characters per line before truncation. */
const READ_FILE_MAX_LINE_LENGTH = 2000;

export const read_file: Tool = {
  name: "read_file",
  description: "Read a file with line numbers (up to 2000 lines). Use offset/limit for large files. For locating content, prefer grep_files.",
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

      // Image detection — switch to image mode before attempting text read
      const filePath = normalizePath(originalPath);
      if (isImageFile(filePath)) {
        return readImageFile(filePath, context, "file_read", startedAt);
      }

      // Read file (text mode)
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
  description: "Create or overwrite a file. Creates parent directories automatically. Replaces all existing content — use edit_file for partial changes.",
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
  description: "List files in a directory. For pattern-based search across directories, prefer glob_files.",
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

// ── JS fallback constants ──

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".worktrees", "dist", "build",
  ".next", "__pycache__", ".venv", "vendor", "coverage", ".nyc_output",
]);

/** Get configured max file size for JS fallback grep. Falls back to 50MB if settings not initialized. */
export function getMaxFileSize(): number {
  try {
    return getSettings().tools.maxFileSize;
  } catch {
    return 52_428_800; // 50MB fallback if settings not initialized
  }
}

/** Check if a buffer looks like binary (contains null bytes in first 8KB). Same heuristic as git/grep/rg. */
function isBinaryBuffer(buffer: Uint8Array): boolean {
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ── rg helpers ──

interface GrepParams {
  pattern: string;
  path: string;
  include?: string;
  max_results: number;
  case_insensitive: boolean;
  context_lines?: number;
  output_mode: "content" | "files_with_matches" | "count";
  multiline: boolean;
}

/** Build rg command arguments from grep params. */
function buildRgArgs(params: GrepParams): string[] {
  // --with-filename ensures rg always prints the filename header,
  // even when searching a single file (by default rg omits it).
  const args = ["--heading", "--line-number", "--no-column", "--color", "never", "--with-filename"];

  if (params.case_insensitive) args.push("-i");
  if (params.multiline) args.push("-U", "--multiline-dotall");
  if (params.include) args.push("--glob", params.include);

  if (params.output_mode === "files_with_matches") {
    args.push("-l");
  } else if (params.output_mode === "count") {
    args.push("-c");
  } else {
    // content mode
    if (params.context_lines !== undefined && params.context_lines > 0) {
      args.push("-C", String(params.context_lines));
    }
  }

  args.push("--", params.pattern, params.path);
  return args;
}

/**
 * Parse rg --heading output into our grouped format.
 *
 * rg --heading outputs:
 *   filename          (bare line = file header)
 *   42:match content  (match line)
 *   41-context line   (context line)
 *   --                (separator between non-contiguous blocks)
 *
 * We convert to our format:
 *   === filename ===
 *   42:match content   (no-context mode)
 * or:
 *   === filename ===
 *   :42:match content  (context mode — leading colon)
 *   -41-context line
 *   --
 */
/**
 * Parse rg --heading output into our grouped format (single forward pass, O(n)).
 *
 * rg --heading outputs groups separated by blank lines:
 *   filename          (first non-empty line of a group = file header)
 *   42:match content  (match line)
 *   41-context line   (context line)
 *   --                (separator between non-contiguous blocks within same file)
 *                     (blank line = separator between file groups)
 *
 * We convert to:
 *   === filename ===
 *   42:match content   (no-context mode)
 *   :42:match content  (context mode — leading colon)
 *   -41-context line
 */
function parseRgContentOutput(raw: string, maxResults: number, hasContext: boolean): { lines: string[]; totalMatches: number; truncated: boolean } {
  if (!raw.trim()) return { lines: [], totalMatches: 0, truncated: false };

  const outputLines: string[] = [];
  let totalMatches = 0;
  let matchesSoFar = 0;
  let currentFile: string | null = null;
  let hitLimit = false;
  // Track whether the next non-empty, non-separator line is a file header
  let expectFileHeader = true;

  for (const line of raw.split("\n")) {
    // Empty line = file group separator → next non-empty line is a file header
    if (line === "") {
      expectFileHeader = true;
      continue;
    }

    // Block separator within a file
    if (line === "--") {
      if (!hitLimit) outputLines.push("--");
      continue;
    }

    // Match line: digits followed by colon
    const matchLine = line.match(/^(\d+):(.*)$/);
    if (matchLine && !expectFileHeader) {
      totalMatches++;
      matchesSoFar++;
      if (matchesSoFar > maxResults) {
        hitLimit = true;
        continue;
      }
      if (hasContext) {
        outputLines.push(`:${matchLine[1]}:${matchLine[2]}`);
      } else {
        outputLines.push(`${matchLine[1]}:${matchLine[2]}`);
      }
      continue;
    }

    // Context line: digits followed by hyphen
    const contextLine = line.match(/^(\d+)-(.*)$/);
    if (contextLine && !expectFileHeader) {
      if (!hitLimit) {
        outputLines.push(`-${contextLine[1]}-${contextLine[2]}`);
      }
      continue;
    }

    // File header (bare filename — not a match/context line, or expectFileHeader is true)
    if (line !== currentFile) {
      if (currentFile !== null) outputLines.push(""); // blank line between files
      outputLines.push(`=== ${line} ===`);
      currentFile = line;
    }
    expectFileHeader = false;
  }

  return { lines: outputLines, totalMatches, truncated: hitLimit };
}

/** Parse rg -c output (count mode): file:count per line → our format. */
function parseRgCountOutput(raw: string, maxResults: number): string[] {
  if (!raw.trim()) return [];
  return raw.trim().split("\n").filter(l => l !== "").slice(0, maxResults);
}

/** Parse rg -l output (files_with_matches): one path per line → our format. */
function parseRgFilesOutput(raw: string, maxResults: number): string[] {
  if (!raw.trim()) return [];
  return raw.trim().split("\n").filter(l => l !== "").slice(0, maxResults);
}

/** Execute grep via ripgrep. Returns formatted output string, or null if rg not suitable. */
function executeWithRg(params: GrepParams): { output: string; truncated: boolean } | null {
  const args = buildRgArgs(params);

  const result = Bun.spawnSync(["rg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  // Exit code 1 = no matches, exit code 2 = error
  if (result.exitCode === 2) {
    // Check for regex error from rg
    if (stderr.includes("regex")) {
      throw new Error(`Invalid regex pattern: ${stderr.trim()}`);
    }
    // Other rg errors — fall back to JS
    return null;
  }

  if (params.output_mode === "files_with_matches") {
    const files = parseRgFilesOutput(stdout, params.max_results);
    return { output: files.join("\n"), truncated: false };
  }

  if (params.output_mode === "count") {
    const counts = parseRgCountOutput(stdout, params.max_results);
    return { output: counts.join("\n"), truncated: false };
  }

  // content mode
  const hasContext = params.context_lines !== undefined && params.context_lines > 0;
  const { lines, totalMatches, truncated } = parseRgContentOutput(stdout, params.max_results, hasContext);
  let output = lines.join("\n");
  if (truncated) {
    output += `\n\n[${totalMatches} total matches, showing first ${params.max_results}]`;
  }
  return { output, truncated };
}

// ── JS fallback helpers ──

/** Load .gitignore patterns from the search root up to repo root (.git). */
async function loadGitignore(searchRoot: string): Promise<ReturnType<typeof ignore> | null> {
  const ig = ignore();
  let loaded = false;

  // Walk up from searchRoot to find .gitignore files, stop at repo root (.git)
  let dir = searchRoot;
  const visited = new Set<string>();
  while (dir && !visited.has(dir)) {
    visited.add(dir);
    try {
      const gitignorePath = path.join(dir, ".gitignore");
      const content = await Bun.file(gitignorePath).text();
      ig.add(content);
      loaded = true;
    } catch {
      // No .gitignore at this level
    }
    // Stop if we reached a git repo root
    try {
      await access(path.join(dir, ".git"));
      break; // found .git — this is the repo root, stop walking up
    } catch {
      // Not a repo root, keep going
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return loaded ? ig : null;
}

export const grep_files: Tool = {
  name: "grep_files",
  description: "Search file contents using regex. Output grouped by file: "
    + "'=== file ===' header, then 'lineNum:content' per match, '--' between context blocks. "
    + "Use output_mode='files_with_matches' to get just file paths. "
    + "Prefer grep_files over shell_exec grep/rg for structured, token-efficient search.",
  category: "file" as ToolCategory,
  parameters: z.object({
    pattern: z.string().min(1).describe("Regex pattern to search for (e.g. 'function\\s+\\w+', 'TODO')"),
    path: z.string().default(".").describe("Directory or file to search in"),
    include: z.string().optional().describe("File name glob filter (e.g. '*.ts', '*.{ts,js}')"),
    max_results: z.coerce.number().int().positive().optional().default(50).describe("Maximum matches to return (default 50)"),
    case_insensitive: z.boolean().optional().default(false).describe("Case-insensitive matching"),
    context_lines: z.coerce.number().int().min(0).max(10).optional().describe("Lines of context before and after each match (like grep -C)"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content")
      .describe("content: matching lines (default); files_with_matches: file paths only; count: match counts per file"),
    multiline: z.boolean().optional().default(false).describe("Enable multiline matching where . matches newlines (like grep -z)"),
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

      // Validate the regex pattern early (before attempting rg or JS fallback)
      try {
        let flags = "";
        if (case_insensitive) flags += "i";
        if (multiline) flags += "s";
        new RegExp(pattern, flags);
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
      }

      // Check that the path exists
      let isDir = false;
      try {
        const stats = await fsStat(searchPath);
        isDir = stats.isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const grepParams: GrepParams = {
        pattern,
        path: searchPath,
        include,
        max_results,
        case_insensitive,
        context_lines,
        output_mode,
        multiline,
      };

      // ── Tier 1: Try ripgrep ──
      if (isRgAvailable()) {
        try {
          const rgResult = executeWithRg(grepParams);
          if (rgResult !== null) {
            return {
              success: true,
              result: rgResult.output,
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }
        } catch (e) {
          // If rg threw an error we recognize (e.g., invalid regex), rethrow
          if (e instanceof Error && e.message.startsWith("Invalid regex")) {
            throw e;
          }
          // Otherwise fall through to JS fallback
        }
      }

      // ── Tier 2: JS fallback ──

      // Compile regex with appropriate flags
      let regex: RegExp;
      {
        let flags = "g";
        if (case_insensitive) flags += "i";
        if (multiline) flags += "s";
        regex = new RegExp(pattern, flags);
      }

      // Compile include filter
      const includeRegex = include ? globToRegex(include) : null;

      // Load .gitignore for directory searches
      const ig = isDir ? await loadGitignore(searchPath) : null;

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

      // Pre-compile non-global regex for line-by-line matching (reused across files)
      const lineRegex = new RegExp(pattern, case_insensitive ? "i" : "");

      // Helper: merge overlapping context ranges
      const buildContextRanges = (matchLineIndices: number[], totalLines: number, ctxLines: number): Array<[number, number]> => {
        if (matchLineIndices.length === 0) return [];
        const ranges: Array<[number, number]> = [];
        for (const idx of matchLineIndices) {
          const start = Math.max(0, idx - ctxLines);
          const end = Math.min(totalLines - 1, idx + ctxLines);
          if (ranges.length > 0 && start <= ranges[ranges.length - 1]![1] + 1) {
            ranges[ranges.length - 1]![1] = end;
          } else {
            ranges.push([start, end]);
          }
        }
        return ranges;
      };

      // Search a single file (line-by-line mode) using streaming
      const searchFileLineByLine = async (filePath: string): Promise<boolean> => {
        try {
          // Skip files exceeding configured max size
          const st = await fsStat(filePath);
          if (st.size > getMaxFileSize()) return false;

          // Skip binary files: read first 8KB and check for null bytes
          const file = Bun.file(filePath);
          const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
          if (isBinaryBuffer(head)) return false;

          // Stream file line by line using Bun's reader
          const stream = file.stream();
          const reader = stream.getReader();
          const decoder = new TextDecoder();

          let lineBuffer = "";
          let lineIndex = 0;

          // With context: must store all lines + match indices for context building
          // Without context: accumulate match results directly during streaming
          const needContext = context_lines !== undefined && context_lines > 0;
          const matchLineIndices: number[] = [];
          const allLines: string[] = []; // Only populated when needContext
          // Without context: store matches inline
          const inlineMatches: Array<{ line: string; lineNumber: number; match: string }> = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Process remaining buffer as last line
              if (lineBuffer) {
                if (lineRegex.test(lineBuffer)) {
                  matchLineIndices.push(lineIndex);
                  if (!needContext) {
                    const m = lineBuffer.match(lineRegex);
                    inlineMatches.push({
                      line: lineBuffer,
                      lineNumber: lineIndex + 1,
                      match: m ? m[0] : "",
                    });
                  }
                }
                if (needContext) {
                  allLines.push(lineBuffer);
                }
                lineIndex++;
              }
              break;
            }

            lineBuffer += decoder.decode(value, { stream: true });

            // Split buffer by newlines
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop()!; // Last element is incomplete line

            for (const line of lines) {
              if (lineRegex.test(line)) {
                matchLineIndices.push(lineIndex);
                if (!needContext) {
                  const m = line.match(lineRegex);
                  inlineMatches.push({
                    line,
                    lineNumber: lineIndex + 1,
                    match: m ? m[0] : "",
                  });
                }
              }
              if (needContext) {
                allLines.push(line);
              }
              lineIndex++;
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
          if (needContext) {
            const ranges = buildContextRanges(matchLineIndices, allLines.length, context_lines!);
            const matchSet = new Set(matchLineIndices);

            for (const [rangeStart, rangeEnd] of ranges) {
              if (contentMatches.length >= max_results) return true;

              const contextArr: ContextLine[] = [];
              for (let j = rangeStart; j <= rangeEnd; j++) {
                contextArr.push({
                  lineNumber: j + 1,
                  line: allLines[j]!,
                  ...(matchSet.has(j) ? { isMatch: true } : {}),
                });
              }

              contentMatches.push({
                file: filePath,
                context: contextArr,
              });
            }
          } else {
            for (const im of inlineMatches) {
              if (contentMatches.length >= max_results) return true;
              contentMatches.push({
                file: filePath,
                line: im.line,
                lineNumber: im.lineNumber,
                match: im.match,
              });
            }
          }

          return contentMatches.length >= max_results;
        } catch {
          return false;
        }
      };

      // Search a single file (multiline mode)
      const searchFileMultiline = async (filePath: string): Promise<boolean> => {
        try {
          // Skip files exceeding configured max size
          const st = await fsStat(filePath);
          if (st.size > getMaxFileSize()) return false;

          // Skip binary files: read first 8KB and check for null bytes
          const file = Bun.file(filePath);
          const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
          if (isBinaryBuffer(head)) return false;

          const fileContent = await file.text();

          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          let fileMatchCount = 0;

          while ((m = regex.exec(fileContent)) !== null) {
            fileMatchCount++;
            totalMatches++;

            if (output_mode === "content" && contentMatches.length < max_results) {
              const beforeMatch = fileContent.slice(0, m.index);
              const startLineNum = beforeMatch.split("\n").length;

              contentMatches.push({
                file: filePath,
                line: m[0].length > 200 ? m[0].slice(0, 200) + "..." : m[0],
                lineNumber: startLineNum,
                match: m[0].length > 200 ? m[0].slice(0, 200) + "..." : m[0],
              });
            }

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

      if (!isDir) {
        await searchFile(searchPath);
      } else {
        // Recursive directory walk with .gitignore and blacklist support
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
              // Blacklist check
              if (SKIP_DIRS.has(entry.name)) continue;
              // .gitignore check
              if (ig) {
                const relativePath = path.relative(searchPath, entryPath);
                if (ig.ignores(relativePath + "/")) continue;
              }
              const capped = await walkDir(entryPath);
              if (capped) return true;
            } else if (entry.isFile()) {
              // Apply include filter on filename
              if (includeRegex && !includeRegex.test(entry.name)) {
                continue;
              }
              // .gitignore check for files
              if (ig) {
                const relativePath = path.relative(searchPath, entryPath);
                if (ig.ignores(relativePath)) continue;
              }
              const capped = await searchFile(entryPath);
              if (capped) return true;
            }
          }
          return false;
        };

        await walkDir(searchPath);
      }

      // Build token-efficient text output, grouped by file
      const outputLines: string[] = [];

      if (output_mode === "files_with_matches") {
        for (const f of filesWithMatches) {
          outputLines.push(f);
        }
      } else if (output_mode === "count") {
        for (const entry of countPerFile) {
          outputLines.push(`${entry.file}:${entry.count}`);
        }
      } else {
        let currentFile = "";
        for (let i = 0; i < contentMatches.length; i++) {
          const m = contentMatches[i]!;

          if (m.context) {
            if (m.file !== currentFile) {
              if (currentFile !== "") outputLines.push("");
              outputLines.push(`=== ${m.file} ===`);
              currentFile = m.file!;
            } else {
              outputLines.push("--");
            }
            for (const ctx of m.context) {
              if (ctx.isMatch) {
                outputLines.push(`:${ctx.lineNumber}:${ctx.line}`);
              } else {
                outputLines.push(`-${ctx.lineNumber}-${ctx.line}`);
              }
            }
          } else {
            if (m.file !== currentFile) {
              if (currentFile !== "") outputLines.push("");
              outputLines.push(`=== ${m.file} ===`);
              currentFile = m.file!;
            }
            outputLines.push(`${m.lineNumber}:${m.line}`);
          }
        }
      }

      // Append summary footer
      const truncated =
        output_mode === "files_with_matches"
          ? filesWithMatches.length >= max_results && totalMatches > filesWithMatches.length
          : output_mode === "count"
            ? countPerFile.length >= max_results
            : totalMatches > contentMatches.length;

      if (truncated) {
        outputLines.push(`\n[${totalMatches} total matches, showing first ${max_results}]`);
      }

      return {
        success: true,
        result: outputLines.join("\n"),
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
  description: "Find files by name pattern. Use this when you need to locate files (e.g. '**/*.ts', 'src/**/*.test.ts'). "
    + "Returns file paths sorted by modification time (newest first). "
    + "Prefer glob_files over list_files when searching by extension or name pattern across directories.",
  category: "file" as ToolCategory,
  parameters: z.object({
    pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/components/**/*.tsx', '*.config.{js,ts}')"),
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
        // Best-effort mtime sorting: collect up to 2x max_results, sort, then truncate.
        // With very large result sets, the final order may not be globally optimal.
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

      // Plain text output: one file per line
      let output = result.join("\n");
      if (truncated) {
        output += `\n[showing ${max_results} of ${filesWithMtime.length}+ files]`;
      }

      return {
        success: true,
        result: output,
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
