/**
 * Tests for memory tools — memory_list, memory_read, memory_write, memory_append.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  memory_list,
  memory_read,
  memory_write,
  memory_patch,
  memory_append,
  extractSummary,
  resolveMemoryPath,
} from "../../../src/agents/tools/builtins/memory-tools.ts";
import { rm, mkdir } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-memory";

describe("memory tools", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(`${testDir}/facts`, { recursive: true });
    await mkdir(`${testDir}/episodes`, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── extractSummary ─────────────────────────────

  describe("extractSummary", () => {
    it("should extract summary from > Summary: line", () => {
      const content = "# Title\n\n> Summary: user name, language\n\n- item\n";
      expect(extractSummary(content)).toBe("user name, language");
    });

    it("should return empty string when no summary line exists", () => {
      expect(extractSummary("# Title\n\n- no summary\n")).toBe("");
    });

    it("should return empty string for empty content", () => {
      expect(extractSummary("")).toBe("");
    });

    it("should extract only the first > Summary: line", () => {
      const content = "> Summary: first\n\n> Summary: second\n";
      expect(extractSummary(content)).toBe("first");
    });

    it("should trim whitespace from extracted summary", () => {
      const content = "> Summary:   spaced out   \n";
      expect(extractSummary(content)).toBe("spaced out");
    });
  });

  // ── resolveMemoryPath ─────────────────────────

  describe("resolveMemoryPath", () => {
    it("should resolve relative path within memory directory", () => {
      const result = resolveMemoryPath("facts/user.md", "/data/memory");
      expect(result).toBe("/data/memory/facts/user.md");
    });

    it("should reject directory traversal with ..", () => {
      expect(() => resolveMemoryPath("../../etc/passwd", "/data/memory")).toThrow(
        "escapes memory directory",
      );
    });

    it("should reject absolute paths outside memory directory", () => {
      expect(() => resolveMemoryPath("/etc/passwd", "/data/memory")).toThrow(
        "escapes memory directory",
      );
    });

    it("should allow path that resolves to memoryDir itself", () => {
      // e.g. resolveMemoryPath(".", "/data/memory") => "/data/memory"
      const result = resolveMemoryPath(".", "/data/memory");
      expect(result).toBe("/data/memory");
    });
  });

  // ── memory_list ─────────────────────────────────

  describe("getMemoryDir (via memory_list)", () => {
    it("should crash when memoryDir is missing from context", async () => {
      const context = { taskId: "t1" } as any;
      await expect(memory_list.execute({}, context)).rejects.toThrow(
        "memoryDir is required but missing",
      );
    });
  });

  describe("memory_list", () => {
    it("should return empty list when no memory files exist", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      expect(result.success).toBe(true);
      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toEqual([]);
    });

    it("should list facts files with empty summary (facts skip summary extraction)", async () => {
      await Bun.write(
        `${testDir}/facts/user.md`,
        "# User Facts\n\n> Summary: user name, language\n\n- Name: Test\n",
      );

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      expect(result.success).toBe(true);
      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.path).toBe("facts/user.md");
      expect(data[0]!.summary).toBe("");
      expect(data[0]!.size).toBeGreaterThan(0);
    });

    it("should list episodes files with file-level summary", async () => {
      await Bun.write(
        `${testDir}/episodes/2026-02.md`,
        "# 2026-02 Episodes\n\n> Summary: logger fix, short ID\n\n## Entry\n- Summary: details\n",
      );

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      expect(result.success).toBe(true);
      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.path).toBe("episodes/2026-02.md");
      expect(data[0]!.summary).toBe("logger fix, short ID");
    });

    it("should return empty summary for facts but summary for episodes", async () => {
      await Bun.write(
        `${testDir}/facts/user.md`,
        "# User\n\n> Summary: user info\n\n- Name: Test\n",
      );
      await Bun.write(
        `${testDir}/episodes/2026-02.md`,
        "# Feb\n\n> Summary: episode stuff\n\n## Entry\n",
      );

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      expect(result.success).toBe(true);
      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toHaveLength(2);

      const facts = data.find(e => e.path.startsWith("facts/"));
      const episodes = data.find(e => e.path.startsWith("episodes/"));
      expect(facts!.summary).toBe("");
      expect(episodes!.summary).toBe("episode stuff");
    });

    it("should return empty summary when > Summary: line is missing", async () => {
      await Bun.write(`${testDir}/facts/bare.md`, "# Bare\n\n- no summary line\n");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data[0]!.summary).toBe("");
    });

    it("should handle non-existent memory directory gracefully", async () => {
      const context = { taskId: "t1", memoryDir: "/tmp/pegasus-nonexistent" };
      const result = await memory_list.execute({}, context);

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    });

    it("should skip non-.md files", async () => {
      await Bun.write(`${testDir}/facts/user.md`, "# User\n\n> Summary: user\n");
      await Bun.write(`${testDir}/facts/notes.txt`, "not markdown");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.path).toBe("facts/user.md");
    });

    it("should skip files in root memory directory (only scans subdirs)", async () => {
      await Bun.write(`${testDir}/root-file.md`, "# Root\n\n> Summary: root\n");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      const data = result.result as Array<{ path: string; summary: string; size: number }>;
      expect(data).toHaveLength(0);
    });

    it("should include timing metadata", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_list.execute({}, context);

      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── memory_read ─────────────────────────────────

  describe("memory_read", () => {
    it("should read a memory file by relative path", async () => {
      const content = "# User Facts\n\n> Summary: user name\n\n- Name: Test\n";
      await Bun.write(`${testDir}/facts/user.md`, content);

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_read.execute({ path: "facts/user.md" }, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe(content);
    });

    it("should fail on non-existent file", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_read.execute({ path: "facts/missing.md" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject directory traversal", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_read.execute({ path: "../../etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes memory directory");
    });

    it("should include timing metadata", async () => {
      await Bun.write(`${testDir}/facts/user.md`, "test");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_read.execute({ path: "facts/user.md" }, context);

      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThan(0);
    });
  });

  // ── memory_write ─────────────────────────────────

  describe("memory_write", () => {
    it("should write a new memory file", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const content = "# User Facts\n\n> Summary: user name\n\n- Name: Test\n";
      const result = await memory_write.execute(
        { path: "facts/user.md", content },
        context,
      );

      expect(result.success).toBe(true);
      const written = await Bun.file(`${testDir}/facts/user.md`).text();
      expect(written).toBe(content);
    });

    it("should overwrite an existing file", async () => {
      await Bun.write(`${testDir}/facts/user.md`, "old content");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_write.execute(
        { path: "facts/user.md", content: "new content" },
        context,
      );

      expect(result.success).toBe(true);
      const written = await Bun.file(`${testDir}/facts/user.md`).text();
      expect(written).toBe("new content");
    });

    it("should create parent directories if needed", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_write.execute(
        { path: "new-category/file.md", content: "hello" },
        context,
      );

      expect(result.success).toBe(true);
      const written = await Bun.file(`${testDir}/new-category/file.md`).text();
      expect(written).toBe("hello");
    });

    it("should reject directory traversal", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_write.execute(
        { path: "../../tmp/evil.md", content: "bad" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes memory directory");
    });

    it("should return written path and size", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_write.execute(
        { path: "facts/user.md", content: "12345" },
        context,
      );

      expect(result.success).toBe(true);
      const data = result.result as { path: string; size: number };
      expect(data.path).toBe("facts/user.md");
      expect(data.size).toBe(5);
    });

    it("rejects write to non-allowed fact file", async () => {
      await mkdir(`${testDir}/facts`, { recursive: true });

      const result = await memory_write.execute(
        { path: "facts/configuration.md", content: "# Config\n> Summary: config stuff" },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("allows write to user.md in facts", async () => {
      await mkdir(`${testDir}/facts`, { recursive: true });

      const result = await memory_write.execute(
        { path: "facts/user.md", content: "# User\n> Summary: test user" },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(true);
    });

    it("allows write to memory.md in facts", async () => {
      await mkdir(`${testDir}/facts`, { recursive: true });

      const result = await memory_write.execute(
        { path: "facts/memory.md", content: "# Memory\n> Summary: learned things" },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(true);
    });

    it("allows write to episodes (no allowlist restriction)", async () => {
      await mkdir(`${testDir}/episodes`, { recursive: true });

      const result = await memory_write.execute(
        { path: "episodes/2026-02.md", content: "# Feb 2026\n> Summary: events" },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(true);
    });

    it("rejects write when facts budget would exceed 15KB", async () => {
      await mkdir(`${testDir}/facts`, { recursive: true });

      // Write a large user.md first (14KB)
      const largeContent = "# User\n> Summary: big\n\n" + "x".repeat(14_000);
      await Bun.write(`${testDir}/facts/user.md`, largeContent);

      // Try to write memory.md that would push total over 15KB
      const result = await memory_write.execute(
        { path: "facts/memory.md", content: "# Memory\n> Summary: test\n\n" + "y".repeat(2_000) },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("15KB");
    });
  });

  // ── memory_patch ─────────────────────────────────

  describe("memory_patch", () => {
    it("should replace a string in a memory file", async () => {
      const content = "# User Facts\n\n> Summary: user name\n\n- Name: Alice\n- Lang: EN\n";
      await Bun.write(`${testDir}/facts/user.md`, content);

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_patch.execute(
        { path: "facts/user.md", old_str: "- Name: Alice", new_str: "- Name: Bob" },
        context,
      );

      expect(result.success).toBe(true);
      const updated = await Bun.file(`${testDir}/facts/user.md`).text();
      expect(updated).toContain("- Name: Bob");
      expect(updated).not.toContain("- Name: Alice");
    });

    it("should fail if string not found", async () => {
      await Bun.write(`${testDir}/facts/user.md`, "# User\n\n- Name: Alice\n");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_patch.execute(
        { path: "facts/user.md", old_str: "- Name: Charlie", new_str: "- Name: Bob" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("String not found");
    });

    it("should fail if string appears multiple times", async () => {
      await Bun.write(`${testDir}/facts/user.md`, "hello world\nhello world\n");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_patch.execute(
        { path: "facts/user.md", old_str: "hello world", new_str: "goodbye" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("multiple times");
    });

    it("should reject directory traversal", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_patch.execute(
        { path: "../../etc/passwd", old_str: "root", new_str: "hacked" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes memory directory");
    });

    it("rejects patch to non-allowed fact file", async () => {
      await mkdir(`${testDir}/facts`, { recursive: true });
      await Bun.write(`${testDir}/facts/config.md`, "# Config\nold text");

      const result = await memory_patch.execute(
        { path: "facts/config.md", old_str: "old text", new_str: "new text" },
        { taskId: "test", memoryDir: testDir },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not allowed");
    });
  });

  // ── memory_append ─────────────────────────────────

  describe("memory_append", () => {
    it("should append an entry to an existing episode file", async () => {
      const existing = "# 2026-02 Episodes\n\n> Summary: old stuff\n\n## Old Entry\n- Summary: old\n";
      await Bun.write(`${testDir}/episodes/2026-02.md`, existing);

      const entry = "\n## New Entry\n- Summary: new thing\n- Date: 2026-02-25\n";
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/2026-02.md", entry },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/episodes/2026-02.md`).text();
      expect(content).toContain("## Old Entry");
      expect(content).toContain("## New Entry");
    });

    it("should create file with entry if it does not exist", async () => {
      const entry = "\n## First Entry\n- Summary: first\n- Date: 2026-02-25\n";
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/2026-03.md", entry },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/episodes/2026-03.md`).text();
      expect(content).toContain("## First Entry");
    });

    it("should reject directory traversal", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "../../tmp/evil.md", entry: "bad" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes memory directory");
    });

    it("should return appended path and total size", async () => {
      await Bun.write(`${testDir}/episodes/test.md`, "existing");

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/test.md", entry: " appended" },
        context,
      );

      expect(result.success).toBe(true);
      const data = result.result as { path: string; size: number };
      expect(data.path).toBe("episodes/test.md");
      expect(data.size).toBe("existing appended".length);
    });

    it("should create parent directories for new paths", async () => {
      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "new-dir/log.md", entry: "first entry" },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/new-dir/log.md`).text();
      expect(content).toBe("first entry");
    });

    it("should update summary line when summary parameter provided", async () => {
      const existing = "# 2026-02 Episodes\n\n> Summary: old stuff\n\n## Old Entry\n- done\n";
      await Bun.write(`${testDir}/episodes/2026-02.md`, existing);

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/2026-02.md", entry: "\n## New Entry\n- new\n", summary: "old stuff, new thing" },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/episodes/2026-02.md`).text();
      expect(content).toContain("> Summary: old stuff, new thing");
      expect(content).not.toContain("> Summary: old stuff\n");
      expect(content).toContain("## New Entry");
    });

    it("should not change summary when summary parameter is omitted", async () => {
      const existing = "# 2026-02 Episodes\n\n> Summary: original\n\n## Entry\n";
      await Bun.write(`${testDir}/episodes/2026-02.md`, existing);

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/2026-02.md", entry: "\n## Another\n" },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/episodes/2026-02.md`).text();
      expect(content).toContain("> Summary: original");
    });

    it("should insert summary after heading when no existing summary line", async () => {
      const existing = "# 2026-03 Episodes\n\n## Entry 1\n- done\n";
      await Bun.write(`${testDir}/episodes/2026-03.md`, existing);

      const context = { taskId: "t1", memoryDir: testDir };
      const result = await memory_append.execute(
        { path: "episodes/2026-03.md", entry: "\n## Entry 2\n- more\n", summary: "entry 1, entry 2" },
        context,
      );

      expect(result.success).toBe(true);
      const content = await Bun.file(`${testDir}/episodes/2026-03.md`).text();
      expect(content).toContain("> Summary: entry 1, entry 2");
      // Summary should appear after the heading
      const headingIdx = content.indexOf("# 2026-03 Episodes");
      const summaryIdx = content.indexOf("> Summary: entry 1, entry 2");
      expect(summaryIdx).toBeGreaterThan(headingIdx);
    });
  });
});
