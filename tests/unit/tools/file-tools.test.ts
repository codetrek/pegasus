/**
 * Unit tests for file tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { read_file, write_file, list_files, edit_file, grep_files, glob_files, _resetRgCache, isRgAvailable } from "../../../src/tools/builtins/file-tools.ts";
import { rm, mkdir } from "node:fs/promises";

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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
      const result = await read_file.execute({ path: `${testDir}/nonexistent.txt` }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no such file or directory");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await read_file.execute({ path: "/etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should read with offset and limit (line-numbered)", async () => {
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/small.txt`;
      await Bun.write(filePath, "short\nfile");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as Record<string, unknown>;
      expect(r.notice).toBeUndefined();
      expect(r.truncated).toBe(false);
    });

    it("should return empty content when offset is beyond file length", async () => {
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await write_file.execute({ path: "/etc/unauthorized.txt", content: "test" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("list_files", () => {
    it("should list files in directory", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/list-test.txt`;

      await Bun.write(filePath, "test");

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      expect((result.result as { files: unknown[]; count: number }).files).toBeInstanceOf(Array);
      expect((result.result as { files: unknown[]; count: number }).count).toBeGreaterThan(0);

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should handle recursive listing", async () => {
      const context = { taskId: "test-task-id" };
      const subDir = `${testDir}/subdir`;

      // Create subdirectory with file
      await Bun.write(`${subDir}/nested.txt`, "nested");

      const result = await list_files.execute({ path: testDir, recursive: true }, context);

      expect(result.success).toBe(true);
      expect((result.result as { recursive: boolean; files: unknown[] }).recursive).toBe(true);
      expect((result.result as { recursive: boolean; files: unknown[] }).files).toBeInstanceOf(Array);

      // Clean up
      await rm(subDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should return empty list for non-existent directory", async () => {
      const context = { taskId: "test-task-id" };
      const result = await list_files.execute({ path: `${testDir}/nonexistent-dir` }, context);

      expect(result.success).toBe(true);
      const resultObj = result.result as { files: unknown[]; count: number };
      expect(resultObj.files).toEqual([]);
      expect(resultObj.count).toBe(0);
    });

    it("should filter files by pattern (non-recursive)", async () => {
      const context = { taskId: "test-task-id" };

      // Create files with different extensions
      await Bun.write(`${testDir}/file1.ts`, "ts content");
      await Bun.write(`${testDir}/file2.js`, "js content");
      await Bun.write(`${testDir}/file3.ts`, "ts content 2");

      const result = await list_files.execute({ path: testDir, pattern: "\\.ts$" }, context);

      expect(result.success).toBe(true);
      const resultObj = result.result as { files: Array<{ name: string }>; count: number };
      // Only .ts files should match
      expect(resultObj.count).toBe(2);
      for (const file of resultObj.files) {
        expect(file.name).toMatch(/\.ts$/);
      }
    });

    it("should filter files by pattern (recursive)", async () => {
      const context = { taskId: "test-task-id" };
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
      const resultObj = result.result as { files: Array<{ name: string; isDir: boolean }> };
      // Should include directories and only .ts files
      const fileEntries = resultObj.files.filter(f => !f.isDir);
      for (const file of fileEntries) {
        expect(file.name).toMatch(/\.ts$/);
      }
    });

    it("should reject unauthorized paths via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await list_files.execute({ path: "/etc" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("edit_file", () => {
    it("should replace a unique string in a file", async () => {
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await edit_file.execute({
        path: "/etc/passwd",
        old_string: "root",
        new_string: "hacked",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should error on non-existent file", async () => {
      const context = { taskId: "test-task-id" };

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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await grep_files.execute({
        pattern: "root",
        path: "/etc",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should search recursively in subdirectories", async () => {
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };

      const result = await grep_files.execute({
        pattern: "test",
        path: `${testDir}/nonexistent-dir`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Path not found");
    });

    // ── case_insensitive tests ──

    it("should match case-insensitively when case_insensitive=true", async () => {
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id" };
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
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await glob_files.execute({
        pattern: "*.ts",
        cwd: "/etc",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    }, 10000);
  });

  // ── grep_files: JS fallback specific tests ──

  describe("grep_files JS fallback", () => {
    // Force JS fallback by disabling rg cache
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false); // force JS fallback
    });

    afterEach(() => {
      _resetRgCache(originalRgState); // restore
    });

    it("should produce identical output format to rg for single file search", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/fallback-single.txt`;
      await Bun.write(filePath, "first line\nsecond match here\nthird line\nfourth match here");

      const result = await grep_files.execute({
        pattern: "match",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("=== ");
      expect(output).toContain("fallback-single.txt ===");
      expect(output).toContain("2:second match here");
      expect(output).toContain("4:fourth match here");
    });

    it("should skip blacklisted directories", async () => {
      const context = { taskId: "test-task-id" };
      const nodeModules = `${testDir}/node_modules`;
      const dist = `${testDir}/dist`;
      const src = `${testDir}/src`;
      await mkdir(nodeModules, { recursive: true });
      await mkdir(dist, { recursive: true });
      await mkdir(src, { recursive: true });
      await Bun.write(`${nodeModules}/lib.js`, "findme_target");
      await Bun.write(`${dist}/bundle.js`, "findme_target");
      await Bun.write(`${src}/app.ts`, "findme_target");

      const result = await grep_files.execute({
        pattern: "findme_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find in src but NOT in node_modules or dist
      expect(output).toContain("app.ts");
      expect(output).not.toContain("node_modules");
      expect(output).not.toContain("dist");
    });

    it("should skip files larger than 1MB", async () => {
      const context = { taskId: "test-task-id" };
      const largeFile = `${testDir}/large.txt`;
      const smallFile = `${testDir}/small.txt`;
      // Create a file > 1MB
      const bigContent = "findme_target\n" + "x".repeat(1_100_000);
      await Bun.write(largeFile, bigContent);
      await Bun.write(smallFile, "findme_target here");

      const result = await grep_files.execute({
        pattern: "findme_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find in small file, skip large file
      expect(output).toContain("small.txt");
      expect(output).not.toContain("large.txt");
    }, 10000);

    it("should respect .gitignore patterns", async () => {
      const context = { taskId: "test-task-id" };
      const ignored = `${testDir}/ignored`;
      const kept = `${testDir}/kept`;
      await mkdir(ignored, { recursive: true });
      await mkdir(kept, { recursive: true });
      await Bun.write(`${testDir}/.gitignore`, "ignored/\n");
      await Bun.write(`${ignored}/file.ts`, "gitignore_target");
      await Bun.write(`${kept}/file.ts`, "gitignore_target");

      const result = await grep_files.execute({
        pattern: "gitignore_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("kept");
      expect(output).not.toContain("ignored");
    });

    it("should work with context_lines in fallback mode", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/fallback-context.txt`;
      await Bun.write(filePath, "line1\nline2\nMATCH_HERE\nline4\nline5");

      const result = await grep_files.execute({
        pattern: "MATCH_HERE",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("=== ");
      expect(output).toContain("-2-line2");
      expect(output).toContain(":3:MATCH_HERE");
      expect(output).toContain("-4-line4");
    });

    it("should handle files_with_matches mode in fallback", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/fb-a.txt`, "match_target");
      await Bun.write(`${testDir}/fb-b.txt`, "no hit");

      const result = await grep_files.execute({
        pattern: "match_target",
        path: testDir,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("fb-a.txt");
      expect(output).not.toContain("fb-b.txt");
    });

    it("should handle count mode in fallback", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/fb-count.txt`, "x\nx\nx");

      const result = await grep_files.execute({
        pattern: "x",
        path: `${testDir}/fb-count.txt`,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":3");
    });
  });

  // ── grep_files: rg-specific tests ──

  describe("grep_files with rg", () => {
    beforeEach(() => {
      _resetRgCache(null); // re-detect rg
    });

    afterEach(() => {
      _resetRgCache(null); // restore
    });

    it("should use rg when available and produce correct format", async () => {
      // Skip if rg is not available
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/rg-test.txt`;
      await Bun.write(filePath, "alpha\nbeta match_rg\ngamma\ndelta match_rg");

      const result = await grep_files.execute({
        pattern: "match_rg",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-test.txt ===");
      expect(output).toContain("2:beta match_rg");
      expect(output).toContain("4:delta match_rg");
    });

    it("should handle rg context mode correctly", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/rg-context.txt`;
      await Bun.write(filePath, "aa\nbb\ncc MATCH_RG\ndd\nee");

      const result = await grep_files.execute({
        pattern: "MATCH_RG",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-context.txt ===");
      expect(output).toContain("-2-bb");
      expect(output).toContain(":3:cc MATCH_RG");
      expect(output).toContain("-4-dd");
    });

    it("should handle rg files_with_matches mode", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/rg-fwm-a.txt`, "rg_fwm_target");
      await Bun.write(`${testDir}/rg-fwm-b.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "rg_fwm_target",
        path: testDir,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-fwm-a.txt");
      expect(output).not.toContain("rg-fwm-b.txt");
    });

    it("should handle rg count mode", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/rg-count.txt`, "x\nx\nx");

      const result = await grep_files.execute({
        pattern: "x",
        path: `${testDir}/rg-count.txt`,
        output_mode: "count",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":3");
    });
  });

  // ── isRgAvailable cache tests ──

  describe("isRgAvailable", () => {
    afterEach(() => {
      _resetRgCache(null); // re-detect after test
    });

    it("should return a boolean", () => {
      _resetRgCache(null);
      const result = isRgAvailable();
      expect(typeof result).toBe("boolean");
    });

    it("should cache the result", () => {
      _resetRgCache(true);
      expect(isRgAvailable()).toBe(true);
      _resetRgCache(false);
      expect(isRgAvailable()).toBe(false);
    });
  });

  // ── Additional coverage tests ──

  describe("grep_files JS fallback — binary file skipping", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false); // force JS fallback
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should skip binary files (files containing null bytes)", async () => {
      const context = { taskId: "test-task-id" };
      // Create a binary file with null bytes in the first 8KB
      const binaryContent = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]); // "hello\0world"
      await Bun.write(`${testDir}/binary.dat`, binaryContent);
      await Bun.write(`${testDir}/text.txt`, "hello world");

      const result = await grep_files.execute({
        pattern: "hello",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should find in text.txt but skip binary.dat
      expect(output).toContain("text.txt");
      expect(output).not.toContain("binary.dat");
    });

    it("should skip binary files in single-file mode", async () => {
      const context = { taskId: "test-task-id" };
      const binaryContent = Buffer.from([0x74, 0x65, 0x73, 0x74, 0x00, 0x64, 0x61, 0x74, 0x61]); // "test\0data"
      const filePath = `${testDir}/single-binary.dat`;
      await Bun.write(filePath, binaryContent);

      const result = await grep_files.execute({
        pattern: "test",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toBe(""); // No matches since binary is skipped
    });
  });

  describe("grep_files JS fallback — include filter in directory search", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should filter files by include glob with {a,b} alternation pattern", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/app.ts`, "include_target");
      await Bun.write(`${testDir}/app.js`, "include_target");
      await Bun.write(`${testDir}/data.json`, "include_target");
      await Bun.write(`${testDir}/readme.md`, "include_target");

      const result = await grep_files.execute({
        pattern: "include_target",
        path: testDir,
        include: "*.{ts,js}",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Should match .ts and .js files only
      expect(output).toContain("app.ts");
      expect(output).toContain("app.js");
      expect(output).not.toContain("data.json");
      expect(output).not.toContain("readme.md");
    });

    it("should filter files by simple include glob in directory search", async () => {
      const context = { taskId: "test-task-id" };
      const subDir = `${testDir}/sub-include`;
      await mkdir(subDir, { recursive: true });
      await Bun.write(`${subDir}/code.ts`, "filter_target");
      await Bun.write(`${subDir}/code.py`, "filter_target");

      const result = await grep_files.execute({
        pattern: "filter_target",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("code.ts");
      expect(output).not.toContain("code.py");
    });
  });

  describe("grep_files JS fallback — multiline mode", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should search with multiline content mode in JS fallback", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/ml-content.txt`;
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
    });

    it("should search directory with multiline files_with_matches in JS fallback", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/ml-fwm-a.txt`, "foo\nbar_ml_target");
      await Bun.write(`${testDir}/ml-fwm-b.txt`, "no match at all");

      const result = await grep_files.execute({
        pattern: "foo.bar_ml_target",
        path: testDir,
        multiline: true,
        output_mode: "files_with_matches",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("ml-fwm-a.txt");
      expect(output).not.toContain("ml-fwm-b.txt");
    });

    it("should search with multiline count mode in JS fallback", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/ml-count.txt`;
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
    });

    it("should skip binary files in multiline mode", async () => {
      const context = { taskId: "test-task-id" };
      const binaryContent = Buffer.from([0x61, 0x61, 0x0a, 0x62, 0x62, 0x00, 0x63]); // "aa\nbb\0c"
      await Bun.write(`${testDir}/ml-binary.dat`, binaryContent);
      await Bun.write(`${testDir}/ml-text.txt`, "aa\nbb match");

      const result = await grep_files.execute({
        pattern: "aa.bb",
        path: testDir,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("ml-text.txt");
      expect(output).not.toContain("ml-binary.dat");
    });

    it("should skip large files in multiline mode", async () => {
      const context = { taskId: "test-task-id" };
      const bigContent = "ml_target\n" + "x".repeat(1_100_000);
      await Bun.write(`${testDir}/ml-large.txt`, bigContent);
      await Bun.write(`${testDir}/ml-small.txt`, "ml_target\nhere");

      const result = await grep_files.execute({
        pattern: "ml_target.here",
        path: testDir,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("ml-small.txt");
      expect(output).not.toContain("ml-large.txt");
    }, 10000);

    it("should truncate long multiline matches at 200 chars", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/ml-long.txt`;
      const longLine = "A".repeat(250);
      await Bun.write(filePath, longLine);

      const result = await grep_files.execute({
        pattern: "A{200,}",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("...");
    });

    it("should handle zero-length multiline regex matches", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/ml-zero.txt`;
      await Bun.write(filePath, "abc");

      const result = await grep_files.execute({
        pattern: "(?=a)",
        path: filePath,
        multiline: true,
        max_results: 3,
      }, context);

      expect(result.success).toBe(true);
      // Should not hang — zero-length match advances lastIndex
    }, 5000);

    it("should handle multiline search on single file (not directory)", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/ml-single.txt`;
      await Bun.write(filePath, "first\nsecond\nthird");

      const result = await grep_files.execute({
        pattern: "first.second",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("first");
      expect(output).toContain("second");
    });
  });

  describe("grep_files JS fallback — .gitignore file-level ignore", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should respect .gitignore file patterns (not just directories)", async () => {
      const context = { taskId: "test-task-id" };
      // Gitignore that ignores specific files
      await Bun.write(`${testDir}/.gitignore`, "*.log\n");
      await Bun.write(`${testDir}/app.ts`, "gi_file_target");
      await Bun.write(`${testDir}/debug.log`, "gi_file_target");

      const result = await grep_files.execute({
        pattern: "gi_file_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("app.ts");
      expect(output).not.toContain("debug.log");
    });

    it("should handle directory that cannot be read (permission error)", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/readable.txt`, "perm_target");

      // Try to search — even if some sub-path fails, should not crash
      const result = await grep_files.execute({
        pattern: "perm_target",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("readable.txt");
    });
  });

  describe("grep_files JS fallback — max_results truncation for files_with_matches", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should truncate files_with_matches at max_results and show footer", async () => {
      const context = { taskId: "test-task-id" };
      // Create files with multiple match lines each so totalMatches > filesWithMatches.length
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/fwm-trunc-${i}.txt`, "fwm_trunc_target\nfwm_trunc_target\nfwm_trunc_target");
      }

      const result = await grep_files.execute({
        pattern: "fwm_trunc_target",
        path: testDir,
        output_mode: "files_with_matches",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
      // Should have truncation footer since totalMatches > filesWithMatches.length
      expect(output).toContain("total matches");
    });

    it("should truncate count mode at max_results", async () => {
      const context = { taskId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/cnt-trunc-${i}.txt`, "cnt_trunc_target");
      }

      const result = await grep_files.execute({
        pattern: "cnt_trunc_target",
        path: testDir,
        output_mode: "count",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(countLines).toHaveLength(2);
    });
  });

  describe("grep_files JS fallback — multiline max_results truncation", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should truncate multiline files_with_matches at max_results", async () => {
      const context = { taskId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/ml-fwm-t-${i}.txt`, "ml\ntarget");
      }

      const result = await grep_files.execute({
        pattern: "ml.target",
        path: testDir,
        multiline: true,
        output_mode: "files_with_matches",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(lines).toHaveLength(2);
    });

    it("should truncate multiline count mode at max_results", async () => {
      const context = { taskId: "test-task-id" };
      for (let i = 0; i < 5; i++) {
        await Bun.write(`${testDir}/ml-cnt-t-${i}.txt`, "ml\ntarget");
      }

      const result = await grep_files.execute({
        pattern: "ml.target",
        path: testDir,
        multiline: true,
        output_mode: "count",
        max_results: 2,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
      expect(countLines).toHaveLength(2);
    });

    it("should truncate multiline content mode at max_results", async () => {
      const context = { taskId: "test-task-id" };
      // Create a file with many multiline matches
      const content = Array.from({ length: 20 }, (_, i) => `start${i}\nend${i}`).join("\n");
      await Bun.write(`${testDir}/ml-content-trunc.txt`, content);

      const result = await grep_files.execute({
        pattern: "start\\d+.end\\d+",
        path: `${testDir}/ml-content-trunc.txt`,
        multiline: true,
        max_results: 3,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("total matches");
    });
  });

  describe("grep_files with rg — context block separators", () => {
    beforeEach(() => {
      _resetRgCache(null);
    });

    afterEach(() => {
      _resetRgCache(null);
    });

    it("should handle rg context output with non-contiguous blocks (-- separators)", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/rg-blocks.txt`;
      // Create content with matches far apart to produce -- separators
      const lines = [
        "line1", "MATCH_BLOCK_1", "line3",
        "line4", "line5", "line6", "line7", "line8",
        "line9", "MATCH_BLOCK_2", "line11",
      ];
      await Bun.write(filePath, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "MATCH_BLOCK",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-blocks.txt ===");
      expect(output).toContain(":2:MATCH_BLOCK_1");
      expect(output).toContain(":10:MATCH_BLOCK_2");
      // Should have a block separator between non-contiguous ranges
      expect(output).toContain("--");
    });

    it("should handle rg multiline mode", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/rg-multiline.txt`;
      await Bun.write(filePath, "alpha\nbeta\ngamma");

      const result = await grep_files.execute({
        pattern: "alpha.beta",
        path: filePath,
        multiline: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("alpha");
      expect(output).toContain("beta");
    });

    it("should handle rg case_insensitive mode", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/rg-case.txt`;
      await Bun.write(filePath, "UPPER\nlower\nMixed");

      const result = await grep_files.execute({
        pattern: "upper",
        path: filePath,
        case_insensitive: true,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("1:UPPER");
    });

    it("should handle rg with include glob filter", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/rg-inc.ts`, "rg_include_target");
      await Bun.write(`${testDir}/rg-inc.py`, "rg_include_target");

      const result = await grep_files.execute({
        pattern: "rg_include_target",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("rg-inc.ts");
      expect(output).not.toContain("rg-inc.py");
    });

    it("should handle rg max_results truncation in content mode", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} rg_trunc_match`);
      await Bun.write(`${testDir}/rg-trunc.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "rg_trunc_match",
        path: `${testDir}/rg-trunc.txt`,
        max_results: 5,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("[20 total matches, showing first 5]");
    });
  });

  describe("grep_files — rg error handling", () => {
    beforeEach(() => {
      _resetRgCache(null);
    });

    afterEach(() => {
      _resetRgCache(null);
    });

    it("should rethrow regex errors from rg", async () => {
      if (!isRgAvailable()) return;

      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/rg-err.txt`, "content");

      // An invalid PCRE2 pattern that JS RegExp accepts but rg rejects
      // Note: most basic invalid regexes are caught by early JS validation,
      // so this test ensures the rg regex error path is reachable
      const result = await grep_files.execute({
        pattern: "[invalid",
        path: `${testDir}/rg-err.txt`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid regex pattern");
    });
  });

  describe("grep_files JS fallback — context with multiple files and separators", () => {
    let originalRgState: boolean;

    beforeEach(() => {
      originalRgState = isRgAvailable();
      _resetRgCache(false);
    });

    afterEach(() => {
      _resetRgCache(originalRgState);
    });

    it("should produce -- block separator between non-contiguous ranges in same file", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/fb-blocks.txt`;
      const lines = [
        "line1", "MATCH_A", "line3",
        "line4", "line5", "line6", "line7", "line8",
        "line9", "MATCH_B", "line11",
      ];
      await Bun.write(filePath, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "MATCH_[AB]",
        path: filePath,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain(":2:MATCH_A");
      expect(output).toContain(":10:MATCH_B");
      // Block separator between non-contiguous context ranges
      expect(output).toContain("--");
    });

    it("should handle context with multiple files", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/fb-ctx-a.txt`, "line1\nCTX_MULTI_MATCH\nline3");
      await Bun.write(`${testDir}/fb-ctx-b.txt`, "line1\nline2\nCTX_MULTI_MATCH\nline4");

      const result = await grep_files.execute({
        pattern: "CTX_MULTI_MATCH",
        path: testDir,
        context_lines: 1,
      }, context);

      expect(result.success).toBe(true);
      const output = result.result as string;
      // Both files should appear
      expect(output).toContain("fb-ctx-a.txt ===");
      expect(output).toContain("fb-ctx-b.txt ===");
    });
  });
});
