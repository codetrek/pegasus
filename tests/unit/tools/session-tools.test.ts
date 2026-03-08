import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { session_archive_read } from "@pegasus/agents/tools/builtins/session-tools";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const testDir = "/tmp/pegasus-test-session-tools";
const sessionDir = path.join(testDir, "main");

describe("session_archive_read", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("reads the specified archive file", async () => {
    const archiveContent =
      '{"ts":1,"role":"user","content":"hello"}\n{"ts":2,"role":"assistant","content":"hi"}\n';
    await writeFile(
      path.join(sessionDir, "20260225T143000.jsonl"),
      archiveContent,
    );

    const result = await session_archive_read.execute(
      { file: "20260225T143000.jsonl" },
      { taskId: "main-agent", sessionDir },
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe(archiveContent);
  }, 5_000);

  it("rejects path traversal attempts", async () => {
    const result = await session_archive_read.execute(
      { file: "../../../etc/passwd" },
      { taskId: "main-agent", sessionDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes");
  }, 5_000);

  it("rejects reading current.jsonl", async () => {
    await writeFile(path.join(sessionDir, "current.jsonl"), '{"ts":1}\n');
    const result = await session_archive_read.execute(
      { file: "current.jsonl" },
      { taskId: "main-agent", sessionDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("current");
  }, 5_000);

  it("returns error for non-existent file", async () => {
    const result = await session_archive_read.execute(
      { file: "nonexistent.jsonl" },
      { taskId: "main-agent", sessionDir },
    );
    expect(result.success).toBe(false);
  }, 5_000);

  it("returns error when sessionDir is missing from context", async () => {
    const result = await session_archive_read.execute(
      { file: "archive.jsonl" },
      { taskId: "main-agent" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("sessionDir");
  }, 5_000);
});
