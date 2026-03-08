/**
 * Unit tests for file tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { read_file, write_file, list_files, edit_file, grep_files, glob_files } from "../../../src/agents/tools/builtins/file-tools.ts";
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
});
