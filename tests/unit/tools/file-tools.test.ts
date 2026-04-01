/**
 * Unit tests for file tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { read_file, write_file, list_files, edit_file, grep_files, glob_files, _resetRgCache, isRgAvailable } from "../../../src/agents/tools/builtins/file-tools.ts";
import { rm, mkdir, chmod } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-files";

describe("file tools", () => {
  beforeEach(async () => {
    // Clean and create test directory
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("read_file", () => {
    it("should read file content with line numbers", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/test.txt`;

      await Bun.write(filePath, "test content");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; size: number; totalLines: number; linesReturned: number };
      // Line-numbered format: "1\ttest content"
      expect(r.content).toBe("1\ttest content");
      expect(r.size).toBeGreaterThan(0);
      expect(r.totalLines).toBe(1);
      expect(r.linesReturned).toBe(1);
    });

    it("should fail on non-existent file", async () => {
      const context = { agentId: "test-task-id" };
      const result = await read_file.execute({ path: `${testDir}/nonexistent.txt` }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no such file or directory");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await read_file.execute({ path: "/etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should read with offset and limit (line-numbered)", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/lines.txt`;
      const lines = ["line0", "line1", "line2", "line3", "line4"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, offset: 1, limit: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("2\tline1\n3\tline2");
      expect(r.totalLines).toBe(5);
      expect(r.offset).toBe(1);
      expect(r.linesReturned).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it("should read with offset only (to default max)", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/lines-offset.txt`;
      const lines = ["a", "b", "c", "d"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, offset: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; truncated: boolean };
      expect(r.content).toBe("3\tc\n4\td");
      expect(r.offset).toBe(2);
      expect(r.truncated).toBe(false);
    });

    it("should read with limit only (from start)", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/lines-limit.txt`;
      const lines = ["x", "y", "z"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, limit: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("1\tx\n2\ty");
      expect(r.offset).toBe(0);
      expect(r.linesReturned).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it("should always include totalLines and linesReturned", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/full.txt`;
      await Bun.write(filePath, "full content here");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("1\tfull content here");
      expect(r.totalLines).toBe(1);
      expect(r.linesReturned).toBe(1);
      expect(r.truncated).toBe(false);
    });

    it("should default to 2000-line limit for large files", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/large.txt`;
      // Create a file with 3000 lines
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { totalLines: number; linesReturned: number; truncated: boolean; notice: string };
      expect(r.totalLines).toBe(3000);
      expect(r.linesReturned).toBe(2000);
      expect(r.truncated).toBe(true);
      expect(r.notice).toContain("3000 lines");
      expect(r.notice).toContain("offset and limit");
    });

    it("should truncate long lines at 2000 characters", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/longline.txt`;
      const longLine = "x".repeat(3000);
      await Bun.write(filePath, longLine);

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string };
      // "1\t" + 2000 chars + "…"
      const content = r.content;
      expect(content.startsWith("1\t")).toBe(true);
      const lineContent = content.slice(2); // strip "1\t"
      expect(lineContent.length).toBe(2001); // 2000 + "…"
      expect(lineContent.endsWith("\u2026")).toBe(true);
    });

    it("should not include notice when file fits within limit", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/small.txt`;
      await Bun.write(filePath, "short\nfile");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as Record<string, unknown>;
      expect(r.notice).toBeUndefined();
      expect(r.truncated).toBe(false);
    });

    it("should return empty content when offset is beyond file length", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/small.txt`;
      await Bun.write(filePath, "one\ntwo");

      const result = await read_file.execute({ path: filePath, offset: 100 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; truncated: boolean };
      expect(r.content).toBe("");
      expect(r.totalLines).toBe(2);
      expect(r.truncated).toBe(false);
    });
  });

  describe("write_file", () => {
    it("should write file content", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/write-test.txt`;

      const result = await write_file.execute({ path: filePath, content: "new content" }, context);

      expect(result.success).toBe(true);
      expect((result.result as { bytesWritten: number }).bytesWritten).toBeGreaterThan(0);

      // Verify file was written
      const content = await Bun.file(filePath).text();
      expect(content).toBe("new content");

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await write_file.execute({ path: "/etc/unauthorized.txt", content: "test" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("list_files", () => {
    it("should list files in directory", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/list-test.txt`;

      await Bun.write(filePath, "test");

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      expect(typeof result.result).toBe("string");
      expect(result.result as string).toContain("list-test.txt");

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should handle recursive listing", async () => {
      const context = { agentId: "test-task-id" };
      const subDir = `${testDir}/subdir`;

      // Create subdirectory with file
      await Bun.write(`${subDir}/nested.txt`, "nested");

      const result = await list_files.execute({ path: testDir, recursive: true }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("subdir/");
      expect(output).toContain("subdir/nested.txt");

      // Clean up
      await rm(subDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should list directories in non-recursive mode", async () => {
      const context = { agentId: "test-task-id" };
      const subDir = `${testDir}/visible-dir`;

      await mkdir(subDir, { recursive: true });
      await Bun.write(`${testDir}/file.txt`, "test");

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("visible-dir/");
      expect(output).toContain("file.txt");

      // Clean up
      await rm(subDir, { recursive: true, force: true }).catch(() => {});
      await rm(`${testDir}/file.txt`, { force: true }).catch(() => {});
    });

    it("should return message for non-existent directory", async () => {
      const context = { agentId: "test-task-id" };
      const result = await list_files.execute({ path: `${testDir}/nonexistent-dir` }, context);

      expect(result.success).toBe(true);
      expect(result.result as string).toContain("not found");
    });

    it("should filter files by pattern (non-recursive)", async () => {
      const context = { agentId: "test-task-id" };

      // Create files with different extensions
      await Bun.write(`${testDir}/file1.ts`, "ts content");
      await Bun.write(`${testDir}/file2.js`, "js content");
      await Bun.write(`${testDir}/file3.ts`, "ts content 2");

      const result = await list_files.execute({ path: testDir, pattern: "\\.ts$" }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("file1.ts");
      expect(output).toContain("file3.ts");
      expect(output).not.toContain("file2.js");
    });

    it("should filter files by pattern (recursive)", async () => {
      const context = { agentId: "test-task-id" };
      const subDir = `${testDir}/sub-pattern`;

      // Create files in subdirectory
      await Bun.write(`${subDir}/nested1.ts`, "ts");
      await Bun.write(`${subDir}/nested2.js`, "js");

      const result = await list_files.execute({
        path: testDir,
        recursive: true,
        pattern: "\\.ts$",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Directories should still appear
      expect(output).toContain("sub-pattern/");
      // Only .ts files should appear
      expect(output).toContain("nested1.ts");
      expect(output).not.toContain("nested2.js");
    });

    it("should reject unauthorized paths via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await list_files.execute({ path: "/etc" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("edit_file", () => {
    it("should replace a unique string in a file", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/edit-test.txt`;
      await Bun.write(filePath, "Hello world, this is a test file.\nSecond line here.");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "this is a test file",
        new_string: "this is an edited file",
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { path: string; replacements: number };
      expect(r.replacements).toBe(1);

      const content = await Bun.file(filePath).text();
      expect(content).toBe("Hello world, this is an edited file.\nSecond line here.");
    });

    it("should replace all occurrences with replace_all=true", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/edit-all.txt`;
      await Bun.write(filePath, "foo bar foo baz foo");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "foo",
        new_string: "qux",
        replace_all: true,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { replacements: number };
      expect(r.replacements).toBe(3);

      const content = await Bun.file(filePath).text();
      expect(content).toBe("qux bar qux baz qux");
    });

    it("should error when old_string is not found", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/edit-notfound.txt`;
      await Bun.write(filePath, "some content here");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "nonexistent string",
        new_string: "replacement",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("old_string not found in file");
    });

    it("should error when old_string matches multiple times without replace_all", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/edit-ambiguous.txt`;
      await Bun.write(filePath, "abc def abc ghi abc");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "abc",
        new_string: "xyz",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("found 3 times");
      expect(result.error).toContain("replace_all");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await edit_file.execute({
        path: "/etc/passwd",
        old_string: "root",
        new_string: "hacked",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should error on non-existent file", async () => {
      const context = { agentId: "test-task-id" };

      const result = await edit_file.execute({
        path: `${testDir}/does-not-exist.txt`,
        old_string: "hello",
        new_string: "world",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });
  });

  describe("grep_files", () => {
    it("should search a single file and return matches with line numbers", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/grep-single.txt`;
      await Bun.write(filePath, "first line\nsecond match here\nthird line\nfourth match here");

      const result = await grep_files.execute({
        pattern: "match",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + match lines
      expect(output).toContain("=== ");
      expect(output).toContain("grep-single.txt ===");
      expect(output).toContain("2:second match here");
      expect(output).toContain("4:fourth match here");
      // No truncation footer
      expect(output).not.toContain("[");
    });

    it("should search across multiple files in a directory", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/a.txt`, "hello world");
      await Bun.write(`${testDir}/b.txt`, "hello there");
      await Bun.write(`${testDir}/c.txt`, "goodbye");

      const result = await grep_files.execute({
        pattern: "hello",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file headers for matching files
      expect(output).toContain("=== ");
      expect(output).toContain("a.txt ===");
      expect(output).toContain("b.txt ===");
      expect(output).not.toContain("c.txt");
    });

    it("should filter files with include pattern", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/code.ts`, "const x = 1;");
      await Bun.write(`${testDir}/code.js`, "const x = 2;");
      await Bun.write(`${testDir}/data.json`, '{"x": 3}');

      const result = await grep_files.execute({
        pattern: "const",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: should have file header for code.ts only
      expect(output).toContain("code.ts ===");
      expect(output).not.toContain("code.js");
      // Match line (no file prefix in grouped format)
      expect(output).toContain("1:const x = 1;");
    });

    it("should return empty string when no results found", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/nope.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "zzzzz_not_found",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe("");
    });

    it("should respect max_results and report truncation", async () => {
      const context = { agentId: "test-task-id" };
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} match`);
      await Bun.write(`${testDir}/many.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "match",
        path: `${testDir}/many.txt`,
        max_results: 5,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: header + 5 match lines
      expect(output).toContain("=== ");
      const matchLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("[") && !l.startsWith("=== ")
      );
      expect(matchLines).toHaveLength(5);
      // Truncation footer
      expect(output).toContain("[20 total matches, showing first 5]");
    });

    it("should error on invalid regex pattern", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/regex-test.txt`, "content");

      const result = await grep_files.execute({
        pattern: "[invalid",
        path: testDir,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid regex pattern");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await grep_files.execute({
        pattern: "root",
        path: "/etc",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should search recursively in subdirectories", async () => {
      const context = { agentId: "test-task-id" };
      const subDir = `${testDir}/sub`;
      await mkdir(subDir, { recursive: true });
      await Bun.write(`${testDir}/top.txt`, "find_me_here");
      await Bun.write(`${subDir}/nested.txt`, "find_me_here too");

      const result = await grep_files.execute({
        pattern: "find_me_here",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: both files appear as headers
      expect(output).toContain("=== ");
      expect(output).toContain("top.txt ===");
      expect(output).toContain("nested.txt ===");
    });

    it("should error on non-existent path", async () => {
      const context = { agentId: "test-task-id" };

      const result = await grep_files.execute({
        pattern: "test",
        path: `${testDir}/nonexistent-dir`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Path not found");
    });

    // ── case_insensitive tests ──

    it("should match case-insensitively when case_insensitive=true", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/case.txt`;
      await Bun.write(filePath, "Hello World\nhello world\nHELLO WORLD\ngoodbye");

      const result = await grep_files.execute({
        pattern: "hello",
        path: filePath,
        case_insensitive: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + 3 match lines
      expect(output).toContain("=== ");
      const matchLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("=== ")
      );
      expect(matchLines).toHaveLength(3);
      expect(output).toContain("1:Hello World");
      expect(output).toContain("2:hello world");
      expect(output).toContain("3:HELLO WORLD");
    });

    it("should be case-sensitive by default", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/case-default.txt`;
      await Bun.write(filePath, "Hello World\nhello world\nHELLO WORLD");

      const result = await grep_files.execute({
        pattern: "hello",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + 1 match line
      expect(output).toContain("=== ");
      const matchLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("=== ")
      );
      expect(matchLines).toHaveLength(1);
      expect(output).toContain("2:hello world");
    });

    // ── context_lines tests ──

    it("should include context lines when context_lines is set", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/context.txt`;
      await Bun.write(filePath, "line1\nline2\nMATCH_HERE\nline4\nline5\nline6");

      const result = await grep_files.execute({
        pattern: "MATCH_HERE",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + context lines
      expect(output).toContain("=== ");
      const contentLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("=== ") && l !== "--"
      );
      expect(contentLines).toHaveLength(3); // 1 before + match + 1 after
      // Context lines use "-N-" separator, match lines use ":N:"
      expect(output).toContain("-2-line2");
      expect(output).toContain(":3:MATCH_HERE");
      expect(output).toContain("-4-line4");
    });

    it("should merge overlapping context ranges into single block", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/context-merge.txt`;
      await Bun.write(filePath, "a\nb\nMATCH1\nd\nMATCH2\nf\ng");

      const result = await grep_files.execute({
        pattern: "MATCH",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header, then merged context block
      expect(output).toContain("=== ");
      // Overlapping ranges merged into ONE block (no "--" block separator)
      expect(output).not.toContain("\n--\n");
      // Check the 5 content lines (filter out header and empty lines)
      const contentLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("=== ") && !l.startsWith("[")
      );
      // Merged range: lines 2-6 (b, MATCH1, d, MATCH2, f)
      expect(contentLines).toHaveLength(5);
      expect(contentLines[0]).toContain("-2-b");
      expect(contentLines[1]).toContain(":3:MATCH1");
      expect(contentLines[2]).toContain("-4-d");
      expect(contentLines[3]).toContain(":5:MATCH2");
      expect(contentLines[4]).toContain("-6-f");
    });

    it("should handle context at file boundaries", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/context-boundary.txt`;
      await Bun.write(filePath, "MATCH_FIRST\nsecond\nthird");

      const result = await grep_files.execute({
        pattern: "MATCH_FIRST",
        path: filePath,
        context_lines: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + content lines
      expect(output).toContain("=== ");
      const contentLines = output.split("\n").filter(l =>
        l !== "" && !l.startsWith("=== ") && l !== "--"
      );
      // Should have 3 lines: MATCH_FIRST, second, third (no negative lines)
      expect(contentLines).toHaveLength(3);
      expect(contentLines[0]).toContain(":1:MATCH_FIRST");
      expect(contentLines[1]).toContain("-2-second");
      expect(contentLines[2]).toContain("-3-third");
    });

    // ── output_mode tests ──

    it("should return only file paths with output_mode=files_with_matches", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fwm-a.txt`, "target word here");
      await Bun.write(`${testDir}/fwm-b.txt`, "no match here");
      await Bun.write(`${testDir}/fwm-c.txt`, "another target line");

      const result = await grep_files.execute({
        pattern: "target",
        path: testDir,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "");
      expect(lines).toHaveLength(2);
      expect(lines.some(l => l.includes("fwm-a.txt"))).toBe(true);
      expect(lines.some(l => l.includes("fwm-c.txt"))).toBe(true);
      // Should NOT contain fwm-b.txt
      expect(output).not.toContain("fwm-b.txt");
    });

    it("should return match counts with output_mode=count", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/count-a.txt`, "x x x");
      await Bun.write(`${testDir}/count-b.txt`, "x");
      await Bun.write(`${testDir}/count-c.txt`, "no match");

      const result = await grep_files.execute({
        pattern: "x",
        path: testDir,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "");
      expect(lines).toHaveLength(2); // Only files with matches
      // Count format: file:count
      const countA = lines.find(l => l.includes("count-a.txt"));
      const countB = lines.find(l => l.includes("count-b.txt"));
      expect(countA).toBeDefined();
      expect(countA).toMatch(/:1$/); // "x x x" is one line with one match
      expect(countB).toBeDefined();
      expect(countB).toMatch(/:1$/);
    });

    // ── multiline tests ──

    it("should match patterns across lines with multiline=true", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/multiline.txt`;
      await Bun.write(filePath, "function foo() {\n  return 1;\n}");

      const result = await grep_files.execute({
        pattern: "foo\\(\\).*return",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + match line
      expect(output).toContain("=== ");
      // Match starts at line 1 (no-context format: lineNum:content)
      expect(output).toContain("1:");
      expect(output).toContain("foo()");
      expect(output).toContain("return");
    });

    it("should not match across lines without multiline", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/no-multiline.txt`;
      await Bun.write(filePath, "foo\nbar");

      const result = await grep_files.execute({
        pattern: "foo.bar",
        path: filePath,
        multiline: false,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe(""); // No matches
    });

    it("should match across lines with multiline=true using dotAll", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/dotall.txt`;
      await Bun.write(filePath, "foo\nbar");

      const result = await grep_files.execute({
        pattern: "foo.bar",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Grouped format: file header + match content
      expect(output).toContain("=== ");
      expect(output).toContain("foo");
      expect(output).toContain("bar");
      // Should not be empty
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("glob_files", () => {
    it("should match files by pattern", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/file1.ts`, "ts");
      await Bun.write(`${testDir}/file2.ts`, "ts");
      await Bun.write(`${testDir}/file3.js`, "js");

      const result = await glob_files.execute({
        pattern: "*.ts",
        cwd: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
      expect(lines.every(f => f.endsWith(".ts"))).toBe(true);
    }, 10000);

    it("should match files recursively", async () => {
      const context = { agentId: "test-task-id" };
      const subDir = `${testDir}/sub`;
      await mkdir(subDir, { recursive: true });
      await Bun.write(`${testDir}/top.ts`, "ts");
      await Bun.write(`${subDir}/nested.ts`, "ts");
      await Bun.write(`${subDir}/nested.js`, "js");

      const result = await glob_files.execute({
        pattern: "**/*.ts",
        cwd: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
      expect(lines.every(f => f.endsWith(".ts"))).toBe(true);
    }, 10000);

    it("should return empty results for non-matching pattern", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/file.txt`, "txt");

      const result = await glob_files.execute({
        pattern: "*.xyz",
        cwd: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe("");
    }, 10000);

    it("should respect max_results limit", async () => {
      const context = { agentId: "test-task-id" };
      // Create more files than max_results
      for (let i = 0; i < 10; i++) {
        await Bun.write(`${testDir}/file${i}.ts`, `content ${i}`);
      }

      const result = await glob_files.execute({
        pattern: "*.ts",
        cwd: testDir,
        max_results: 3,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const fileLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(fileLines).toHaveLength(3);
      // Should have truncation footer
      expect(output).toContain("[showing 3 of");
    }, 10000);

    it("should sort by mtime (newest first)", async () => {
      const context = { agentId: "test-task-id" };
      // Create files with slight time gaps
      await Bun.write(`${testDir}/old.ts`, "old");
      // Small delay to ensure different mtime
      await new Promise(resolve => setTimeout(resolve, 50));
      await Bun.write(`${testDir}/new.ts`, "new");

      const result = await glob_files.execute({
        pattern: "*.ts",
        cwd: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "");
      expect(lines[0]).toBe("new.ts");
      expect(lines[1]).toBe("old.ts");
    }, 10000);

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { agentId: "test-task-id", allowedPaths };

      const result = await glob_files.execute({
        pattern: "*.ts",
        cwd: "/etc",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    }, 10000);
  });

  // ── AbortSignal support ────────────────────────

  describe("file tools abort signal", () => {
    it("list_files returns error when abortSignal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();

      const result = await list_files.execute(
        { path: testDir, recursive: true },
        { agentId: "test", abortSignal: ac.signal },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("aborted");
    }, 10_000);

    it("glob_files returns error when abortSignal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();

      const result = await glob_files.execute(
        { pattern: "**/*.ts", cwd: testDir },
        { agentId: "test", abortSignal: ac.signal },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("aborted");
    }, 10_000);

    it("grep_files returns error when abortSignal is already aborted", async () => {
      // Create a file so the path exists and grep would normally succeed
      await Bun.write(`${testDir}/sample.txt`, "hello world\n");

      const ac = new AbortController();
      ac.abort();

      const result = await grep_files.execute(
        { pattern: "hello", path: testDir },
        { agentId: "test", abortSignal: ac.signal },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("aborted");
    }, 10_000);

    it("list_files works normally without abortSignal", async () => {
      await Bun.write(`${testDir}/normal.txt`, "content");

      const result = await list_files.execute(
        { path: testDir },
        { agentId: "test" },
      );

      expect(result.success).toBe(true);
    }, 10_000);

    it("glob_files works normally without abortSignal", async () => {
      await Bun.write(`${testDir}/normal.ts`, "content");

      const result = await glob_files.execute(
        { pattern: "*.ts", cwd: testDir },
        { agentId: "test" },
      );

      expect(result.success).toBe(true);
      expect(result.result).toContain("normal.ts");
    }, 10_000);

    it("grep_files works normally without abortSignal", async () => {
      await Bun.write(`${testDir}/normal.txt`, "hello world\n");

      const result = await grep_files.execute(
        { pattern: "hello", path: testDir },
        { agentId: "test" },
      );

      expect(result.success).toBe(true);
    }, 10_000);
  });

  // ── list_files truncation ──

  describe("list_files truncation", () => {
    it("should truncate output when entries exceed limit", async () => {
      const context = { agentId: "test-task-id" };

      // Create enough files to exceed a small limit
      for (let i = 0; i < 10; i++) {
        await Bun.write(`${testDir}/trunc-file-${i}.txt`, `content ${i}`);
      }

      const result = await list_files.execute(
        { path: testDir, limit: 3 },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("[Truncated:");
      expect(output).toContain("showing 3 of more entries");
    }, 10_000);
  });

  // ── formatSize coverage (indirectly via list_files) ──

  describe("list_files formatSize", () => {
    it("should format file sizes in KB for files >= 1KB", async () => {
      const context = { agentId: "test-task-id" };
      // Create a file > 1KB
      const filePath = `${testDir}/medium-file.txt`;
      await Bun.write(filePath, "x".repeat(2048)); // 2KB

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("medium-file.txt");
      // Should show KB format: "2.0K"
      expect(output).toMatch(/\d+\.\d+K/);
    }, 10_000);

    it("should format file sizes in MB for files >= 1MB", async () => {
      const context = { agentId: "test-task-id" };
      // Create a file > 1MB
      const filePath = `${testDir}/large-file.txt`;
      await Bun.write(filePath, "x".repeat(1024 * 1024 + 1)); // ~1MB

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("large-file.txt");
      // Should show MB format: "1.0M"
      expect(output).toMatch(/\d+\.\d+M/);
    }, 10_000);

    it("should format file sizes in bytes for small files", async () => {
      const context = { agentId: "test-task-id" };
      // Create a small file < 1KB
      const filePath = `${testDir}/tiny-file.txt`;
      await Bun.write(filePath, "hi");

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("tiny-file.txt");
      // Should show bytes format: "2B"
      expect(output).toMatch(/\d+B/);
    }, 10_000);
  });

  // ── grep_files rg execution paths ──

  describe("grep_files rg path", () => {
    let originalRgState: boolean;

    beforeEach(async () => {
      originalRgState = isRgAvailable();
    });

    afterEach(async () => {
      _resetRgCache(originalRgState);
    });

    it("should use rg for files_with_matches mode and return file paths", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-fwm-1.txt`, "rg_fwm_test_target");
      await Bun.write(`${testDir}/rg-fwm-2.txt`, "no match");

      const result = await grep_files.execute({
        pattern: "rg_fwm_test_target",
        path: testDir,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-fwm-1.txt");
      expect(output).not.toContain("rg-fwm-2.txt");
    }, 10_000);

    it("should use rg for count mode", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-cnt.txt`, "line1 cnt_target\nline2 cnt_target\nline3");

      const result = await grep_files.execute({
        pattern: "cnt_target",
        path: `${testDir}/rg-cnt.txt`,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":2");
    }, 10_000);

    it("should use rg for content mode with context_lines", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-ctx.txt`, "before\nMATCH_RG_CTX\nafter");

      const result = await grep_files.execute({
        pattern: "MATCH_RG_CTX",
        path: `${testDir}/rg-ctx.txt`,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-ctx.txt ===");
      expect(output).toContain("-1-before");
      expect(output).toContain(":2:MATCH_RG_CTX");
      expect(output).toContain("-3-after");
    }, 10_000);

    it("should use rg for content mode with truncation", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} rg_trunc_target`);
      await Bun.write(`${testDir}/rg-trunc.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "rg_trunc_target",
        path: `${testDir}/rg-trunc.txt`,
        max_results: 5,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("[20 total matches, showing first 5]");
    }, 10_000);

    it("should use rg with case_insensitive flag", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-ci.txt`, "UPPER\nlower\nMixed");

      const result = await grep_files.execute({
        pattern: "upper",
        path: `${testDir}/rg-ci.txt`,
        case_insensitive: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("1:UPPER");
    }, 10_000);

    it("should use rg with multiline flag", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-ml.txt`, "alpha\nbeta\ngamma");

      const result = await grep_files.execute({
        pattern: "alpha.beta",
        path: `${testDir}/rg-ml.txt`,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("alpha");
      expect(output).toContain("beta");
    }, 10_000);

    it("should use rg with include glob filter", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-inc.ts`, "rg_inc_target");
      await Bun.write(`${testDir}/rg-inc.py`, "rg_inc_target");

      const result = await grep_files.execute({
        pattern: "rg_inc_target",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-inc.ts");
      expect(output).not.toContain("rg-inc.py");
    }, 10_000);

    it("should handle rg with block separators between non-contiguous context ranges", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      const lines = [
        "line1", "BLOCK_SEP_MATCH1", "line3",
        "line4", "line5", "line6", "line7", "line8",
        "line9", "BLOCK_SEP_MATCH2", "line11",
      ];
      await Bun.write(`${testDir}/rg-sep.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "BLOCK_SEP_MATCH",
        path: `${testDir}/rg-sep.txt`,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":2:BLOCK_SEP_MATCH1");
      expect(output).toContain(":10:BLOCK_SEP_MATCH2");
      expect(output).toContain("--");
    }, 10_000);

    it("should handle rg with multiple files producing separate file headers", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-multi-a.txt`, "multi_rg_target");
      await Bun.write(`${testDir}/rg-multi-b.txt`, "multi_rg_target");

      const result = await grep_files.execute({
        pattern: "multi_rg_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-multi-a.txt ===");
      expect(output).toContain("rg-multi-b.txt ===");
    }, 10_000);
  });

  // ── grep_files JS fallback error handling ──

  describe("grep_files JS fallback error handling", () => {
    let originalRgState: boolean;

    beforeEach(async () => {
      originalRgState = isRgAvailable();
      _resetRgCache(false); // force JS fallback
    });

    afterEach(async () => {
      _resetRgCache(originalRgState);
    });

    it("should gracefully handle unreadable files in searchFileLineByLine", async () => {
      const context = { agentId: "test-task-id" };
      const unreadableDir = `${testDir}/unreadable-files`;
      await mkdir(unreadableDir, { recursive: true });
      const goodFile = `${unreadableDir}/good.txt`;
      const badFile = `${unreadableDir}/bad.txt`;

      await Bun.write(goodFile, "fallback_err_target");
      await Bun.write(badFile, "fallback_err_target");
      // Make file unreadable
      await chmod(badFile, 0o000);

      const result = await grep_files.execute({
        pattern: "fallback_err_target",
        path: unreadableDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find match in good file, skip the unreadable one
      expect(output).toContain("good.txt");

      // Restore permissions for cleanup
      await chmod(badFile, 0o644);
    }, 10_000);

    it("should gracefully handle unreadable files in searchFileMultiline", async () => {
      const context = { agentId: "test-task-id" };
      const unreadableDir = `${testDir}/unreadable-ml`;
      await mkdir(unreadableDir, { recursive: true });
      const goodFile = `${unreadableDir}/good.txt`;
      const badFile = `${unreadableDir}/bad.txt`;

      await Bun.write(goodFile, "ml\nerr_target");
      await Bun.write(badFile, "ml\nerr_target");
      // Make file unreadable
      await chmod(badFile, 0o000);

      const result = await grep_files.execute({
        pattern: "ml.err_target",
        path: unreadableDir,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find match in good file, skip the unreadable one
      expect(output).toContain("good.txt");

      // Restore permissions for cleanup
      await chmod(badFile, 0o644);
    }, 10_000);

    it("should gracefully handle unreadable directories in walkDir", async () => {
      const context = { agentId: "test-task-id" };
      const walkErrDir = `${testDir}/walk-err`;
      const unreadable = `${walkErrDir}/no-access`;
      const readable = `${walkErrDir}/ok`;
      await mkdir(unreadable, { recursive: true });
      await mkdir(readable, { recursive: true });
      await Bun.write(`${readable}/file.txt`, "walk_err_target");
      await Bun.write(`${unreadable}/file.txt`, "walk_err_target");

      // Make directory unreadable
      await chmod(unreadable, 0o000);

      const result = await grep_files.execute({
        pattern: "walk_err_target",
        path: walkErrDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("file.txt");

      // Restore permissions for cleanup
      await chmod(unreadable, 0o755);
    }, 10_000);
  });

  // ── grep_files JS fallback comprehensive (covers streaming, context, modes) ──

  describe("grep_files JS fallback paths", () => {
    let originalRgState: boolean;

    beforeEach(async () => {
      originalRgState = isRgAvailable();
      _resetRgCache(false); // force JS fallback
    });

    afterEach(async () => {
      _resetRgCache(originalRgState);
    });

    it("should search single file with line-by-line mode", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-single.txt`;
      await Bun.write(filePath, "first line\nsecond match_fb\nthird line\nfourth match_fb");

      const result = await grep_files.execute({
        pattern: "match_fb",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("=== ");
      expect(output).toContain("2:second match_fb");
      expect(output).toContain("4:fourth match_fb");
    }, 10_000);

    it("should search directory with include filter", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-inc.ts`, "fb_inc_target");
      await Bun.write(`${testDir}/fb-inc.py`, "fb_inc_target");

      const result = await grep_files.execute({
        pattern: "fb_inc_target",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-inc.ts");
      expect(output).not.toContain("fb-inc.py");
    }, 10_000);

    it("should handle files_with_matches mode", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-fwm-a.txt`, "fb_fwm_target");
      await Bun.write(`${testDir}/fb-fwm-b.txt`, "nothing");

      const result = await grep_files.execute({
        pattern: "fb_fwm_target",
        path: testDir,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-fwm-a.txt");
      expect(output).not.toContain("fb-fwm-b.txt");
    }, 10_000);

    it("should handle count mode", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-count.txt`, "x\nx\nx");

      const result = await grep_files.execute({
        pattern: "x",
        path: `${testDir}/fb-count.txt`,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":3");
    }, 10_000);

    it("should handle case_insensitive in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-ci.txt`, "Hello HELLO hello");

      const result = await grep_files.execute({
        pattern: "hello",
        path: `${testDir}/fb-ci.txt`,
        case_insensitive: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("Hello HELLO hello");
    }, 10_000);

    it("should handle context_lines in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-ctx.txt`;
      await Bun.write(filePath, "line1\nline2\nMATCH_FB_CTX\nline4\nline5");

      const result = await grep_files.execute({
        pattern: "MATCH_FB_CTX",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("-2-line2");
      expect(output).toContain(":3:MATCH_FB_CTX");
      expect(output).toContain("-4-line4");
    }, 10_000);

    it("should handle context with non-contiguous blocks (-- separators)", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-sep.txt`;
      const lines = [
        "line1", "FB_SEP_MATCH1", "line3",
        "line4", "line5", "line6", "line7", "line8",
        "line9", "FB_SEP_MATCH2", "line11",
      ];
      await Bun.write(filePath, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "FB_SEP_MATCH",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":2:FB_SEP_MATCH1");
      expect(output).toContain(":10:FB_SEP_MATCH2");
      expect(output).toContain("--");
    }, 10_000);

    it("should handle multiline content mode in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-ml.txt`;
      await Bun.write(filePath, "start\nmatch_this\nend");

      const result = await grep_files.execute({
        pattern: "start.match_this",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("=== ");
      expect(output).toContain("1:");
    }, 10_000);

    it("should handle multiline files_with_matches in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-ml-fwm-a.txt`, "foo\nbar_ml_fb");
      await Bun.write(`${testDir}/fb-ml-fwm-b.txt`, "no match");

      const result = await grep_files.execute({
        pattern: "foo.bar_ml_fb",
        path: testDir,
        multiline: true,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-ml-fwm-a.txt");
      expect(output).not.toContain("fb-ml-fwm-b.txt");
    }, 10_000);

    it("should handle multiline count mode in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-ml-cnt.txt`;
      await Bun.write(filePath, "aa\nbb\naa\nbb");

      const result = await grep_files.execute({
        pattern: "aa.bb",
        path: filePath,
        multiline: true,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":2");
    }, 10_000);

    it("should truncate content mode results at max_results", async () => {
      const context = { agentId: "test-task-id" };
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} fb_trunc_match`);
      await Bun.write(`${testDir}/fb-trunc.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "fb_trunc_match",
        path: `${testDir}/fb-trunc.txt`,
        max_results: 5,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("[20 total matches, showing first 5]");
    }, 10_000);

    it("should handle multiline content truncation at max_results", async () => {
      const context = { agentId: "test-task-id" };
      const content = Array.from({ length: 20 }, (_, i) => `start${i}\nend${i}`).join("\n");
      await Bun.write(`${testDir}/fb-ml-trunc.txt`, content);

      const result = await grep_files.execute({
        pattern: "start\\d+.end\\d+",
        path: `${testDir}/fb-ml-trunc.txt`,
        multiline: true,
        max_results: 3,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("total matches");
    }, 10_000);

    it("should handle files_with_matches truncation at max_results", async () => {
      const context = { agentId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/fb-fwm-trunc-${i}.txt`, "fb_fwm_trunc\nfb_fwm_trunc\nfb_fwm_trunc");
      }

      const result = await grep_files.execute({
        pattern: "fb_fwm_trunc",
        path: testDir,
        output_mode: "files_with_matches",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
      expect(output).toContain("total matches");
    }, 10_000);

    it("should handle count truncation at max_results", async () => {
      const context = { agentId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/fb-cnt-trunc-${i}.txt`, "fb_cnt_trunc");
      }

      const result = await grep_files.execute({
        pattern: "fb_cnt_trunc",
        path: testDir,
        output_mode: "count",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(countLines).toHaveLength(2);
    }, 10_000);

    it("should search multiple files in directory", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-dir-a.txt`, "fb_dir_target");
      await Bun.write(`${testDir}/fb-dir-b.txt`, "fb_dir_target");
      await Bun.write(`${testDir}/fb-dir-c.txt`, "no match");

      const result = await grep_files.execute({
        pattern: "fb_dir_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-dir-a.txt ===");
      expect(output).toContain("fb-dir-b.txt ===");
      expect(output).not.toContain("fb-dir-c.txt");
    }, 10_000);

    it("should handle multiline max_results truncation for files_with_matches", async () => {
      const context = { agentId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/fb-ml-fwm-t-${i}.txt`, "ml\ntarget_fb");
      }

      const result = await grep_files.execute({
        pattern: "ml.target_fb",
        path: testDir,
        multiline: true,
        output_mode: "files_with_matches",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
    }, 10_000);

    it("should handle multiline max_results truncation for count mode", async () => {
      const context = { agentId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/fb-ml-cnt-t-${i}.txt`, "ml\ntarget_fb");
      }

      const result = await grep_files.execute({
        pattern: "ml.target_fb",
        path: testDir,
        multiline: true,
        output_mode: "count",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(countLines).toHaveLength(2);
    }, 10_000);

    it("should skip binary files in JS fallback line-by-line mode", async () => {
      const context = { agentId: "test-task-id" };
      const binaryFile = `${testDir}/fb-binary.dat`;
      // Create a file with null bytes (binary)
      const buf = Buffer.alloc(100);
      buf[10] = 0; // null byte → binary
      buf.write("searchable_text", 20);
      await Bun.write(binaryFile, buf);

      const textFile = `${testDir}/fb-text.txt`;
      await Bun.write(textFile, "searchable_text here");

      const result = await grep_files.execute({
        pattern: "searchable_text",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find in text file but not binary
      expect(output).toContain("fb-text.txt");
      expect(output).not.toContain("fb-binary.dat");
    }, 10_000);

    it("should skip binary files in JS fallback multiline mode", async () => {
      const context = { agentId: "test-task-id" };
      const binaryFile = `${testDir}/fb-ml-binary.dat`;
      const buf = Buffer.alloc(100);
      buf[10] = 0;
      buf.write("ml_binary_target", 20);
      await Bun.write(binaryFile, buf);

      const textFile = `${testDir}/fb-ml-text.txt`;
      await Bun.write(textFile, "ml\nbinary_target");

      const result = await grep_files.execute({
        pattern: "ml.binary_target",
        path: testDir,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-ml-text.txt");
      expect(output).not.toContain("fb-ml-binary.dat");
    }, 10_000);

    it("should handle zero-length regex matches in multiline mode", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-zero-match.txt`;
      await Bun.write(filePath, "abc");

      // Pattern that can produce zero-length match
      const result = await grep_files.execute({
        pattern: "a?",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
    }, 10_000);

    it("should respect .gitignore patterns in JS fallback directory search", async () => {
      const context = { agentId: "test-task-id" };
      const searchDir = `${testDir}/gitignore-test`;
      await mkdir(`${searchDir}/included`, { recursive: true });
      await mkdir(`${searchDir}/ignored-dir`, { recursive: true });

      // Create .gitignore
      await Bun.write(`${searchDir}/.gitignore`, "ignored-dir/\nignored-file.txt\n");
      // Create files
      await Bun.write(`${searchDir}/included/good.txt`, "gitignore_target");
      await Bun.write(`${searchDir}/ignored-dir/bad.txt`, "gitignore_target");
      await Bun.write(`${searchDir}/ignored-file.txt`, "gitignore_target");
      await Bun.write(`${searchDir}/visible.txt`, "gitignore_target");

      const result = await grep_files.execute({
        pattern: "gitignore_target",
        path: searchDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("good.txt");
      expect(output).toContain("visible.txt");
      // gitignored files should be skipped
      expect(output).not.toContain("ignored-dir");
      expect(output).not.toContain("ignored-file.txt");
    }, 10_000);

    it("should skip SKIP_DIRS like node_modules in JS fallback", async () => {
      const context = { agentId: "test-task-id" };
      const searchDir = `${testDir}/skipdir-test`;
      await mkdir(`${searchDir}/node_modules`, { recursive: true });
      await mkdir(`${searchDir}/src`, { recursive: true });

      await Bun.write(`${searchDir}/node_modules/pkg.txt`, "skipdir_target");
      await Bun.write(`${searchDir}/src/app.txt`, "skipdir_target");

      const result = await grep_files.execute({
        pattern: "skipdir_target",
        path: searchDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("app.txt");
      expect(output).not.toContain("node_modules");
    }, 10_000);

    it("should handle include filter with {ts,js} alternation via globToRegex", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/fb-alt.ts`, "alt_target");
      await Bun.write(`${testDir}/fb-alt.js`, "alt_target");
      await Bun.write(`${testDir}/fb-alt.py`, "alt_target");

      const result = await grep_files.execute({
        pattern: "alt_target",
        path: testDir,
        include: "*.{ts,js}",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-alt.ts");
      expect(output).toContain("fb-alt.js");
      expect(output).not.toContain("fb-alt.py");
    }, 10_000);

    it("should handle streaming with remaining buffer (last line without newline)", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-noeol.txt`;
      // File without trailing newline
      await Bun.write(filePath, "line1\nfb_noeol_match");

      const result = await grep_files.execute({
        pattern: "fb_noeol_match",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("2:fb_noeol_match");
    }, 10_000);

    it("should handle context_lines with remaining buffer match at EOF", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-ctx-eof.txt`;
      await Bun.write(filePath, "before\nFB_CTX_EOF_MATCH");

      const result = await grep_files.execute({
        pattern: "FB_CTX_EOF_MATCH",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("-1-before");
      expect(output).toContain(":2:FB_CTX_EOF_MATCH");
    }, 10_000);

    it("should handle multiline match > 200 chars truncation", async () => {
      const context = { agentId: "test-task-id" };
      const filePath = `${testDir}/fb-ml-long.txt`;
      const longContent = "start_" + "x".repeat(300) + "_end";
      await Bun.write(filePath, longContent);

      const result = await grep_files.execute({
        pattern: "start_x+_end",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Match should be truncated to 200 chars + "..."
      expect(output).toContain("...");
    }, 10_000);
  });

  // ── grep_files rg parser edge cases ──

  describe("grep_files rg parser paths", () => {
    let originalRgState: boolean;

    beforeEach(async () => {
      originalRgState = isRgAvailable();
    });

    afterEach(async () => {
      _resetRgCache(originalRgState);
    });

    it("should handle rg content mode with no context (no leading colon)", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-nocol.txt`, "no_ctx_match_line\nother");

      const result = await grep_files.execute({
        pattern: "no_ctx_match_line",
        path: `${testDir}/rg-nocol.txt`,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Without context, match format is "lineNum:content" (no leading colon)
      expect(output).toContain("1:no_ctx_match_line");
    }, 10_000);

    it("should handle rg with empty output (no matches)", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-empty.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "zzzzz_absolutely_not_found",
        path: `${testDir}/rg-empty.txt`,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe("");
    }, 10_000);

    it("should handle rg count mode with empty output", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-cnt-empty.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "zzzzz_not_found_count",
        path: `${testDir}/rg-cnt-empty.txt`,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe("");
    }, 10_000);

    it("should handle rg files_with_matches with empty output", async () => {
      if (!isRgAvailable()) return;

      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/rg-fwm-empty.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "zzzzz_not_found_fwm",
        path: `${testDir}/rg-fwm-empty.txt`,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe("");
    }, 10_000);
  });

  // ── write_file parent directory creation ──

  describe("write_file parent directory creation", () => {
    it("should create parent directories automatically", async () => {
      const context = { agentId: "test-task-id" };
      const deepPath = `${testDir}/deep/nested/dir/file.txt`;

      const result = await write_file.execute({
        path: deepPath,
        content: "deep content",
      }, context);

      expect(result.success).toBe(true);
      const content = await Bun.file(deepPath).text();
      expect(content).toBe("deep content");
    }, 10_000);
  });

  // ── list_files limit clamping ──

  describe("list_files limit clamping", () => {
    it("should clamp limit to minimum 1", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/clamp.txt`, "content");

      const result = await list_files.execute(
        { path: testDir, limit: 0 },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      // With limit clamped to 1, should show at most 1 entry
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines.length).toBeLessThanOrEqual(1);
    }, 10_000);

    it("should clamp limit to maximum 2000", async () => {
      const context = { agentId: "test-task-id" };
      await Bun.write(`${testDir}/clamp-max.txt`, "content");

      const result = await list_files.execute(
        { path: testDir, limit: 9999 },
        context,
      );

      expect(result.success).toBe(true);
      // Should not error — limit silently clamped
    }, 10_000);
  });

  // ── glob_files abort signal ──

  describe("glob_files edge cases", () => {
    it("should use cwd when cwd param is not provided", async () => {
      const context = { agentId: "test-task-id" };

      // Just run without cwd — should use process.cwd()
      const result = await glob_files.execute(
        { pattern: "*.nonexistent_glob_test_ext_xyz" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("");
    }, 10_000);
  });
});
